import UIKit
import WebKit
import AVFoundation
import CryptoKit
import Network
import ImageIO

/**
 * photobooth4u — iOS / iPadOS Main View Controller
 *
 * Hosts the bundled photobooth HTML inside a full-screen, kiosk-mode WKWebView
 * served from http://localhost:17321/booth (a WebKit Secure Context so built-in
 * camera, UVC capture cards, and same-origin USB DSLR calls all work cleanly).
 */
class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UITextFieldDelegate, WKDownloadDelegate, UIPrintInteractionControllerDelegate {

    // The page size (in points) of the AirPrint job being sent, so the printer's paper can be matched to it.
    private var airPrintPageSize = CGSize(width: 288, height: 432)

    // Files the page asks to download (backups, photos, profile exports): saved to a temporary folder, then handed to the
    // iPad's share sheet (Save to Files, AirDrop, Photos...). Kept here while a download is running.
    private var activeDownloads: [WKDownload] = []
    private var downloadFiles: [ObjectIdentifier: URL] = [:]

    private var webView: WKWebView!
    private var backToBoothBtn: UIButton?
    private var gateContainer: UIView?
    private var gateMessageLabel: UILabel?
    private var codeField: UITextField?
    private var activateBtn: UIButton?
    private var gateReason: String = ""

    private var activePayload: [String: Any]?
    private var checkinTimer: Timer?
    private var updateBusy = false
    private var loadedViaOta = false
    private var boothLoadedOnce = false
    private var pendingReloadOnActive = false
    private var navRetryCount = 0
    private var navRetryWorkItem: DispatchWorkItem?
    private var loadStartedAt: Date?
    private var loadWatchdogWorkItem: DispatchWorkItem?
    private var livenessCheckId = 0
    private var airPrintBusy = false
    private var airPrintQueue: [(jobName: String, ptW: Double, ptH: Double, pdfUrl: URL)] = []
    // Photo saves run here, one at a time and off the main thread, so the camera picture and the screen keep moving.
    private let saveQueue = DispatchQueue(label: "com.photobooth4u.save", qos: .userInitiated)
    // Print jobs (AirPrint PDF rendering, IPP, ESC/P-R) run serially off the main thread so concurrent jobs never spike RAM.
    private let printQueue = DispatchQueue(label: "com.photobooth4u.print", qos: .userInitiated)
    // 3.5 GiB threshold: catches 2 GB and 3 GB iPads (e.g. iPad 7th/8th/9th gen) without touching 4 GB+ iPad Air/Pro/A16.
    private var isLowRamDevice: Bool {
        return ProcessInfo.processInfo.physicalMemory <= 3_758_096_384
    }
    private let otaHashKey = "pb4u_ota_hash"
    private let otaBundledHashKey = "pb4u_ota_bundled_hash"
    private let airprintUrlKey = "pb4u_airprint_url"
    private let airprintNameKey = "pb4u_airprint_name"
    private let tcpPrintersKey = "pb4u_tcp_printers"
    private var netAddNote = ""
    private let netAddNoteLock = NSLock()

    override var prefersStatusBarHidden: Bool { return true }
    override var prefersHomeIndicatorAutoHidden: Bool { return true }

    override func didReceiveMemoryWarning() {
        super.didReceiveMemoryWarning()
        NativeCameraBridge.shared.clearMemoryCaches()
        URLCache.shared.removeAllCachedResponses()
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("try{window.dispatchEvent(new Event('pb-memory-pressure'));}catch(e){}", completionHandler: nil)
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.92, alpha: 1.0) // #F5F1EA

        // 1. Start local servers & USB camera browser
        IccCameraHelper.shared.start()
        VoiceBridge.shared.warmUp()      // read the voice list and load the speech engine now, not during the first countdown
        PBLocal.shared.requestPhotosAccess()      // ask about saving to Photos now, not over the camera during the first photo
        _ = LocalShareServer.shared.start()

        // 2. Setup WKWebView
        setupWebView()

        // 3. Push network & LAN state asynchronously to JS (avoids synchronous prompt IPC)
        PBLocal.shared.onNetworkUpdate = { [weak self] online, lan, loc in
            self?.pushNetworkAddressesToJs(online: online, lanBase: lan, localBase: loc)
        }
        PBLocal.shared.onOnlineChange = { [weak self] online in
            let flag = online ? "true" : "false"
            let ev = online ? "online" : "offline"
            self?.webView?.evaluateJavaScript("window.__pbIosOnline=\(flag);window.dispatchEvent(new Event('\(ev)'));", completionHandler: nil)
        }

        // 4. Request native camera/mic permissions upfront, then boot UI after camera grant settles
        requestMediaPermissionsAndBoot()

        // 5. Periodic 10-minute background licence check-in when online
        checkinTimer = Timer.scheduledTimer(withTimeInterval: 600.0, repeats: true) { [weak self] _ in
            guard PBLocal.shared.isOnline() else { return }
            AppLicence.shared.checkin(force: false) { result in
                if result == "revoked" {
                    self?.bootWithLicence()
                } else if result == "ok" {
                    self?.pushAuthAndSyncEvent(eventName: "online")
                }
            }
        }

        // 6. Trigger seamless cloud sync and WebView liveness verification whenever the iPad wakes or returns to the app
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    deinit {
        checkinTimer?.invalidate()
        navRetryWorkItem?.cancel()
        loadWatchdogWorkItem?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    private func jsStringLiteral(_ str: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [str], options: []),
           let arr = String(data: data, encoding: .utf8), arr.count >= 2 {
            let inner = String(arr.dropFirst().dropLast())
            return inner
                .replacingOccurrences(of: "</", with: "<\\/")
                .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
                .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        }
        return "\"\""
    }

    private func pushNetworkAddressesToJs(online: Bool, lanBase: String, localBase: String) {
        DispatchQueue.main.async { [weak self] in
            guard let wv = self?.webView else { return }
            let flag = online ? "true" : "false"
            let lanLit = self?.jsStringLiteral(lanBase) ?? "\"\""
            let locLit = self?.jsStringLiteral(localBase) ?? "\"\""
            wv.evaluateJavaScript("try{window.__pbIosOnline=\(flag);window.__pbIosLanBase=\(lanLit);window.__pbIosLocalBase=\(locLit);window.dispatchEvent(new Event('pb-lan-change'));}catch(e){}", completionHandler: nil)
        }
    }

    private func pushNetPrintersState() {
        let jsonStrVal = tcpPrintersListJson()
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let wv = self.webView else { return }
            let lit = self.jsStringLiteral(jsonStrVal)
            wv.evaluateJavaScript("try{window.__pbIosNetList=\(lit);}catch(e){}", completionHandler: nil)
        }
    }

    private func pushCachedBridgeState() {
        let apLit = jsStringLiteral(savedAirPrintJson())
        let netLit = jsStringLiteral(tcpPrintersListJson())
        webView?.evaluateJavaScript("try{window.__pbIosAirPrint=\(apLit);window.__pbIosNetList=\(netLit);}catch(e){}", completionHandler: nil)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            let online = PBLocal.shared.isOnline()
            let lan = PBLocal.shared.lanBase()
            let loc = PBLocal.shared.localBase()
            let enVoices = VoiceBridge.shared.voicesJson(lang: "en")
            let filVoices = VoiceBridge.shared.voicesJson(lang: "fil")
            DispatchQueue.main.async { [weak self] in
                guard let self = self, let wv = self.webView else { return }
                let flag = online ? "true" : "false"
                let lanLit = self.jsStringLiteral(lan)
                let locLit = self.jsStringLiteral(loc)
                let enLit = self.jsStringLiteral(enVoices)
                let filLit = self.jsStringLiteral(filVoices)
                wv.evaluateJavaScript("try{window.__pbIosOnline=\(flag);window.__pbIosLanBase=\(lanLit);window.__pbIosLocalBase=\(locLit);window.__pbIosVoices={en:\(enLit),fil:\(filLit)};window.dispatchEvent(new Event('pb-lan-change'));}catch(e){}", completionHandler: nil)
            }
        }
    }

    private func hasSpin360Entitlement() -> Bool {
        let st = AppLicence.shared.status()
        guard st.ok,
              let feat = st.payload?["feat"] as? [String: Any],
              let ex = feat["extras"] as? [String: Any] else { return false }
        return (ex["spin360"] as? NSNumber)?.boolValue ?? false
    }

    private func buildExtrasJsObject(from feat: [String: Any]) -> String {
        let exObj = feat["extras"] as? [String: Any] ?? [:]
        return ["vintage", "roving", "flipbook", "video", "spin360"].map { key in
            let def = (key != "spin360")
            let on = (exObj[key] as? NSNumber)?.boolValue ?? def
            return "\(key):\(on ? "true" : "false")"
        }.joined(separator: ",")
    }

    private func pushAuthAndSyncEvent(eventName: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let wv = self.webView else { return }
            let online = PBLocal.shared.isOnline()
            let flag = online ? "true" : "false"
            let st = AppLicence.shared.status()
            let feat = (st.payload?["feat"] as? [String: Any]) ?? [:]
            let arrangeOn = (feat["arrangePrintOpt"] as? NSNumber)?.boolValue ?? false
            let extrasJs = self.buildExtrasJsObject(from: feat)
            var authJs = "window.__PB=window.__PB||{};window.__PB.arrangePrintOpt=\(arrangeOn ? "true" : "false");window.__PB.extras={\(extrasJs)};"
            if let lic = AppLicence.shared.currentLicenceString(), !lic.isEmpty,
               let data = try? JSONSerialization.data(withJSONObject: ["licence": lic, "mid": AppLicence.shared.machineId()], options: []),
               let json = String(data: data, encoding: .utf8) {
                authJs += "window.__PB.appAuth=\(json);"
            }
            let evJs = "window.dispatchEvent(new Event('pb-arrange-print-change'));window.dispatchEvent(new Event('pb-extras-change'));" + (online ? "window.dispatchEvent(new Event('\(eventName)'));" : "")
            wv.evaluateJavaScript("try{window.__pbIosOnline=\(flag);\(authJs)\(evJs)}catch(e){}", completionHandler: nil)
        }
    }

    @objc private func handleAppDidBecomeActive() {
        pushCachedBridgeState()
        pushAuthAndSyncEvent(eventName: "pb-app-resume")
        verifyWebViewAliveOnResume()
    }

    private func verifyWebViewAliveOnResume() {
        guard gateContainer == nil, boothLoadedOnce, let wv = webView else { return }
        if pendingReloadOnActive {
            pendingReloadOnActive = false
            IccCameraHelper.shared.ensureListening(forceRestart: true)
            LocalShareServer.shared.ensureListening(forceRestart: false)
            loadBooth()
            return
        }
        if wv.isLoading {
            if let started = loadStartedAt, Date().timeIntervalSince(started) > 12.0 {
                wv.stopLoading()
                IccCameraHelper.shared.ensureListening(forceRestart: true)
                LocalShareServer.shared.ensureListening(forceRestart: false)
                loadBooth()
            }
            return
        }
        if wv.url == nil {
            IccCameraHelper.shared.ensureListening(forceRestart: true)
            LocalShareServer.shared.ensureListening(forceRestart: false)
            loadBooth()
            return
        }
        guard presentedViewController == nil else { return }
        livenessCheckId &+= 1
        let checkId = livenessCheckId
        var answered = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) { [weak self] in
            guard let self = self, !answered, self.livenessCheckId == checkId else { return }
            guard self.gateContainer == nil, self.presentedViewController == nil, UIApplication.shared.applicationState == .active, self.webView?.isLoading == false else { return }
            IccCameraHelper.shared.ensureListening(forceRestart: true)
            LocalShareServer.shared.ensureListening(forceRestart: false)
            self.loadBooth()
        }
        wv.evaluateJavaScript("document.readyState") { [weak self] val, err in
            answered = true
            guard let self = self, self.livenessCheckId == checkId else { return }
            if err != nil || (val as? String) == nil {
                guard self.gateContainer == nil, self.presentedViewController == nil, UIApplication.shared.applicationState == .active, self.webView?.isLoading == false else { return }
                IccCameraHelper.shared.ensureListening(forceRestart: true)
                LocalShareServer.shared.ensureListening(forceRestart: false)
                self.loadBooth()
            }
        }
    }

    private func requestMediaPermissionsAndBoot() {
        let askAudioThenBoot = { [weak self] in
            guard let self = self else { return }
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
                    DispatchQueue.main.async {
                        self?.bootWithLicence()
                    }
                }
            } else {
                self.bootWithLicence()
            }
        }
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { _ in
                DispatchQueue.main.async {
                    askAudioThenBoot()
                }
            }
        } else {
            askAudioThenBoot()
        }
    }

    // MARK: - WebView Setup & JS Bridges

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()

        userContent.add(self, name: "pbVoiceSpeak")
        userContent.add(self, name: "pbVoiceStop")
        userContent.add(self, name: "pbGuestViewSet")
        userContent.add(self, name: "pbPrintWebView")
        userContent.add(self, name: "pbUpdateCheck")
        userContent.add(self, name: "pbUpdateStart")
        userContent.add(self, name: "pbPickAirPrint")
        userContent.add(self, name: "pbClearAirPrint")
        userContent.add(self, name: "pbPrintAirPrint")
        userContent.add(self, name: "pbPrintRawTcp")
        userContent.add(self, name: "pbPrintIpp")
        userContent.add(self, name: "pbPrintEscpr")
        userContent.add(self, name: "pbBt")
        userContent.add(self, name: "pbSave")
        userContent.add(self, name: "pbCam")
        userContent.add(self, name: "pbSpinArm")

        let bridgeJs = """
        (function(){
          if (window.__pbIosBridgeReady) return;
          window.__pbIosBridgeReady = true;

          // Saving a photo sends the whole picture to the app. The blocking calls below froze the iPad until the file was
          // written, so the page uses these asynchronous ones (the app writes the file in the background and answers later).
          var savePend = {}, saveSeq = 0;
          function callSave(op, a, b) {
            return new Promise(function(resolve) {
              var id = ++saveSeq;
              var timer = setTimeout(function() {
                if (savePend[id]) {
                  delete savePend[id];
                  resolve('{"ok":false,"error":"Save timed out."}');
                }
              }, 30000);
              savePend[id] = function(json) { clearTimeout(timer); resolve(json); };
              try {
                window.webkit.messageHandlers.pbSave.postMessage({ id: id, op: op, a: a, b: b });
              } catch (e) {
                clearTimeout(timer);
                delete savePend[id];
                var res = op === 'drive'
                  ? prompt('__PBLocal_drive_sync__', a)
                  : prompt('__PBLocal_saveImage_sync__', JSON.stringify({ fileName: a, base64: b }));
                resolve(res || '{}');
              }
            });
          }
          window.__pbSaveResolve = function(id, json) { var f = savePend[id]; if (f) { delete savePend[id]; f(json); } };

          window.__PBLocal = {
            driveAsync: function(body) { return callSave('drive', String(body || '{}'), ''); },
            saveImageAsync: function(fileName, base64) { return callSave('saveImage', String(fileName || ''), String(base64 || '')); },
            drive: function(body) {
              var res = prompt('__PBLocal_drive_sync__', String(body || '{}'));
              return res || '{}';
            },
            lanBase: function() {
              if (typeof window.__pbIosLanBase === 'string') return window.__pbIosLanBase;
              var res = prompt('__PBLocal_lanBase_sync__', '') || '';
              window.__pbIosLanBase = res;
              return res;
            },
            localBase: function() {
              if (typeof window.__pbIosLocalBase === 'string') return window.__pbIosLocalBase;
              var res = prompt('__PBLocal_localBase_sync__', '') || '';
              window.__pbIosLocalBase = res;
              return res;
            },
            photosPath: function() { return 'Files › On My iPad › photobooth4u'; },
            saveImage: function(fileName, base64) {
              var payload = JSON.stringify({ fileName: String(fileName || ''), base64: String(base64 || '') });
              var res = prompt('__PBLocal_saveImage_sync__', payload);
              return res || '{"ok":false}';
            },
            guestViewSet: function(mode) {
              try { window.webkit.messageHandlers.pbGuestViewSet.postMessage(String(mode || 'all')); } catch (e) {}
            },
            openSpinArm: function(opts) {
              try { window.webkit.messageHandlers.pbSpinArm.postMessage(opts || {}); } catch (e) {}
            },
            isOnline: function() {
              if (typeof window.__pbIosOnline === 'boolean') return window.__pbIosOnline;
              var v = (prompt('__PBLocal_isOnline_sync__', '') === '1');
              window.__pbIosOnline = v;
              return v;
            }
          };

          window.__PBVoice = {
            voices: function(lang) {
              var k = /^(fil|tl)/i.test(String(lang || 'en')) ? 'fil' : 'en';
              if (window.__pbIosVoices && typeof window.__pbIosVoices[k] === 'string') return window.__pbIosVoices[k];
              var res = prompt('__PBVoice_voices_sync__', String(lang || 'en')) || '[]';
              window.__pbIosVoices = window.__pbIosVoices || {};
              window.__pbIosVoices[k] = res;
              return res;
            },
            speak: function(text, voiceName, volume) {
              try {
                window.webkit.messageHandlers.pbVoiceSpeak.postMessage({
                  text: String(text || ''),
                  voice: String(voiceName || ''),
                  volume: (typeof volume === 'number') ? volume : 1.0
                });
                return true;
              } catch (e) { return false; }
            },
            stop: function() {
              try { window.webkit.messageHandlers.pbVoiceStop.postMessage({}); } catch (e) {}
            }
          };

          window.__PBPrint = {
            print: function(jobName, widthMm, heightMm, pagesJson) {
              try {
                window.webkit.messageHandlers.pbPrintAirPrint.postMessage({
                  jobName: String(jobName || 'Photobooth'),
                  widthMm: Number(widthMm) || 101.6,
                  heightMm: Number(heightMm) || 152.4,
                  pagesJson: String(pagesJson || '[]')
                });
                return '{"ok":true}';
              } catch (e) {
                var payload = JSON.stringify({
                  jobName: String(jobName || 'Photobooth'),
                  widthMm: Number(widthMm) || 101.6,
                  heightMm: Number(heightMm) || 152.4,
                  pagesJson: String(pagesJson || '[]')
                });
                var res = prompt('__PBPrint_sync__', payload);
                return res || '{"ok":false,"error":"Print failed"}';
              }
            },
            pickAirPrint: function() {
              try { window.webkit.messageHandlers.pbPickAirPrint.postMessage({}); } catch (e) {}
            },
            clearAirPrint: function() {
              try { window.webkit.messageHandlers.pbClearAirPrint.postMessage({}); } catch (e) {}
            },
            savedAirPrint: function() {
              if (typeof window.__pbIosAirPrint === 'string') return window.__pbIosAirPrint;
              var res = prompt('__PBPrint_saved_sync__', '') || '{}';
              window.__pbIosAirPrint = res;
              return res;
            }
          };

          window.__PBNet = {
            list: function() {
              if (typeof window.__pbIosNetList === 'string') return window.__pbIosNetList;
              var res = prompt('__PBNet_list_sync__', '') || '{"printers":[],"scanning":false}';
              window.__pbIosNetList = res;
              return res;
            },
            scan: function() {},
            addByIp: function(ip) {
              var res = prompt('__PBNet_addByIp_sync__', String(ip || ''));
              delete window.__pbIosNetList;
              return res || 'Invalid IP';
            },
            forgetIp: function(ip) {
              try { prompt('__PBNet_forget_sync__', String(ip || '')); } catch (e) {}
              delete window.__pbIosNetList;
            },
            printRaw: function(jobId, ip, b64) {
              try {
                window.webkit.messageHandlers.pbPrintRawTcp.postMessage({
                  job: String(jobId || ''),
                  ip: String(ip || ''),
                  b64: String(b64 || ''),
                  paced: false
                });
              } catch (e) {}
            },
            printRawPaced: function(jobId, ip, b64) {
              try {
                window.webkit.messageHandlers.pbPrintRawTcp.postMessage({
                  job: String(jobId || ''),
                  ip: String(ip || ''),
                  b64: String(b64 || ''),
                  paced: true
                });
              } catch (e) {}
            },
            // Epson L-series ESC/P-R (LPD :515 / Raw :9100), including L8050 Wi-Fi Direct (192.168.223.1).
            supportsL8050HiRes: function() { return true; },
            printEscpr: function(jobId, ip, widthMm, heightMm, copies, pagesJson, optionsJson) {
              try {
                window.webkit.messageHandlers.pbPrintEscpr.postMessage({
                  job: String(jobId || ''),
                  ip: String(ip || ''),
                  widthMm: Number(widthMm) || 0,
                  heightMm: Number(heightMm) || 0,
                  copies: Number(copies) || 1,
                  pagesJson: String(pagesJson || '[]'),
                  optionsJson: String(optionsJson || '{}')
                });
              } catch (e) {}
            },
            printIpp: function(jobId, ip, widthMm, heightMm, copies, pagesJson, optionsJson) {
              try {
                window.webkit.messageHandlers.pbPrintIpp.postMessage({
                  job: String(jobId || ''),
                  ip: String(ip || ''),
                  widthMm: Number(widthMm) || 0,
                  heightMm: Number(heightMm) || 0,
                  copies: Number(copies) || 1,
                  pagesJson: String(pagesJson || '[]'),
                  optionsJson: String(optionsJson || '{}')
                });
              } catch (e) {}
            }
          };

          window.print = function() {
            try { window.webkit.messageHandlers.pbPrintWebView.postMessage({}); } catch (e) {}
          };

          window.__PBUpdate = {
            version: function() { return window.__pbIosAppVer || '1.1.34'; },
            check: function() {
              try { window.webkit.messageHandlers.pbUpdateCheck.postMessage({}); } catch (e) {}
            },
            start: function() {
              try { window.webkit.messageHandlers.pbUpdateStart.postMessage({}); } catch (e) {}
            }
          };

          // Bluetooth receipt printers (Bluetooth LE only on an iPad). Same calls as the Android app's __BTBridge,
          // but every call is an asynchronous message to the app, so the camera picture never waits for the printer.
          (function() {
            var pend = {}, seq = 0;
            var st = \(BtPrinterBridge.shared.initialStateJson());
            function post(op, args, id) {
              try { window.webkit.messageHandlers.pbBt.postMessage({ id: id || 0, op: op, args: args || {} }); return true; } catch (e) { return false; }
            }
            function call(op, args) {
              return new Promise(function(resolve) {
                var id = ++seq;
                pend[id] = resolve;
                if (!post(op, args, id)) { delete pend[id]; resolve(JSON.stringify({ ok: false, error: 'Bluetooth is not available here.' })); }
              });
            }
            window.__pbBtResolve = function(id, json) { var f = pend[id]; if (f) { delete pend[id]; f(json); } };
            window.__pbBtState = function(s) { if (s) st = s; };
            window.__BTBridge = {
              isAvailable: function() { return true; },
              isEnabled: function() { return st.on !== false; },
              openBluetoothSettings: function() { post('settings'); return true; },
              listDevices: function() { return '[]'; },
              connect: function() { return call('connect'); },
              connectSaved: function() {
                if (!st.saved || !st.saved.address) return JSON.stringify({ ok: false, none: true });
                if (st.connected) return JSON.stringify({ ok: true, connected: true, name: st.name || '', address: st.saved.address, proto: st.proto || '' });
                post('connectSaved');
                return JSON.stringify({ ok: true, started: true });
              },
              savedPrinter: function() { var s = st.saved || {}; return JSON.stringify({ address: s.address || '', name: s.name || '', connected: !!st.connected }); },
              isConnected: function() { return !!st.connected; },
              getConnectedDeviceName: function() { return st.connected ? (st.name || '') : null; },
              write: function(b64) { return call('write', { b64: String(b64 || '') }); },
              writePaced: function(b64, chunk, delay) { return call('writePaced', { b64: String(b64 || ''), chunk: Number(chunk) || 100, delay: Number(delay) || 0 }); },
              release: function() { st.connected = false; post('release'); return JSON.stringify({ ok: true }); },
              disconnect: function() { st.connected = false; post('disconnect'); return JSON.stringify({ ok: true }); }
            };
          })();

          // Native AVFoundation camera (zero-lag AVCaptureVideoPreviewLayer + AVCapturePhotoOutput behind WKWebView)
          (function() {
            var camPend = {}, camSeq = 0;
            function callCam(op, args) {
              return new Promise(function(resolve) {
                var id = ++camSeq;
                var ms = (op === 'stopVideo') ? 25000 : 15000;
                var timer = setTimeout(function() {
                  if (camPend[id]) {
                    delete camPend[id];
                    resolve({ ok: false, name: 'TimeoutError', error: 'Camera did not respond in time.' });
                  }
                }, ms);
                camPend[id] = function(obj) { clearTimeout(timer); resolve(obj || { ok: false }); };
                try {
                  window.webkit.messageHandlers.pbCam.postMessage({ id: id, op: op, args: args || {} });
                } catch (e) {
                  clearTimeout(timer);
                  delete camPend[id];
                  resolve({ ok: false, error: 'Camera bridge unavailable' });
                }
              });
            }
            window.__pbCamResolve = function(id, obj) {
              var f = camPend[id];
              if (f) { delete camPend[id]; f(obj || { ok: false }); }
            };
            window.__PBCam = {
              list: function() { return callCam('list'); },
              open: function(deviceId, preset) { return callCam('open', { deviceId: String(deviceId || ''), preset: String(preset || 'auto') }); },
              stop: function() { return callCam('stop'); },
              capture: function() { return callCam('capture'); },
              prepareAudio: function() { return callCam('prepareAudio'); },
              releaseAudio: function() { return callCam('releaseAudio'); },
              startVideo: function(opts) { return callCam('startVideo', opts || {}); },
              stopVideo: function() { return callCam('stopVideo'); },
              layout: function(opts) {
                try { window.webkit.messageHandlers.pbCam.postMessage({ id: 0, op: 'layout', args: opts || {} }); } catch (e) {}
              },
              setFilter: function(filterKey, softSkin) {
                try { window.webkit.messageHandlers.pbCam.postMessage({ id: 0, op: 'filter', args: { filter: String(filterKey || 'none'), softSkin: !!softSkin } }); } catch (e) {}
              },
              setCustomLut: function(opts) {
                try { window.webkit.messageHandlers.pbCam.postMessage({ id: 0, op: 'customLut', args: opts || {} }); } catch (e) {}
              }
            };
          })();

          try {
            Object.defineProperty(Navigator.prototype, 'onLine', {
              get: function() { return window.__PBLocal ? window.__PBLocal.isOnline() : true; },
              configurable: true
            });
          } catch (e) {}
        })();
        """

        let script = WKUserScript(source: bridgeJs, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        userContent.addUserScript(script)
        config.userContentController = userContent
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = false
        config.allowsAirPlayForMediaPlayback = false
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.customUserAgent = (webView.value(forKey: "userAgent") as? String ?? "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)") + " PB4uIOS/\(AppLicence.shared.appVersion())"
        webView.navigationDelegate = self
        webView.uiDelegate = self
        BtPrinterBridge.shared.evaluate = { [weak self] js in self?.webView?.evaluateJavaScript(js, completionHandler: nil) }
        BtPrinterBridge.shared.presenter = { [weak self] in self?.presentedViewController ?? self }
        // The setup pages (Design, Layout, Text...) are taller than the screen and scroll as a normal web page, so scrolling
        // must stay on. Only the rubber-band bounce is off, and taps are not held back waiting for a possible scroll.
        webView.scrollView.isScrollEnabled = true
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.delaysContentTouches = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        NativeCameraBridge.shared.hostContainerView = view
        NativeCameraBridge.shared.onDeviceEvent = { [weak self] kind, devId, label, isExternal in
            guard let self = self, let wv = self.webView else { return }
            let obj: [String: Any] = [
                "type": kind,
                "id": devId,
                "label": label,
                "isExternal": isExternal
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
                  let json = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                wv.evaluateJavaScript("window.__pbCamEvent&&window.__pbCamEvent(\(json));", completionHandler: nil)
            }
        }
        view.addSubview(NativeCameraBridge.shared.previewView)
        view.addSubview(webView)

        setupBackToBoothButton()
    }

    private func setupBackToBoothButton() {
        let btn = UIButton(type: .system)
        btn.setTitle("← Back to Booth", for: .normal)
        btn.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .bold)
        btn.backgroundColor = UIColor(red: 0.11, green: 0.10, blue: 0.12, alpha: 0.9)
        btn.setTitleColor(.white, for: .normal)
        btn.layer.cornerRadius = 18
        btn.contentEdgeInsets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.isHidden = true
        btn.addTarget(self, action: #selector(didTapBackToBooth), for: .touchUpInside)
        view.addSubview(btn)

        NSLayoutConstraint.activate([
            btn.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            btn.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 14)
        ])
        self.backToBoothBtn = btn
    }

    @objc private func didTapBackToBooth() {
        backToBoothBtn?.isHidden = true
        webView.scrollView.isScrollEnabled = true
        loadBooth()
    }

    // MARK: - Licence & Booth Loading

    private func bootWithLicence() {
        let st = AppLicence.shared.status()
        if st.ok {
            activePayload = st.payload
            loadBooth()
        } else {
            activePayload = nil
            showActivationScreen(st: st)
        }
    }

    private func jsonStr(_ v: String) -> String {
        let escaped = v
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "")
        return "'\(escaped)'"
    }

    private func buildPbConfigScript() -> String {
        let p = activePayload ?? [:]
        let feat = p["feat"] as? [String: Any] ?? [:]
        let printObj = feat["print"] as? [String: Any] ?? [:]
        let printEnabled = (printObj["enabled"] as? NSNumber)?.boolValue ?? true
        let sizesRaw = (printObj["sizes"] as? [String]) ?? ["4x6", "2x6", "selphy_postcard", "a4", "receipt80", "receipt58"]
        let sizesJs = sizesRaw.map { jsonStr($0) }.joined(separator: ",")

        let gifOpt = (feat["gifOpt"] as? NSNumber)?.boolValue ?? true
        let retakeOpt = (feat["retakeOpt"] as? NSNumber)?.boolValue ?? true
        let lockOpt = (feat["lockOpt"] as? NSNumber)?.boolValue ?? true
        let typesOpt = (feat["typesOpt"] as? NSNumber)?.boolValue ?? false
        let arrangePrintOpt = (feat["arrangePrintOpt"] as? NSNumber)?.boolValue ?? false
        let debugOpt = (feat["debugOpt"] as? NSNumber)?.boolValue ?? false
        let payOpt = (feat["vouchers"] as? NSNumber)?.boolValue ?? false
        let traditional = (feat["traditional"] as? NSNumber)?.boolValue ?? true
        let orientation = (feat["orientation"] as? String) ?? "either"

        let extrasJs = buildExtrasJsObject(from: feat)

        let expMs = (p["exp"] as? NSNumber)?.int64Value ?? 253402300799000
        let lifetime = (p["lifetime"] as? NSNumber)?.boolValue ?? false
        let deviceNo = (feat["deviceNo"] as? NSNumber)?.intValue ?? 1
        let multiDevice = (feat["multiDevice"] as? NSNumber)?.boolValue ?? false
        let isTrial = (feat["trial"] as? NSNumber)?.boolValue ?? false
        let watermark = isTrial && ((feat["watermark"] as? NSNumber)?.boolValue ?? true)
        let folderKey = (feat["folderKey"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let folderPrefix = (feat["folderPrefix"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        let licStr = AppLicence.shared.currentLicenceString() ?? ""
        let midStr = AppLicence.shared.machineId()

        return """
        <script>
        window.__PB=window.__PB||{};
        window.__PB.desktop={v:\(jsonStr(AppLicence.shared.appVersion())),os:'ios'};
        window.__PB.appAuth={licence:\(jsonStr(licStr)),mid:\(jsonStr(midStr))};
        window.__PB.ios=true;
        window.__PB.iosLowRam=\(isLowRamDevice ? "true" : "false");
        window.__PB.offline=true;
        window.__PB.type='rental';
        window.__PB.gifOpt=\(gifOpt ? "true" : "false");
        window.__PB.extras={\(extrasJs)};
        window.__PB.retakeOpt=\(retakeOpt ? "true" : "false");
        window.__PB.lockOpt=\(lockOpt ? "true" : "false");
        window.__PB.typesOpt=\(typesOpt ? "true" : "false");
        window.__PB.arrangePrintOpt=\(arrangePrintOpt ? "true" : "false");
        window.__PB.debugOpt=\(debugOpt ? "true" : "false");
        window.__PB.payOpt=\(payOpt ? "true" : "false");
        window.__PB.traditional=\(traditional ? "true" : "false");
        window.__PB.orientation=\(jsonStr(orientation));
        window.__PB.folderKey=\(jsonStr(folderKey));
        window.__PB.folderPrefix=\(jsonStr(folderPrefix));
        window.__PB.lockFolder=false;
        window.__PB.lifetime=\(lifetime ? "true" : "false");
        window.__PB.deviceNo=\(deviceNo);
        window.__PB.multiDevice=\(multiDevice ? "true" : "false");
        window.__PB.watermark=\(watermark ? "true" : "false");
        window.__PB.exp=\(expMs);
        window.__pbIosOnline=\(PBLocal.shared.isOnline() ? "true" : "false");
        window.__pbIosLanBase=\(jsStringLiteral(PBLocal.shared.lanBase()));
        window.__pbIosLocalBase=\(jsStringLiteral(PBLocal.shared.localBase()));
        window.__pbIosAirPrint=\(jsStringLiteral(savedAirPrintJson()));
        window.__pbIosNetList=\(jsStringLiteral(tcpPrintersListJson()));
        window.__pbIosAppVer=\(jsonStr(AppLicence.shared.appVersion()));
        window.__PB.print={enabled:\(printEnabled ? "true" : "false"),sizes:[\(sizesJs)]};
        </script>
        """
    }

    private var otaFileUrl: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("booth-ota.html")
    }

    private func sha256Prefix16(_ data: Data) -> String {
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16).lowercased()
    }

    private func readBundleBooth() -> (raw: String, hash: String)? {
        guard let htmlPath = Bundle.main.path(forResource: "booth", ofType: "html"),
              let raw = try? String(contentsOfFile: htmlPath, encoding: .utf8),
              let data = raw.data(using: .utf8) else {
            return nil
        }
        return (raw, sha256Prefix16(data))
    }

    private func activeBoothSource() -> (raw: String, hash: String, bundleHash: String, isOta: Bool)? {
        guard let bundled = readBundleBooth() else { return nil }
        let defaults = UserDefaults.standard
        let savedBundledHash = defaults.string(forKey: otaBundledHashKey) ?? ""
        if savedBundledHash == bundled.hash,
           let otaData = try? Data(contentsOf: otaFileUrl),
           let otaRaw = String(data: otaData, encoding: .utf8),
           otaRaw.contains("</body>"),
           otaRaw.contains("window.__PB") {
            return (otaRaw, sha256Prefix16(otaData), bundled.hash, true)
        }
        clearOtaCache()
        return (bundled.raw, bundled.hash, bundled.hash, false)
    }

    private func clearOtaCache() {
        let defaults = UserDefaults.standard
        if FileManager.default.fileExists(atPath: otaFileUrl.path) {
            try? FileManager.default.removeItem(at: otaFileUrl)
        }
        defaults.removeObject(forKey: otaHashKey)
        defaults.removeObject(forKey: otaBundledHashKey)
    }

    private func loadBooth() {
        navRetryWorkItem?.cancel()
        navRetryWorkItem = nil
        loadWatchdogWorkItem?.cancel()
        loadWatchdogWorkItem = nil
        gateContainer?.removeFromSuperview()
        gateContainer = nil

        guard let src = activeBoothSource() else {
            let errSt = AppLicence.Status(ok: false, reason: "none", message: "Missing booth.html in app bundle.", payload: nil, warn: "")
            showActivationScreen(st: errSt)
            return
        }
        loadedViaOta = src.isOta
        boothLoadedOnce = true
        pendingReloadOnActive = false

        NativeCameraBridge.shared.resetForPageReload()
        IccCameraHelper.shared.ensureListening(forceRestart: false)
        LocalShareServer.shared.ensureListening(forceRestart: false)

        let pbConfig = buildPbConfigScript()
        let injected: String
        if let headRange = src.raw.range(of: "</head>", options: .caseInsensitive) {
            injected = src.raw.replacingCharacters(in: headRange, with: "\(pbConfig)\n</head>")
        } else {
            injected = pbConfig + src.raw
        }

        IccCameraHelper.shared.setBoothHtml(injected)
        if let url = URL(string: "http://localhost:\(IccCameraHelper.port)/booth") {
            loadStartedAt = Date()
            let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15.0)
            webView.load(req)
            let watch = DispatchWorkItem { [weak self] in
                guard let self = self, self.gateContainer == nil else { return }
                guard self.webView?.isLoading == true else { return }
                if UIApplication.shared.applicationState == .background {
                    self.pendingReloadOnActive = true
                    return
                }
                guard self.navRetryCount < 5 else { return }
                self.navRetryCount += 1
                self.webView?.stopLoading()
                IccCameraHelper.shared.ensureListening(forceRestart: true)
                LocalShareServer.shared.ensureListening(forceRestart: false)
                self.loadBooth()
            }
            loadWatchdogWorkItem = watch
            DispatchQueue.main.asyncAfter(deadline: .now() + 15.0, execute: watch)
        }
    }

    private func isVersionNewer(_ remote: String, than local: String) -> Bool {
        let a = remote.split(separator: ".").map { Int($0) ?? 0 }
        let b = local.split(separator: ".").map { Int($0) ?? 0 }
        let n = max(a.count, b.count)
        for i in 0..<n {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    private func emitUpdateEvent(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.__PBUpdateEvent&&window.__PBUpdateEvent(\(json));", completionHandler: nil)
        }
    }

    private func performIosUpdate(download: Bool) {
        let curVer = AppLicence.shared.appVersion()
        if !PBLocal.shared.isOnline() {
            emitUpdateEvent(["state": "offline", "current": curVer])
            return
        }
        guard let lic = AppLicence.shared.currentLicenceString(), !lic.isEmpty else {
            emitUpdateEvent(["state": "error", "current": curVer, "error": "Activate your rental code first."])
            return
        }
        if updateBusy { return }
        updateBusy = true
        emitUpdateEvent(["state": download ? "downloading" : "checking", "current": curVer])

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let src = self.activeBoothSource()
            let curHash = src?.hash ?? ""
            let bundleHash = src?.bundleHash ?? ""
            guard let url = URL(string: "\(AppLicence.serverUrl)/api/ios-booth") else {
                self.updateBusy = false
                self.emitUpdateEvent(["state": "error", "current": curVer])
                return
            }

            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.timeoutInterval = download ? 30.0 : 12.0
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let bodyObj: [String: Any] = [
                "licence": lic,
                "mid": AppLicence.shared.machineId(),
                "hash": curHash,
                "checkOnly": !download
            ]
            req.httpBody = try? JSONSerialization.data(withJSONObject: bodyObj, options: [])

            let task = URLSession.shared.dataTask(with: req) { data, _, err in
                defer { self.updateBusy = false }
                guard err == nil,
                      let data = data,
                      let obj = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
                      (obj["ok"] as? Bool) == true else {
                    self.emitUpdateEvent(["state": PBLocal.shared.isOnline() ? "error" : "offline", "current": curVer])
                    return
                }

                let serverHash = (obj["hash"] as? String) ?? ""
                let upToDate = (obj["upToDate"] as? Bool) ?? true
                let iosInfo = obj["ios"] as? [String: Any]
                let latestNative = (iosInfo?["version"] as? String) ?? ""
                let nativeUrl = (iosInfo?["url"] as? String) ?? ""
                let nativeNewer = !latestNative.isEmpty && self.isVersionNewer(latestNative, than: curVer)

                if !download {
                    if !upToDate && !serverHash.isEmpty {
                        self.emitUpdateEvent([
                            "state": "available",
                            "mode": "ota",
                            "current": curVer,
                            "latest": latestNative.isEmpty ? curVer : latestNative,
                            "nativeNewer": nativeNewer,
                            "hash": serverHash
                        ])
                    } else if nativeNewer {
                        self.emitUpdateEvent([
                            "state": "available",
                            "mode": "native",
                            "current": curVer,
                            "latest": latestNative,
                            "url": nativeUrl
                        ])
                    } else {
                        self.emitUpdateEvent(["state": "latest", "current": curVer])
                    }
                    return
                }

                guard let html = obj["html"] as? String,
                      html.contains("</body>"),
                      html.contains("window.__PB"),
                      let htmlData = html.data(using: .utf8) else {
                    self.emitUpdateEvent(["state": "error", "current": curVer, "error": "Invalid update bundle received."])
                    return
                }

                let downloadedHash = self.sha256Prefix16(htmlData)
                if !serverHash.isEmpty && downloadedHash != serverHash {
                    self.emitUpdateEvent(["state": "error", "current": curVer, "error": "Update verification failed."])
                    return
                }

                do {
                    try htmlData.write(to: self.otaFileUrl, options: .atomic)
                    UserDefaults.standard.set(downloadedHash, forKey: self.otaHashKey)
                    UserDefaults.standard.set(bundleHash, forKey: self.otaBundledHashKey)
                    self.emitUpdateEvent(["state": "installed", "current": curVer, "hash": downloadedHash])
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                        self.loadBooth()
                    }
                } catch {
                    self.emitUpdateEvent(["state": "error", "current": curVer, "error": "Could not save update."])
                }
            }
            task.resume()
        }
    }

    // MARK: - Activation Gate UI

    private func showActivationScreen(st: AppLicence.Status) {
        gateReason = st.reason
        if gateContainer == nil {
            buildGateView()
        }
        guard let container = gateContainer else { return }
        container.isHidden = false
        view.bringSubviewToFront(container)

        gateMessageLabel?.text = st.message.isEmpty
            ? "Enter this iPad's rental code. It needs Wi-Fi once to activate, then keeps working offline."
            : st.message
        activateBtn?.isEnabled = true

        switch st.reason {
        case "checkin":
            codeField?.isHidden = true
            activateBtn?.setTitle("Retry now", for: .normal)
        case "clock":
            codeField?.isHidden = true
            activateBtn?.setTitle("I fixed it — retry", for: .normal)
        default:
            codeField?.isHidden = false
            activateBtn?.setTitle("Activate iPad", for: .normal)
        }
    }

    private func buildGateView() {
        let container = UIView(frame: view.bounds)
        container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.92, alpha: 1.0)
        container.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(dismissGateKeyboard)))

        let title = UILabel()
        title.text = "photobooth4u"
        title.font = UIFont.systemFont(ofSize: 30, weight: .black)
        title.textColor = UIColor(red: 0.11, green: 0.10, blue: 0.12, alpha: 1.0)
        title.textAlignment = .center
        title.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(title)

        let msg = UILabel()
        msg.font = UIFont.systemFont(ofSize: 15, weight: .medium)
        msg.textColor = UIColor(red: 0.42, green: 0.40, blue: 0.42, alpha: 1.0)
        msg.textAlignment = .center
        msg.numberOfLines = 0
        msg.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(msg)
        self.gateMessageLabel = msg

        let tf = UITextField()
        tf.placeholder = "PB-XXXX-XXXX-XXXX"
        tf.textAlignment = .center
        tf.font = UIFont.monospacedSystemFont(ofSize: 18, weight: .bold)
        tf.borderStyle = .roundedRect
        tf.backgroundColor = .white
        tf.autocapitalizationType = .allCharacters
        tf.autocorrectionType = .no
        tf.returnKeyType = .go
        tf.delegate = self
        tf.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(tf)
        self.codeField = tf

        let btn = UIButton(type: .system)
        btn.setTitle("Activate iPad", for: .normal)
        btn.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .bold)
        btn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1.0) // #C93D27
        btn.setTitleColor(.white, for: .normal)
        btn.layer.cornerRadius = 12
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.addTarget(self, action: #selector(didTapActivate), for: .touchUpInside)
        container.addSubview(btn)
        self.activateBtn = btn

        let spinArmBtn = UIButton(type: .system)
        spinArmBtn.setTitle("🎥 360 Arm Camera (Free Companion)", for: .normal)
        spinArmBtn.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .bold)
        spinArmBtn.backgroundColor = UIColor(red: 0.12, green: 0.23, blue: 0.32, alpha: 1.0) // #1F3A52
        spinArmBtn.setTitleColor(.white, for: .normal)
        spinArmBtn.layer.cornerRadius = 12
        spinArmBtn.translatesAutoresizingMaskIntoConstraints = false
        spinArmBtn.addTarget(self, action: #selector(didTapOpenSpinArm), for: .touchUpInside)
        container.addSubview(spinArmBtn)

        let spinArmNote = UILabel()
        spinArmNote.text = "Pairs via QR to Laptop 360 Desk · Standalone 360 off unless enabled in Admin"
        spinArmNote.font = UIFont.systemFont(ofSize: 12, weight: .medium)
        spinArmNote.textColor = UIColor(red: 0.42, green: 0.40, blue: 0.42, alpha: 1.0)
        spinArmNote.textAlignment = .center
        spinArmNote.numberOfLines = 0
        spinArmNote.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(spinArmNote)

        let mid = UILabel()
        mid.text = "iPad ID: \(AppLicence.shared.machineId())"
        mid.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        mid.textColor = .gray
        mid.textAlignment = .center
        mid.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(mid)

        view.addSubview(container)
        self.gateContainer = container

        NSLayoutConstraint.activate([
            title.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            title.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: -145),

            msg.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 12),
            msg.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            msg.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
            msg.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 24),
            msg.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -24),

            tf.topAnchor.constraint(equalTo: msg.bottomAnchor, constant: 20),
            tf.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            tf.widthAnchor.constraint(equalToConstant: 300),
            tf.heightAnchor.constraint(equalToConstant: 46),

            btn.topAnchor.constraint(equalTo: tf.bottomAnchor, constant: 14),
            btn.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            btn.widthAnchor.constraint(equalToConstant: 300),
            btn.heightAnchor.constraint(equalToConstant: 48),

            spinArmBtn.topAnchor.constraint(equalTo: btn.bottomAnchor, constant: 14),
            spinArmBtn.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            spinArmBtn.widthAnchor.constraint(equalToConstant: 300),
            spinArmBtn.heightAnchor.constraint(equalToConstant: 46),

            spinArmNote.topAnchor.constraint(equalTo: spinArmBtn.bottomAnchor, constant: 6),
            spinArmNote.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            spinArmNote.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 24),
            spinArmNote.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -24),

            mid.topAnchor.constraint(equalTo: spinArmNote.bottomAnchor, constant: 16),
            mid.centerXAnchor.constraint(equalTo: container.centerXAnchor)
        ])
    }

    @objc private func didTapOpenSpinArm() {
        PBLocal.shared.spinContext = PBLocal.SpinCloudContext(standaloneAllowed: hasSpin360Entitlement())
        openSpinArmCamera()
    }

    private func openSpinArmCamera() {
        NativeCameraBridge.shared.stop { [weak self] in
            guard let self = self else { return }
            if let presented = self.presentedViewController {
                presented.dismiss(animated: false)
            }
            let vc = SpinArmViewController()
            vc.modalPresentationStyle = .fullScreen
            vc.onDismiss = { [weak self] in
                self?.webView?.evaluateJavaScript("window.dispatchEvent(new Event('pbSpinArmClosed'));", completionHandler: nil)
            }
            self.present(vc, animated: true)
        }
    }

    @objc private func dismissGateKeyboard() {
        view.endEditing(true)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        didTapActivate()
        return true
    }

    @objc private func didTapActivate() {
        view.endEditing(true)
        guard let btn = activateBtn else { return }

        if gateReason == "clock" {
            bootWithLicence()
            return
        }

        if gateReason == "checkin" {
            btn.isEnabled = false
            btn.setTitle("Checking…", for: .normal)
            AppLicence.shared.checkin(force: true) { [weak self] result in
                guard let self = self else { return }
                if result == "ok" {
                    self.bootWithLicence()
                    return
                }
                btn.isEnabled = true
                btn.setTitle("Retry now", for: .normal)
                self.gateMessageLabel?.text = (result == "revoked")
                    ? AppLicence.shared.status().message
                    : "Still can't reach photobooth4u. Check Wi-Fi and try again."
            }
            return
        }

        let code = (codeField?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else {
            gateMessageLabel?.text = "Type your rental code first."
            return
        }
        btn.isEnabled = false
        btn.setTitle("Activating…", for: .normal)
        AppLicence.shared.activate(code: code) { [weak self] ok, err in
            guard let self = self else { return }
            if ok {
                self.bootWithLicence()
                return
            }
            btn.isEnabled = true
            btn.setTitle("Activate iPad", for: .normal)
            self.gateMessageLabel?.text = err ?? "Activation failed. Check Wi-Fi and code."
        }
    }

    // MARK: - AirPrint Bridge (UIPrintInteractionController)

    private func handleNativePrint(payloadJson: String) -> String {
        guard UIPrintInteractionController.isPrintingAvailable else {
            return "{\"ok\":false,\"error\":\"AirPrint is not available on this iPad.\"}"
        }
        let lowRam = isLowRamDevice
        // Parse the outer JSON payload off the main thread so fallback sync calls never block UIKit.
        printQueue.async { [weak self] in
            guard let self = self else { return }
            var jobName = "Photobooth"
            var widthMm = 101.6
            var heightMm = 152.4
            var pagesJson = ""
            autoreleasepool {
                guard let data = payloadJson.data(using: .utf8),
                      let obj = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
                      let pj = obj["pagesJson"] as? String else { return }
                jobName = (obj["jobName"] as? String) ?? "Photobooth"
                widthMm = (obj["widthMm"] as? NSNumber)?.doubleValue ?? 101.6
                heightMm = (obj["heightMm"] as? NSNumber)?.doubleValue ?? 152.4
                pagesJson = pj
            }
            guard !pagesJson.isEmpty else { return }
            self.renderAndQueueAirPrintOnPrintQueue(jobName: jobName, widthMm: widthMm, heightMm: heightMm, pagesJson: pagesJson, lowRam: lowRam)
        }
        return "{\"ok\":true}"
    }

    private func enqueueNativePrint(jobName: String, widthMm: Double, heightMm: Double, pagesJson: String) {
        guard UIPrintInteractionController.isPrintingAvailable else { return }
        let lowRam = isLowRamDevice
        printQueue.async { [weak self] in
            self?.renderAndQueueAirPrintOnPrintQueue(jobName: jobName, widthMm: widthMm, heightMm: heightMm, pagesJson: pagesJson, lowRam: lowRam)
        }
    }

    /// Runs on `printQueue`: decodes each JPEG via ImageIO subsampling into a temporary PDF file so peak RAM stays minimal on 3 GB iPads.
    private func renderAndQueueAirPrintOnPrintQueue(jobName: String, widthMm: Double, heightMm: Double, pagesJson: String, lowRam: Bool) {
        let ptW = max(72.0, widthMm * 72.0 / 25.4)
        let ptH = max(72.0, heightMm * 72.0 / 25.4)

        var pagesArr: [String] = []
        autoreleasepool {
            guard let pagesData = pagesJson.data(using: .utf8),
                  let arr = (try? JSONSerialization.jsonObject(with: pagesData, options: [])) as? [String] else { return }
            pagesArr = arr
        }
        guard !pagesArr.isEmpty else { return }

        let tmpDir = FileManager.default.temporaryDirectory
        if let items = try? FileManager.default.contentsOfDirectory(at: tmpDir, includingPropertiesForKeys: [.contentModificationDateKey], options: []) {
            let cutoff = Date().addingTimeInterval(-600)
            for u in items where u.lastPathComponent.hasPrefix("pb_airprint_") && u.pathExtension == "pdf" {
                let mtime = (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
                if mtime < cutoff { try? FileManager.default.removeItem(at: u) }
            }
        }

        let pdfUrl = tmpDir.appendingPathComponent("pb_airprint_\(UUID().uuidString).pdf")
        let pageBounds = CGRect(x: 0, y: 0, width: ptW, height: ptH)
        let renderer = UIGraphicsPDFRenderer(bounds: pageBounds)
        let maxPx = lowRam ? 2048 : 3600
        var drawnCount = 0

        do {
            try renderer.writePDF(to: pdfUrl) { ctx in
                for item in pagesArr {
                    autoreleasepool {
                        let b64: String
                        if let comma = item.firstIndex(of: ",") {
                            b64 = String(item[item.index(after: comma)...])
                        } else {
                            b64 = item
                        }
                        guard let imgBytes = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !imgBytes.isEmpty else { return }
                        // Keep native JPEG bytes when already within maxPx so UIGraphicsPDFRenderer embeds compact /DCTDecode
                        // streams (~400 KB) instead of multi-MB uncompressed bitmaps. Downsample & re-encode only oversized pages.
                        var pdfImgData: Data = imgBytes
                        if let src = CGImageSourceCreateWithData(imgBytes as CFData, nil) {
                            let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
                            let pw = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
                            let ph = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
                            let orient = (props?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
                            if orient != 1 || max(pw, ph) > maxPx {
                                let thumbOpts: [CFString: Any] = [
                                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                                    kCGImageSourceCreateThumbnailWithTransform: true,
                                    kCGImageSourceShouldCache: false,
                                    kCGImageSourceShouldCacheImmediately: true,
                                    kCGImageSourceThumbnailMaxPixelSize: maxPx
                                ]
                                if let cgImg = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts as CFDictionary) {
                                    let outData = NSMutableData()
                                    if let dest = CGImageDestinationCreateWithData(outData as CFMutableData, "public.jpeg" as CFString, 1, nil) {
                                        let saveOpts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.92]
                                        CGImageDestinationAddImage(dest, cgImg, saveOpts as CFDictionary)
                                        if CGImageDestinationFinalize(dest), outData.length > 0 {
                                            pdfImgData = outData as Data
                                        }
                                    }
                                }
                            }
                        }
                        guard let img = UIImage(data: pdfImgData) else { return }
                        drawnCount += 1
                        ctx.beginPage()
                        let iw = max(1.0, Double(img.size.width))
                        let ih = max(1.0, Double(img.size.height))
                        let imgRatio = iw / ih
                        let pageRatio = ptW / ptH
                        if abs(imgRatio - pageRatio) < 0.04 {
                            img.draw(in: pageBounds)
                        } else {
                            let scale = min(ptW / iw, ptH / ih)
                            let dw = iw * scale, dh = ih * scale
                            let rect = CGRect(x: (ptW - dw) / 2.0, y: (ptH - dh) / 2.0, width: dw, height: dh)
                            img.draw(in: rect)
                        }
                    }
                }
            }
        } catch {
            try? FileManager.default.removeItem(at: pdfUrl)
            return
        }

        guard drawnCount > 0 else {
            try? FileManager.default.removeItem(at: pdfUrl)
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                try? FileManager.default.removeItem(at: pdfUrl)
                return
            }
            self.airPrintQueue.append((jobName: jobName, ptW: ptW, ptH: ptH, pdfUrl: pdfUrl))
            self.drainAirPrintQueue()
        }
    }

    private func drainAirPrintQueue() {
        guard !airPrintBusy, !airPrintQueue.isEmpty else { return }
        airPrintBusy = true
        let next = airPrintQueue.removeFirst()

        let controller = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.jobName = next.jobName
        info.outputType = .photo
        info.orientation = (next.ptW > next.ptH) ? .landscape : .portrait
        controller.printInfo = info
        if UIPrintInteractionController.canPrint(next.pdfUrl) {
            controller.printingItem = next.pdfUrl
        } else if let fallbackData = try? Data(contentsOf: next.pdfUrl), !fallbackData.isEmpty {
            controller.printingItem = fallbackData
        } else {
            try? FileManager.default.removeItem(at: next.pdfUrl)
            airPrintBusy = false
            drainAirPrintQueue()
            return
        }
        airPrintPageSize = CGSize(width: next.ptW, height: next.ptH)
        controller.delegate = self

        var finished = false
        var timeoutItem: DispatchWorkItem?
        let finishJob: () -> Void = { [weak self] in
            DispatchQueue.main.async {
                guard !finished else { return }
                finished = true
                timeoutItem?.cancel()
                timeoutItem = nil
                controller.printingItem = nil
                controller.delegate = nil
                try? FileManager.default.removeItem(at: next.pdfUrl)
                guard let self = self else { return }
                self.airPrintBusy = false
                self.drainAirPrintQueue()
            }
        }
        let guardWork = DispatchWorkItem { finishJob() }
        timeoutItem = guardWork
        DispatchQueue.main.asyncAfter(deadline: .now() + 60.0, execute: guardWork)

        let cancelGuardOnInteractiveShow: () -> Void = {
            timeoutItem?.cancel()
            timeoutItem = nil
        }

        if let savedUrlStr = UserDefaults.standard.string(forKey: airprintUrlKey),
           !savedUrlStr.isEmpty,
           let savedUrl = URL(string: savedUrlStr) {
            let targetPrinter = UIPrinter(url: savedUrl)
            targetPrinter.contactPrinter { [weak self] available in
                DispatchQueue.main.async {
                    guard let self = self, !finished else { return }
                    if available {
                        controller.print(to: targetPrinter) { [weak self] _, completed, err in
                            if !completed && err != nil {
                                DispatchQueue.main.async {
                                    guard let self = self, !finished else { return }
                                    self.presentPrintController(controller, onPresented: cancelGuardOnInteractiveShow, completion: finishJob)
                                }
                            } else {
                                finishJob()
                            }
                        }
                    } else {
                        self.presentPrintController(controller, onPresented: cancelGuardOnInteractiveShow, completion: finishJob)
                    }
                }
            }
        } else {
            presentPrintController(controller, onPresented: cancelGuardOnInteractiveShow, completion: finishJob)
        }
    }

    // MARK: - AirPrint paper choice

    // A photo printer such as the Epson L8050 lists several papers (A4, Letter, 4x6, 5x7 ...). Left alone, iPadOS may pick a
    // big sheet and the 4x6 photo ends up small in the middle of it. This picks the paper closest to the size of the page the
    // booth made (the page is already the size of the paper chosen in Print settings). Among papers of that size it prefers
    // the one that prints edge to edge (a "borderless" entry), so the border is as thin as the printer allows.
    func printInteractionController(_ printInteractionController: UIPrintInteractionController, choosePaper paperList: [UIPrintPaper]) -> UIPrintPaper {
        let w = airPrintPageSize.width
        let h = airPrintPageSize.height
        func score(_ paper: UIPrintPaper) -> CGFloat {
            let pw = paper.paperSize.width
            let ph = paper.paperSize.height
            let straight = abs(pw - w) + abs(ph - h)
            let turned = abs(pw - h) + abs(ph - w)
            let sizeGap = min(straight, turned)                          // how far the paper is from the page (a turned paper is fine)
            let unprintable = (pw * ph) - (paper.printableRect.width * paper.printableRect.height)
            return sizeGap * 100000 + unprintable                        // size first, then the thinnest unprintable border
        }
        return paperList.min { score($0) < score($1) } ?? paperList[0]      // iPadOS never sends an empty list
    }

    private func presentPrintController(_ controller: UIPrintInteractionController, attempt: Int = 0, onPresented: (() -> Void)? = nil, completion: (() -> Void)? = nil) {
        guard view.window != nil else {
            completion?()
            return
        }
        if presentedViewController != nil || isBeingPresented || isBeingDismissed {
            if attempt < 20 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                    self?.presentPrintController(controller, attempt: attempt + 1, onPresented: onPresented, completion: completion)
                }
            } else {
                completion?()
            }
            return
        }
        let doneHandler: UIPrintInteractionController.CompletionHandler = { _, _, _ in
            completion?()
        }
        let shown: Bool
        if UIDevice.current.userInterfaceIdiom == .phone {
            shown = controller.present(animated: true, completionHandler: doneHandler)
        } else {
            let anchor = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
            shown = controller.present(from: anchor, in: view, animated: true, completionHandler: doneHandler)
        }
        if shown {
            onPresented?()
        } else {
            completion?()
        }
    }

    private func savedAirPrintJson() -> String {
        let defaults = UserDefaults.standard
        let url = defaults.string(forKey: airprintUrlKey) ?? ""
        let name = defaults.string(forKey: airprintNameKey) ?? ""
        let obj: [String: Any] = ["url": url, "name": name]
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    private func emitAirPrintEvent(name: String, url: String) {
        let obj: [String: Any] = ["name": name, "url": url]
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let json = String(data: d, encoding: .utf8) else { return }
        let lit = jsStringLiteral(json)
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.__pbIosAirPrint=\(lit);window.__PBAirPrintEvent&&window.__PBAirPrintEvent(\(json));", completionHandler: nil)
        }
    }

    private func pickSavedAirPrint() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let initial: UIPrinter? = UserDefaults.standard.string(forKey: self.airprintUrlKey)
                .flatMap(URL.init(string:))
                .map(UIPrinter.init(url:))
            let picker = UIPrinterPickerController(initiallySelectedPrinter: initial)
            let done: UIPrinterPickerController.CompletionHandler = { [weak self] pk, selected, _ in
                guard let self = self, selected, let p = pk.selectedPrinter else { return }
                let u = p.url.absoluteString
                let n = p.displayName
                UserDefaults.standard.set(u, forKey: self.airprintUrlKey)
                UserDefaults.standard.set(n, forKey: self.airprintNameKey)
                self.emitAirPrintEvent(name: n, url: u)
            }
            if UIDevice.current.userInterfaceIdiom == .phone {
                picker.present(animated: true, completionHandler: done)
            } else {
                let anchor = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 1, height: 1)
                picker.present(from: anchor, in: self.view, animated: true, completionHandler: done)
            }
        }
    }

    private func clearSavedAirPrint() {
        UserDefaults.standard.removeObject(forKey: airprintUrlKey)
        UserDefaults.standard.removeObject(forKey: airprintNameKey)
        emitAirPrintEvent(name: "", url: "")
    }

    // MARK: - Raw TCP (:9100) LAN Receipt Printers

    private func loadTcpPrinters() -> [[String: Any]] {
        guard let raw = UserDefaults.standard.string(forKey: tcpPrintersKey),
              let data = raw.data(using: .utf8),
              let arr = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [[String: Any]] else {
            return []
        }
        return arr
    }

    private func saveTcpPrinters(_ list: [[String: Any]]) {
        if let data = try? JSONSerialization.data(withJSONObject: list, options: []),
           let str = String(data: data, encoding: .utf8) {
            UserDefaults.standard.set(str, forKey: tcpPrintersKey)
        }
        pushNetPrintersState()
    }

    private func setNetAddNote(_ note: String) {
        netAddNoteLock.lock()
        netAddNote = note
        netAddNoteLock.unlock()
        pushNetPrintersState()
    }

    private func getNetAddNote() -> String {
        netAddNoteLock.lock()
        defer { netAddNoteLock.unlock() }
        return netAddNote
    }

    private func tcpPrintersListJson() -> String {
        let obj: [String: Any] = ["printers": loadTcpPrinters(), "scanning": false, "addNote": getNetAddNote()]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let str = String(data: data, encoding: .utf8) else {
            return "{\"printers\":[],\"scanning\":false}"
        }
        return str
    }

    private func addTcpPrinterByIp(_ rawIp: String) -> String {
        let trimmed = rawIp.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.range(of: "^\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d{1,5})?$", options: .regularExpression) != nil else {
            return "bad"
        }
        let parts = trimmed.split(separator: ":", maxSplits: 1)
        let octets = parts[0].split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ $0 >= 0 && $0 <= 255 }) else { return "bad" }
        setNetAddNote("")
        var list = loadTcpPrinters()
        if let idx = list.firstIndex(where: { ($0["ip"] as? String) == trimmed }) {
            let existing = list.remove(at: idx)
            list.insert(existing, at: 0)
        } else {
            list.insert([
                "ip": trimmed,
                "name": "Receipt (\(trimmed))",
                "raw": true,
                "usb": false
            ], at: 0)
        }
        saveTcpPrinters(list)
        probeNetworkPrinter(trimmed)     // checks IPP (:631), ESC/P-R (:9100), and LPD (:515) for Epson L8050 / Wi-Fi printers
        return "ok"
    }

    private func forgetTcpPrinter(_ rawIp: String) {
        let trimmed = rawIp.trimmingCharacters(in: .whitespacesAndNewlines)
        let list = loadTcpPrinters().filter { ($0["ip"] as? String) != trimmed }
        saveTcpPrinters(list)
    }

    private func emitNetResult(job: String, ok: Bool, error: String? = nil) {
        var obj: [String: Any] = ["job": job, "ok": ok]
        if let e = error { obj["error"] = e }
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let json = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.__PBNetResult&&window.__PBNetResult(\(json));", completionHandler: nil)
        }
    }

    private func sendRawTcpPrint(job: String, ipPort: String, b64: String, paced: Bool) {
        guard !job.isEmpty,
              let payload = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
              !payload.isEmpty else {
            emitNetResult(job: job, ok: false, error: "Empty print data.")
            return
        }
        let parts = ipPort.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ":", maxSplits: 1)
        let host = String(parts[0])
        let portNum: UInt16 = (parts.count > 1 ? UInt16(parts[1]) : nil) ?? 9100
        guard let nwPort = NWEndpoint.Port(rawValue: portNum), !host.isEmpty else {
            emitNetResult(job: job, ok: false, error: "Invalid printer address.")
            return
        }

        let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
        let q = DispatchQueue(label: "com.photobooth4u.rawtcp.\(job)")
        var finished = false
        let lock = NSLock()
        func finish(_ ok: Bool, _ errMsg: String? = nil) {
            lock.lock()
            let already = finished
            finished = true
            lock.unlock()
            guard !already else { return }
            conn.cancel()
            emitNetResult(job: job, ok: ok, error: errMsg)
        }

        q.asyncAfter(deadline: .now() + 12.0) {
            finish(false, "Receipt printer did not respond at \(host):\(portNum).")
        }

        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                let chunkSize = paced ? 2048 : 16384
                func sendNext(_ offset: Int) {
                    if offset >= payload.count {
                        finish(true)
                        return
                    }
                    let end = min(payload.count, offset + chunkSize)
                    let slice = payload.subdata(in: offset..<end)
                    conn.send(content: slice, completion: .contentProcessed { sendErr in
                        if let se = sendErr {
                            finish(false, se.localizedDescription)
                            return
                        }
                        if paced && end < payload.count {
                            q.asyncAfter(deadline: .now() + 0.018) { sendNext(end) }
                        } else {
                            sendNext(end)
                        }
                    })
                }
                sendNext(0)
            case .failed(let e):
                finish(false, e.localizedDescription)
            default:
                break
            }
        }
        conn.start(queue: q)
    }

    // MARK: - IPP & ESC/P-R photo printers on Wi-Fi / Wi-Fi Direct (printers that are not AirPrint, e.g. Epson L8050)

    /// Probes 631 (IPP), 9100 (Raw / ESC/P-R) and 515 (LPD, e.g. Epson L8050 on Wi-Fi Direct 192.168.223.1).
    /// When IPP answers with JPEG support it becomes an IPP photo printer; when LPD 515 or Epson L-series 9100 answers
    /// without IPP it becomes a direct ESC/P-R photo printer; otherwise raw :9100 receipt printers stay Receipt.
    private func probeNetworkPrinter(_ ipPort: String) {
        let host = String(ipPort.split(separator: ":", maxSplits: 1).first ?? Substring(ipPort))
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let ports = PrinterProbe.probePorts(ip: host)
            if ports.ippPort > 0, let caps = IppNet.fetchCaps(ip: host, port: 631),
               caps.formats.isEmpty || caps.formats.contains("image/jpeg") {
                DispatchQueue.main.async {
                    self?.applyIppCaps(ipPort, caps, lpdPort: ports.lpdPort, rawPort: ports.rawPort)
                }
                return
            }
            if ports.lpdPort > 0 || ports.rawPort > 0 {
                let web = PrinterProbe.fetchWebModel(ip: host)
                DispatchQueue.main.async {
                    self?.applyEscprOrRawProbe(ipPort, host: host, ports: ports, model: web.model, vendorHint: web.vendorHint)
                }
                return
            }
            self?.setNetAddNote("Nothing at \(host) answered on the printing ports (631, 9100, 515). Check the printer is on, this iPad is on the same Wi-Fi, and Local Network access is allowed.")
        }
    }

    private func applyIppCaps(_ ipPort: String, _ caps: IppNet.Caps, lpdPort: Int = 0, rawPort: Int = 0) {
        setNetAddNote("")
        var list = loadTcpPrinters()
        guard let i = list.firstIndex(where: { ($0["ip"] as? String) == ipPort }) else { return }
        var e = list[i]
        e["ipp"] = true
        e["raw"] = false
        e["escpr"] = false
        e["usb"] = false
        e["lpd"] = (lpdPort > 0)
        e["lpdPort"] = lpdPort
        e["rawPort"] = rawPort
        e["name"] = caps.model.isEmpty ? "Wi-Fi printer (\(ipPort))" : caps.model
        e["ippPath"] = caps.path
        if PrinterProbe.isL8050Name(caps.model) { e["epsonModel"] = "L8050" }
        if !caps.serviceName.isEmpty { e["dnssd"] = caps.serviceName }      // lets the app find this printer again by name if its address changes
        e["qualities"] = caps.qualities
        e["colorModes"] = caps.colorModes
        e["mediaTypes"] = caps.mediaTypes
        e["bcap"] = caps.borderlessCap
        list[i] = e
        saveTcpPrinters(list)
    }

    private func applyEscprOrRawProbe(_ ipPort: String, host: String, ports: PrinterProbe.PortResult, model: String, vendorHint: String) {
        setNetAddNote("")
        var list = loadTcpPrinters()
        guard let i = list.firstIndex(where: { ($0["ip"] as? String) == ipPort }) else { return }
        let modelLower = model.lowercased()
        let hintLower = vendorHint.lowercased()
        let isHp = modelLower.contains("hp") || modelLower.contains("hewlett") || hintLower.contains("hp")
        let isBrother = modelLower.contains("brother") || hintLower.contains("brother") || host == "192.168.118.1"
        let isEpson = !isHp && !isBrother && (
            PrinterProbe.isEpsonLSeries(model) ||
            modelLower.contains("epson") ||
            hintLower.contains("epson") ||
            host == "192.168.223.1"
        )
        let lpdOnly = (ports.ippPort == 0 && ports.rawPort == 0 && ports.lpdPort > 0)
        let escprNet = !isHp && !isBrother && (
            (ports.rawPort > 0 && PrinterProbe.isEpsonLSeries(model)) ||
            (lpdOnly && (isEpson || (model.isEmpty && vendorHint.isEmpty)))
        )
        let isL8050 = PrinterProbe.isL8050Name(model)

        let displayName: String
        if !model.isEmpty {
            displayName = model
        } else if host == "192.168.223.1" {
            displayName = isHp ? "HP Wi-Fi Direct (\(host))" : (lpdOnly ? "Epson Wi-Fi Direct (\(host))" : "Epson / HP Wi-Fi Direct (\(host))")
        } else if escprNet {
            displayName = "Epson printer (\(host))"
        } else {
            displayName = "Receipt (\(ipPort))"
        }

        var e = list[i]
        e["ipp"] = false
        e["usb"] = false
        e["lpdPort"] = ports.lpdPort
        e["rawPort"] = ports.rawPort
        e["name"] = displayName
        if escprNet {
            e["raw"] = false
            e["escpr"] = true
            e["lpd"] = (ports.lpdPort > 0)
            if isL8050 { e["epsonModel"] = "L8050" }
            if !model.isEmpty { e["dnssd"] = model }
        } else {
            e["raw"] = true
            e["escpr"] = false
            e["lpd"] = false
        }
        list[i] = e
        saveTcpPrinters(list)
    }

    /// Where this printer was last seen: the newer address found by name, else the one that was typed in.
    private func ippTarget(_ ipPort: String) -> String {
        if let e = loadTcpPrinters().first(where: { ($0["ip"] as? String) == ipPort }),
           let live = e["liveIp"] as? String, !live.isEmpty {
            return live
        }
        return String(ipPort.split(separator: ":", maxSplits: 1).first ?? Substring(ipPort))
    }

    /// The name to look this printer up by on the network: how it lists itself, else the model name it gave.
    private func ippIdentity(_ ipPort: String) -> String {
        guard let e = loadTcpPrinters().first(where: { ($0["ip"] as? String) == ipPort }) else { return "" }
        if let s = e["dnssd"] as? String, !s.isEmpty { return s }
        return (e["name"] as? String) ?? ""
    }

    private func rememberIppAddress(_ ipPort: String, _ live: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            var list = self.loadTcpPrinters()
            guard let i = list.firstIndex(where: { ($0["ip"] as? String) == ipPort }) else { return }
            list[i]["liveIp"] = live
            self.saveTcpPrinters(list)
        }
    }

    /// The printer did not answer at its saved address: look for it by name. When it is found and answers, its new address is
    /// remembered, so later prints go straight there.
    private func ippRefind(_ ipPort: String) -> (host: String, probe: IppNet.Probe)? {
        let name = ippIdentity(ipPort)
        guard !name.isEmpty, let fresh = IppNet.findByName(name, wait: 6) else { return nil }
        let p = IppNet.reach(ip: fresh, port: 631, tries: 2)
        if case .unreachable = p { return nil }
        rememberIppAddress(ipPort, fresh)
        return (host: fresh, probe: p)
    }

    /// Tells the booth page about a printer problem (out of paper, a jam ...). It shows it as a message to the operator.
    private func emitIppWarn(_ message: String) {
        let obj: [String: Any] = ["message": message]
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let json = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.__PBIppWarn&&window.__PBIppWarn(\(json));", completionHandler: nil)
        }
    }

    /// After the printer took the photos, keeps an eye on them in the background (the booth is not held up) and warns if one
    /// does not print.
    private func watchIppJobs(host: String, path: String, ids: [Int]) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let limit = min(900.0, 90.0 + 60.0 * Double(ids.count))
            if let msg = IppNet.watchJobs(ip: host, port: 631, path: path, ids: ids, maxSeconds: limit) {
                self?.emitIppWarn(msg)
            }
        }
    }

    /// window.__PBNet.printIpp: sends each photo to the printer as an IPP Print-Job (copies repeats the whole set) and answers
    /// through window.__PBNetResult, like the Android app does.
    private func sendIppPrint(job: String, ipPort: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String, optionsJson: String) {
        guard !job.isEmpty else { return }
        printQueue.async { [weak self] in
            guard let self = self else { return }
            do {
                let pages: [Data] = try autoreleasepool {
                    guard let pd = pagesJson.data(using: .utf8),
                          let arr = try JSONSerialization.jsonObject(with: pd, options: []) as? [String],
                          !arr.isEmpty else {
                        throw IppNet.Failure("Nothing to print.")
                    }
                    var out: [Data] = []
                    for s in arr {
                        try autoreleasepool {
                            var b64 = s
                            if s.hasPrefix("data:"), let comma = s.firstIndex(of: ",") {
                                b64 = String(s[s.index(after: comma)...])
                            }
                            guard let d = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !d.isEmpty else {
                                throw IppNet.Failure("Could not read the picture to print.")
                            }
                            out.append(d)
                        }
                    }
                    return out
                }
                var opts: [String: Any] = [:]
                if let od = optionsJson.data(using: .utf8),
                   let o = (try? JSONSerialization.jsonObject(with: od, options: [])) as? [String: Any] {
                    opts = o
                }
                let quality = (opts["quality"] as? String) ?? ""
                let color = (opts["color"] as? String) ?? ""
                let media = (opts["media"] as? String) ?? ""
                let borderless = (opts["borderless"] as? Bool) ?? false
                let dpi = (opts["dpi"] as? NSNumber)?.intValue ?? 300
                let sets = max(1, min(copies, 20))

                // First make sure the printer answers. One coming out of sleep needs several seconds, and one the router gave a
                // new address is looked up again by its name. Nothing is sent until it has answered, so waiting and looking again
                // can never print a photo twice.
                var host = self.ippTarget(ipPort)
                var probe = IppNet.reach(ip: host, port: 631, tries: 3)
                if case .unreachable = probe, let fresh = self.ippRefind(ipPort) {
                    host = fresh.host
                    probe = fresh.probe
                }
                if case .unreachable = probe {
                    throw IppNet.Failure("Could not reach the printer. Check it is on, on the same Wi-Fi as this iPad, and that Local Network access is allowed for photobooth4u in the iPad Settings.")
                }
                var known: IppNet.Caps? = nil
                if case .ok(let c) = probe { known = c }
                if let c = known, let note = IppNet.problem(c) { self.emitIppWarn(note) }

                var ids: [Int] = []
                let totalSheets = sets * pages.count
                var sentSheets = 0
                for _ in 0..<sets {
                    for p in pages {
                        var acceptedId: Int? = nil
                        do {
                            if let id = try IppNet.printPage(ip: host, port: 631, jpegIn: p, job: "Photobooth", wMm: widthMm, hMm: heightMm,
                                                             quality: quality, color: color, media: media, borderless: borderless, dpi: dpi, known: known) {
                                ids.append(id)
                                acceptedId = id
                            }
                        } catch let f as IppNet.Failure where f.unreached {
                            // The printer dropped off the network between the check and the send, so this photo never reached it:
                            // look for it once more, then send this photo again.
                            guard let fresh = self.ippRefind(ipPort) else { throw f }
                            host = fresh.host
                            if case .ok(let c) = fresh.probe { known = c } else { known = nil }
                            if let id = try IppNet.printPage(ip: host, port: 631, jpegIn: p, job: "Photobooth", wMm: widthMm, hMm: heightMm,
                                                             quality: quality, color: color, media: media, borderless: borderless, dpi: dpi, known: known) {
                                ids.append(id)
                                acceptedId = id
                            }
                        }
                        sentSheets += 1
                        if sentSheets < totalSheets, let c = known, IppNet.isSelphy(c) {
                            IppNet.waitJobIdle(ip: host, port: 631, path: c.path, jobId: acceptedId, maxSeconds: 75)
                        }
                    }
                }
                self.emitNetResult(job: job, ok: true)
                // The printer took the photos. Keep an eye on them without holding the booth up.
                if let c = known, !ids.isEmpty { self.watchIppJobs(host: host, path: c.path, ids: ids) }
            } catch let f as IppNet.Failure {
                self.emitNetResult(job: job, ok: false, error: f.message)
            } catch {
                self.emitNetResult(job: job, ok: false, error: error.localizedDescription)
            }
        }
    }

    /// window.__PBNet.printEscpr: streams Epson ESC/P-R (L8050 360/720 dpi borderless or generic Epson) over LPD (:515) or Raw (:9100).
    private func sendEscprPrint(job: String, ipPort: String, widthMm: Double, heightMm: Double, copies: Int, pagesJson: String, optionsJson: String) {
        guard !job.isEmpty else { return }
        printQueue.async { [weak self] in
            guard let self = self else { return }
            do {
                let pages: [Data] = try autoreleasepool {
                    guard let pd = pagesJson.data(using: .utf8),
                          let arr = try JSONSerialization.jsonObject(with: pd, options: []) as? [String],
                          !arr.isEmpty else {
                        throw EscprNet.Failure.message("Nothing to print.", unreached: true)
                    }
                    var out: [Data] = []
                    for s in arr {
                        try autoreleasepool {
                            var b64 = s
                            if s.hasPrefix("data:"), let comma = s.firstIndex(of: ",") {
                                b64 = String(s[s.index(after: comma)...])
                            }
                            guard let d = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !d.isEmpty else {
                                throw EscprNet.Failure.message("Could not read the picture to print.", unreached: true)
                            }
                            out.append(d)
                        }
                    }
                    return out
                }
                var opts: [String: Any] = [:]
                if let od = optionsJson.data(using: .utf8),
                   let o = (try? JSONSerialization.jsonObject(with: od, options: [])) as? [String: Any] {
                    opts = o
                }

                var host = self.ippTarget(ipPort)
                let savedEntry = self.loadTcpPrinters().first(where: { ($0["ip"] as? String) == ipPort })
                let savedRawPort = (savedEntry?["rawPort"] as? NSNumber)?.intValue ?? 0
                let savedLpdPort = (savedEntry?["lpdPort"] as? NSNumber)?.intValue ?? 0
                let rawPort = UInt16(savedRawPort > 0 ? savedRawPort : 9100)
                let lpdPort = UInt16(savedLpdPort > 0 ? savedLpdPort : 515)

                if !PrinterProbe.isPortOpen(ip: host, port: rawPort, timeout: 1.5) &&
                   !PrinterProbe.isPortOpen(ip: host, port: lpdPort, timeout: 1.5) {
                    Thread.sleep(forTimeInterval: 0.6)
                    if !PrinterProbe.isPortOpen(ip: host, port: rawPort, timeout: 1.5) &&
                       !PrinterProbe.isPortOpen(ip: host, port: lpdPort, timeout: 1.5) {
                        let name = self.ippIdentity(ipPort)
                        if !name.isEmpty,
                           let fresh = IppNet.findByName(name, serviceType: "_printer._tcp", wait: 5.0),
                           PrinterProbe.isPortOpen(ip: fresh, port: lpdPort, timeout: 1.5) || PrinterProbe.isPortOpen(ip: fresh, port: rawPort, timeout: 1.5) {
                            host = fresh
                            self.rememberIppAddress(ipPort, fresh)
                        }
                    }
                }

                let optModel = (opts["epsonModel"] as? String) ?? ""
                let optName = (opts["printerName"] as? String) ?? ""
                let savedName = (savedEntry?["name"] as? String) ?? ""
                let savedModel = (savedEntry?["epsonModel"] as? String) ?? ""
                var probedModel = ""
                if optModel.caseInsensitiveCompare("L8050") != .orderedSame &&
                   savedModel.caseInsensitiveCompare("L8050") != .orderedSame &&
                   !PrinterProbe.isL8050Name(optName) &&
                   !PrinterProbe.isL8050Name(savedName) {
                    probedModel = PrinterProbe.fetchWebModel(ip: host).model
                }
                let isL8050 = optModel.caseInsensitiveCompare("L8050") == .orderedSame ||
                    savedModel.caseInsensitiveCompare("L8050") == .orderedSame ||
                    PrinterProbe.isL8050Name(optName) ||
                    PrinterProbe.isL8050Name(savedName) ||
                    PrinterProbe.isL8050Name(probedModel)

                let borderless = (opts["borderless"] as? Bool) ?? false
                let cfg = isL8050
                    ? EscprNet.l8050EscprConfig(opts: opts, borderless: borderless, widthMm: widthMm, heightMm: heightMm)
                    : EscprNet.genericEscprConfig(opts: opts, borderless: borderless)

                let wantLpd = (opts["lpd"] as? Bool) ?? false
                let useLpdFirst = wantLpd ||
                    (savedRawPort == 0 && savedLpdPort > 0) ||
                    (!PrinterProbe.isPortOpen(ip: host, port: rawPort, timeout: 1.2) && PrinterProbe.isPortOpen(ip: host, port: lpdPort, timeout: 1.2))

                let sets = max(1, min(copies, 20))
                for c in 0..<sets {
                    for (i, jpeg) in pages.enumerated() {
                        if c > 0 || i > 0 { Thread.sleep(forTimeInterval: 0.4) }
                        if useLpdFirst {
                            try EscprNet.netLpdStream(ip: host, port: lpdPort, jpegData: jpeg, widthMm: widthMm, heightMm: heightMm, cfg: cfg)
                        } else {
                            do {
                                try EscprNet.netRawStream(ip: host, port: rawPort, jpegData: jpeg, widthMm: widthMm, heightMm: heightMm, cfg: cfg)
                            } catch let f as EscprNet.Failure where f.unreached {
                                if PrinterProbe.isPortOpen(ip: host, port: lpdPort, timeout: 1.5) {
                                    try EscprNet.netLpdStream(ip: host, port: lpdPort, jpegData: jpeg, widthMm: widthMm, heightMm: heightMm, cfg: cfg)
                                } else {
                                    throw f
                                }
                            }
                        }
                    }
                }
                self.emitNetResult(job: job, ok: true)
            } catch let f as EscprNet.Failure {
                self.emitNetResult(job: job, ok: false, error: f.localizedDescription)
            } catch {
                self.emitNetResult(job: job, ok: false, error: error.localizedDescription)
            }
        }
    }

    private func printWebViewFallback() {
        guard UIPrintInteractionController.isPrintingAvailable else { return }
        let controller = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.jobName = "Photobooth"
        info.outputType = .photo
        controller.printInfo = info
        controller.printFormatter = webView.viewPrintFormatter()
        presentPrintController(controller)
    }

    // MARK: - WKScriptMessageHandler & Sync Prompts

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "pbVoiceSpeak" {
            if let dict = message.body as? [String: Any] {
                let text = (dict["text"] as? String) ?? ""
                let voice = dict["voice"] as? String
                let vol = (dict["volume"] as? NSNumber)?.floatValue ?? 1.0
                VoiceBridge.shared.speak(text: text, voiceName: voice, volume: vol)
            } else if let text = message.body as? String {
                VoiceBridge.shared.speak(text: text)
            }
        } else if message.name == "pbVoiceStop" {
            VoiceBridge.shared.stop()
        } else if message.name == "pbGuestViewSet", let mode = message.body as? String {
            PBLocal.shared.guestViewSet(mode)
        } else if message.name == "pbPrintWebView" {
            printWebViewFallback()
        } else if message.name == "pbUpdateCheck" {
            performIosUpdate(download: false)
        } else if message.name == "pbUpdateStart" {
            performIosUpdate(download: true)
        } else if message.name == "pbPickAirPrint" {
            pickSavedAirPrint()
        } else if message.name == "pbClearAirPrint" {
            clearSavedAirPrint()
        } else if message.name == "pbPrintAirPrint", let dict = message.body as? [String: Any] {
            let jobName = (dict["jobName"] as? String) ?? "Photobooth"
            let widthMm = (dict["widthMm"] as? NSNumber)?.doubleValue ?? 101.6
            let heightMm = (dict["heightMm"] as? NSNumber)?.doubleValue ?? 152.4
            let pagesJson = (dict["pagesJson"] as? String) ?? "[]"
            enqueueNativePrint(jobName: jobName, widthMm: widthMm, heightMm: heightMm, pagesJson: pagesJson)
        } else if message.name == "pbPrintRawTcp", let dict = message.body as? [String: Any] {
            let job = (dict["job"] as? String) ?? ""
            let ip = (dict["ip"] as? String) ?? ""
            let b64 = (dict["b64"] as? String) ?? ""
            let paced = (dict["paced"] as? Bool) ?? false
            sendRawTcpPrint(job: job, ipPort: ip, b64: b64, paced: paced)
        } else if message.name == "pbPrintIpp", let dict = message.body as? [String: Any] {
            let job = (dict["job"] as? String) ?? ""
            let ip = (dict["ip"] as? String) ?? ""
            let widthMm = (dict["widthMm"] as? NSNumber)?.doubleValue ?? 0
            let heightMm = (dict["heightMm"] as? NSNumber)?.doubleValue ?? 0
            let copies = (dict["copies"] as? NSNumber)?.intValue ?? 1
            let pagesJson = (dict["pagesJson"] as? String) ?? "[]"
            let optionsJson = (dict["optionsJson"] as? String) ?? "{}"
            sendIppPrint(job: job, ipPort: ip, widthMm: widthMm, heightMm: heightMm, copies: copies, pagesJson: pagesJson, optionsJson: optionsJson)
        } else if message.name == "pbPrintEscpr", let dict = message.body as? [String: Any] {
            let job = (dict["job"] as? String) ?? ""
            let ip = (dict["ip"] as? String) ?? ""
            let widthMm = (dict["widthMm"] as? NSNumber)?.doubleValue ?? 0
            let heightMm = (dict["heightMm"] as? NSNumber)?.doubleValue ?? 0
            let copies = (dict["copies"] as? NSNumber)?.intValue ?? 1
            let pagesJson = (dict["pagesJson"] as? String) ?? "[]"
            let optionsJson = (dict["optionsJson"] as? String) ?? "{}"
            sendEscprPrint(job: job, ipPort: ip, widthMm: widthMm, heightMm: heightMm, copies: copies, pagesJson: pagesJson, optionsJson: optionsJson)
        } else if message.name == "pbSave", let dict = message.body as? [String: Any] {
            // window.__PBLocal.driveAsync / saveImageAsync: write the file in the background, answer through window.__pbSaveResolve
            let id = (dict["id"] as? NSNumber)?.intValue ?? 0
            let op = (dict["op"] as? String) ?? ""
            let a = (dict["a"] as? String) ?? ""
            let b = (dict["b"] as? String) ?? ""
            saveQueue.async { [weak self] in
                let result: String = autoreleasepool {
                    if op == "drive" {
                        return PBLocal.shared.drive(body: a)
                    } else if op == "saveImage" {
                        return PBLocal.shared.saveImage(fileName: a, base64: b)
                    } else {
                        return "{\"ok\":false,\"error\":\"Unknown request\"}"
                    }
                }
                DispatchQueue.main.async {
                    guard let self = self, id != 0 else { return }
                    let literal = (try? JSONSerialization.data(withJSONObject: [result], options: []))
                        .flatMap { String(data: $0, encoding: .utf8) } ?? "[\"{}\"]"
                    self.webView?.evaluateJavaScript("window.__pbSaveResolve && window.__pbSaveResolve(\(id), (\(literal))[0]);", completionHandler: nil)
                }
            }
        } else if message.name == "pbBt", let dict = message.body as? [String: Any] {
            // Bluetooth LE receipt printer (window.__BTBridge): answered later through window.__pbBtResolve
            BtPrinterBridge.shared.handle(
                id: (dict["id"] as? NSNumber)?.intValue ?? 0,
                op: (dict["op"] as? String) ?? "",
                args: (dict["args"] as? [String: Any]) ?? [:]
            )
        } else if message.name == "pbCam", let dict = message.body as? [String: Any] {
            let id = (dict["id"] as? NSNumber)?.intValue ?? 0
            let op = (dict["op"] as? String) ?? ""
            let args = (dict["args"] as? [String: Any]) ?? [:]

            let reply: ([String: Any]) -> Void = { [weak self] obj in
                guard id != 0 else { return }
                let json = (try? JSONSerialization.data(withJSONObject: obj, options: []))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? "{\"ok\":false}"
                DispatchQueue.main.async {
                    self?.webView?.evaluateJavaScript("window.__pbCamResolve && window.__pbCamResolve(\(id), \(json));", completionHandler: nil)
                }
            }

            switch op {
            case "list":
                reply(["ok": true, "devices": NativeCameraBridge.shared.listDevices()])
            case "open":
                let devId = args["deviceId"] as? String
                let preset = (args["preset"] as? String) ?? "auto"
                NativeCameraBridge.shared.open(deviceId: devId, presetName: preset) { res in
                    reply(res)
                }
            case "stop":
                NativeCameraBridge.shared.stop {
                    reply(["ok": true])
                }
            case "capture":
                NativeCameraBridge.shared.capturePhoto { res in
                    reply(res)
                }
            case "layout":
                let visible = (args["visible"] as? Bool) ?? false
                let x = CGFloat((args["x"] as? NSNumber)?.doubleValue ?? 0)
                let y = CGFloat((args["y"] as? NSNumber)?.doubleValue ?? 0)
                let w = CGFloat((args["w"] as? NSNumber)?.doubleValue ?? 0)
                let h = CGFloat((args["h"] as? NSNumber)?.doubleValue ?? 0)
                let mirror = (args["mirror"] as? Bool) ?? false
                let radius = CGFloat((args["radius"] as? NSNumber)?.doubleValue ?? 0)
                let bg = args["bg"] as? String
                NativeCameraBridge.shared.updateLayout(visible: visible, x: x, y: y, w: w, h: h, mirror: mirror, radius: radius, bgHex: bg)
            case "filter":
                let f = (args["filter"] as? String) ?? "none"
                let soft = (args["softSkin"] as? Bool) ?? false
                NativeCameraBridge.shared.setFilter(filterKey: f, softSkin: soft)
            case "customLut":
                let lutId = (args["id"] as? String) ?? ""
                let size = (args["size"] as? NSNumber)?.intValue ?? 0
                let rgba = (args["rgba"] as? String) ?? ""
                NativeCameraBridge.shared.setCustomLut(id: lutId, dimension: size, rgbaBase64: rgba)
            case "prepareAudio":
                NativeCameraBridge.shared.prepareAudio { res in
                    reply(res)
                }
            case "releaseAudio":
                NativeCameraBridge.shared.releaseAudio {
                    reply(["ok": true])
                }
            case "startVideo":
                let maxW = (args["maxWidth"] as? NSNumber)?.intValue ?? 1280
                let br = (args["bitrate"] as? NSNumber)?.intValue ?? 2_200_000
                let mir = (args["mirror"] as? Bool) ?? false
                let f = (args["filter"] as? String) ?? "none"
                let soft = (args["softSkin"] as? Bool) ?? false
                NativeCameraBridge.shared.startVideoRecording(maxWidth: maxW, bitrate: br, mirror: mir, filter: f, softSkin: soft) { res in
                    reply(res)
                }
            case "stopVideo":
                NativeCameraBridge.shared.stopVideoRecording { res in
                    reply(res)
                }
            default:
                reply(["ok": false, "error": "Unknown camera command"])
            }
        } else if message.name == "pbSpinArm" {
            var ctx = PBLocal.SpinCloudContext()
            ctx.licence = AppLicence.shared.currentLicenceString() ?? ""
            ctx.mid = AppLicence.shared.machineId()
            ctx.standaloneAllowed = hasSpin360Entitlement()
            if let dict = message.body as? [String: Any] {
                ctx.folderKey = (dict["folderKey"] as? String) ?? ""
                ctx.eventName = (dict["eventName"] as? String) ?? ""
                ctx.driveFolderId = (dict["driveFolderId"] as? String) ?? ""
                ctx.opKey = (dict["opKey"] as? String) ?? ""
            }
            PBLocal.shared.spinContext = ctx
            openSpinArmCamera()
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        switch prompt {
        case "__PBLocal_drive_sync__":
            completionHandler(PBLocal.shared.drive(body: defaultText ?? "{}"))
        case "__PBLocal_lanBase_sync__":
            completionHandler(PBLocal.shared.lanBase())
        case "__PBLocal_localBase_sync__":
            completionHandler(PBLocal.shared.localBase())
        case "__PBLocal_isOnline_sync__":
            completionHandler(PBLocal.shared.isOnline() ? "1" : "0")
        case "__PBLocal_saveImage_sync__":
            if let raw = defaultText?.data(using: .utf8),
               let obj = (try? JSONSerialization.jsonObject(with: raw, options: [])) as? [String: Any] {
                let fn = (obj["fileName"] as? String) ?? "photobooth4u.png"
                let b64 = (obj["base64"] as? String) ?? ""
                completionHandler(PBLocal.shared.saveImage(fileName: fn, base64: b64))
            } else {
                completionHandler("{\"ok\":false,\"error\":\"Bad image payload\"}")
            }
        case "__PBVoice_voices_sync__":
            completionHandler(VoiceBridge.shared.voicesJson(lang: defaultText ?? "en"))
        case "__PBPrint_sync__":
            completionHandler(handleNativePrint(payloadJson: defaultText ?? "{}"))
        case "__PBPrint_saved_sync__":
            completionHandler(savedAirPrintJson())
        case "__PBNet_list_sync__":
            completionHandler(tcpPrintersListJson())
        case "__PBNet_addByIp_sync__":
            completionHandler(addTcpPrinterByIp(defaultText ?? ""))
        case "__PBNet_forget_sync__":
            forgetTcpPrinter(defaultText ?? "")
            completionHandler("ok")
        default:
            var done = false
            let finish: (String?) -> Void = { val in
                guard !done else { return }
                done = true
                completionHandler(val)
            }
            guard let presenter = topAlertPresenter() else {
                finish(nil)
                return
            }
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                finish(alert.textFields?.first?.text)
            })
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                finish(nil)
            })
            presenter.present(alert, animated: true)
        }
    }

    private func topAlertPresenter() -> UIViewController? {
        guard view.window != nil else { return nil }
        var top: UIViewController = self
        while let next = top.presentedViewController {
            if next.isBeingDismissed { return nil }
            top = next
        }
        if top.isBeingPresented || top.isBeingDismissed { return nil }
        return top
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        var done = false
        let finish = {
            guard !done else { return }
            done = true
            completionHandler()
        }
        guard let presenter = topAlertPresenter() else {
            finish()
            return
        }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in finish() })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        var done = false
        let finish: (Bool) -> Void = { val in
            guard !done else { return }
            done = true
            completionHandler(val)
        }
        guard let presenter = topAlertPresenter() else {
            finish(false)
            return
        }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in finish(true) })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in finish(false) })
        presenter.present(alert, animated: true)
    }

    @available(iOS 15.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // A link with a "download" name (a backup file, a saved photo, an exported list): download it, then offer the share sheet.
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let host = (url.host ?? "").lowercased()
        let path = url.path

        if host == "localhost" || host == "127.0.0.1" {
            let isGallery = path.hasPrefix("/e/") || path.hasPrefix("/o/")
            backToBoothBtn?.isHidden = !isGallery
            webView.scrollView.isScrollEnabled = true
            decisionHandler(.allow)
            return
        }

        if url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
            return
        }

        if let sch = url.scheme?.lowercased(), ["whatsapp", "sms", "mailto"].contains(sch) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
            return
        }

        decisionHandler(.allow)
    }

    // A response the web view cannot show (a zip, a PDF it was told to save) or one marked "attachment" is downloaded too.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition")?.lowercased(),
           disposition.contains("attachment") {
            decisionHandler(.download)
            return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    // MARK: - Downloads (WKDownload) -> share sheet

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
        activeDownloads.append(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
        activeDownloads.append(download)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("pb4u-download-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            completionHandler(nil)
            return
        }
        // Only the file name part, never a path the page could steer outside the folder.
        var name = (suggestedFilename as NSString).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name == "." || name == ".." { name = "photobooth4u-file" }
        let dest = folder.appendingPathComponent(name)
        downloadFiles[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        activeDownloads.removeAll { $0 === download }
        guard let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) else { return }
        presentShareSheet(for: file)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        activeDownloads.removeAll { $0 === download }
        if let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        let alert = UIAlertController(title: "Could not save the file", message: "The file could not be downloaded. Please try again.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        topAlertPresenter()?.present(alert, animated: true)
    }

    private func presentShareSheet(for file: URL, attempt: Int = 0) {
        guard let presenter = topAlertPresenter() else {
            if attempt < 8 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                    self?.presentShareSheet(for: file, attempt: attempt + 1)
                }
            } else {
                try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            }
            return
        }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        // On an iPad the share sheet is a pop-over: anchor it in the middle of the screen.
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        presenter.present(sheet, animated: true)
    }

    // MARK: - Pop-up links (window.open)

    // The page opens a few links in a new window (the pay-tickets page, the lifetime-code page, other websites). A web view
    // has no extra windows, so nothing happened. Websites now open in Safari; the booth's own website pages (the iPad only
    // serves the booth itself) open from the real website.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        let scheme = (url.scheme ?? "").lowercased()
        guard scheme == "http" || scheme == "https" else { return nil }
        let host = (url.host ?? "").lowercased()
        if host == "localhost" || host == "127.0.0.1" {
            let path = url.path
            if path.hasPrefix("/e/") || path.hasPrefix("/o/") {
                webView.load(navigationAction.request)      // a photo gallery: show it in this window (it has the Back to Booth button)
                return nil
            }
            if var parts = URLComponents(string: AppLicence.serverUrl) {
                parts.path = path
                parts.query = url.query
                if let site = parts.url { UIApplication.shared.open(site, options: [:], completionHandler: nil) }
            }
            return nil
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        return nil
    }

    // The page was (re)loaded: tell it whether the Bluetooth printer is still connected and sync cached native state.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navRetryCount = 0
        navRetryWorkItem?.cancel()
        navRetryWorkItem = nil
        loadWatchdogWorkItem?.cancel()
        loadWatchdogWorkItem = nil
        loadStartedAt = nil
        BtPrinterBridge.shared.pushState()
        pushCachedBridgeState()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loadWatchdogWorkItem?.cancel()
        loadWatchdogWorkItem = nil
        loadStartedAt = nil
        navRetryCount = 0
        NativeCameraBridge.shared.resetForPageReload()
        if UIApplication.shared.applicationState == .background {
            pendingReloadOnActive = true
            return
        }
        IccCameraHelper.shared.ensureListening(forceRestart: true)
        LocalShareServer.shared.ensureListening(forceRestart: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self = self, self.gateContainer == nil else { return }
            self.loadBooth()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        recoverIfOtaFailed(error: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        recoverIfOtaFailed(error: error)
    }

    private func recoverIfOtaFailed(error: Error) {
        let nsErr = error as NSError
        if nsErr.domain == NSURLErrorDomain && nsErr.code == NSURLErrorCancelled { return }
        loadWatchdogWorkItem?.cancel()
        loadWatchdogWorkItem = nil
        loadStartedAt = nil
        IccCameraHelper.shared.ensureListening(forceRestart: true)
        if loadedViaOta {
            clearOtaCache()
            loadBooth()
            return
        }
        guard gateContainer == nil, navRetryCount < 5 else { return }
        navRetryCount += 1
        let delays: [TimeInterval] = [0.35, 0.8, 1.5, 2.5, 4.0]
        let delay = delays[min(navRetryCount - 1, delays.count - 1)]
        navRetryWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self, self.gateContainer == nil else { return }
            if UIApplication.shared.applicationState == .background {
                self.pendingReloadOnActive = true
                return
            }
            IccCameraHelper.shared.ensureListening(forceRestart: true)
            self.loadBooth()
        }
        navRetryWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }
}

// MARK: - IPP over HTTP (Wi-Fi photo printers that are not AirPrint, e.g. Epson L8050)

/// A small IPP client: asks a printer what it can do (Get-Printer-Attributes) and sends a photo (Print-Job) as JPEG over
/// HTTP on port 631. It builds the same requests as the Android app (NetPrintBridge.kt), so a printer that works there works here.
enum IppNet {
    struct Failure: Error {
        let message: String
        /// True when the connection never opened, so nothing at all reached the printer: sending again cannot print twice.
        let unreached: Bool
        init(_ message: String, unreached: Bool = false) {
            self.message = message
            self.unreached = unreached
        }
    }

    struct Caps {
        var model = ""
        var path = "/ipp/print"
        var formats: [String] = []
        var qualities: [Int] = []
        var colorModes: [String] = []
        var mediaTypes: [String] = []
        var mediaSupported: [String] = []
        var mediaReady: [String] = []
        var stateReasons: [String] = []          // printer-state-reasons: "media-empty-error", "media-jam-error" ...
        var serviceName = ""                     // printer-dns-sd-name: how the printer is listed by name on the network (Bonjour)
        var borderlessCap = false
    }

    struct Reply {
        let http: Int
        let ipp: Int
        let body: Data
    }

    private final class Box {
        var reply: Reply?
        var error: String?
        var unreached = false
    }

    private struct Writer {
        var d = Data()
        mutating func u8(_ v: Int) { d.append(UInt8(truncatingIfNeeded: v)) }
        mutating func u16(_ v: Int) { u8(v >> 8); u8(v) }
        mutating func u32(_ v: Int) { u16(v >> 16); u16(v) }
        mutating func str(_ s: String) { let b = Array(s.utf8); u16(b.count); d.append(contentsOf: b) }
        mutating func attr(_ tag: Int, _ name: String, _ value: String) { u8(tag); str(name); str(value) }
        mutating func member(_ name: String) { u8(0x4a); u16(0); str(name) }
        mutating func memberInt(_ name: String, _ v: Int) { member(name); u8(0x21); u16(0); u16(4); u32(v) }
    }

    /// Where printers keep their IPP queue, most common first.
    static let paths = ["/ipp/print", "/ipp", "/", "/ipp/printer", "/printer"]

    // MARK: requests

    static func capsRequest(uri: String) -> Data {
        var w = Writer()
        w.u16(0x0200); w.u16(0x000B); w.u16(0); w.u16(1)          // IPP 2.0, Get-Printer-Attributes, request id 1
        w.u8(0x01)
        w.attr(0x47, "attributes-charset", "utf-8")
        w.attr(0x48, "attributes-natural-language", "en")
        w.attr(0x45, "printer-uri", uri)
        w.attr(0x44, "requested-attributes", "printer-make-and-model")
        let wanted = ["document-format-supported", "print-quality-supported", "print-color-mode-supported", "media-type-supported",
                      "media-supported", "media-ready", "printer-state-reasons", "printer-dns-sd-name",
                      "media-top-margin-supported", "media-bottom-margin-supported", "media-left-margin-supported", "media-right-margin-supported"]
        for n in wanted { w.u8(0x44); w.u16(0); w.str(n) }
        w.u8(0x03)
        return w.d
    }

    static func printJobRequest(uri: String, job: String, doc: Data, wMm: Double, hMm: Double, mediaName: String = "", quality: Int,
                                colorMode: String, mediaType: String, scaling: String, marginMm100: Int) -> Data {
        var w = Writer()
        w.u16(0x0200); w.u16(0x0002); w.u32(1)                    // IPP 2.0, Print-Job, request id 1
        w.u8(0x01)
        w.attr(0x47, "attributes-charset", "utf-8")
        w.attr(0x48, "attributes-natural-language", "en")
        w.attr(0x45, "printer-uri", uri)
        w.attr(0x42, "requesting-user-name", "photobooth")
        w.attr(0x42, "job-name", job)
        w.attr(0x49, "document-format", "image/jpeg")
        w.u8(0x02)
        let margin = max(0, marginMm100)
        if !mediaName.isEmpty {
            w.attr(0x44, "media", mediaName)
            if !mediaType.isEmpty { w.attr(0x44, "media-type", mediaType) }
        } else if wMm > 0 {
            w.u8(0x34); w.str("media-col"); w.u16(0)             // begCollection
            w.member("media-size")
            w.u8(0x34); w.u16(0); w.u16(0)                        // nested begCollection
            w.memberInt("x-dimension", Int((min(wMm, hMm) * 100).rounded()))
            w.memberInt("y-dimension", Int((max(wMm, hMm) * 100).rounded()))
            w.u8(0x37); w.u16(0); w.u16(0)                        // end media-size
            w.memberInt("media-top-margin", margin)
            w.memberInt("media-bottom-margin", margin)
            w.memberInt("media-left-margin", margin)
            w.memberInt("media-right-margin", margin)
            if !mediaType.isEmpty { w.member("media-type"); w.u8(0x44); w.u16(0); w.str(mediaType) }
            w.u8(0x37); w.u16(0); w.u16(0)                        // end media-col
        } else if !mediaType.isEmpty {
            w.u8(0x34); w.str("media-col"); w.u16(0)
            w.member("media-type"); w.u8(0x44); w.u16(0); w.str(mediaType)
            w.u8(0x37); w.u16(0); w.u16(0)
        }
        if !scaling.isEmpty { w.attr(0x44, "print-scaling", scaling) }      // "none" for borderless: the printer must not scale or trim
        if quality != 0 { w.u8(0x23); w.str("print-quality"); w.u16(4); w.u32(quality) }    // enum
        if !colorMode.isEmpty { w.attr(0x44, "print-color-mode", colorMode) }
        w.u8(0x03)
        w.d.append(doc)
        return w.d
    }

    // MARK: network

    static func describe(_ e: URLError) -> String {
        switch e.code {
        case .timedOut:
            return "The printer took too long to answer."
        case .networkConnectionLost:
            return "The printer stopped answering while printing."
        case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet:
            return "Could not reach the printer. Check it is on, on the same Wi-Fi as this iPad, and that Local Network access is allowed for photobooth4u in the iPad Settings."
        default:
            return e.localizedDescription
        }
    }

    /// One IPP request. Returns what the printer answered (any HTTP status); throws when it could not be reached at all.
    static func post(ip: String, port: Int, path: String, body: Data, timeout: TimeInterval) throws -> Reply {
        guard let url = URL(string: "http://\(ip):\(port)\(path)") else { throw Failure("Invalid printer address.") }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/ipp", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.timeoutIntervalForResource = timeout + 20
        let session = URLSession(configuration: cfg)
        let box = Box()
        let sema = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: req) { data, resp, error in
            if let http = resp as? HTTPURLResponse {
                let d = data ?? Data()
                var code = -1
                if d.count >= 4 { code = (Int(d[d.startIndex + 2]) << 8) | Int(d[d.startIndex + 3]) }
                box.reply = Reply(http: http.statusCode, ipp: code, body: d)
            } else if let ue = error as? URLError {
                box.error = IppNet.describe(ue)
                // Only a connection that never opened is certain to have sent nothing. A timeout or a dropped connection could
                // have happened after the printer took the photo, so those are never treated as "safe to send again".
                box.unreached = (ue.code == .cannotConnectToHost || ue.code == .cannotFindHost || ue.code == .dnsLookupFailed)
            } else {
                box.error = error?.localizedDescription ?? "The printer did not answer."
            }
            sema.signal()
        }
        task.resume()
        sema.wait()
        session.finishTasksAndInvalidate()
        if let r = box.reply { return r }
        throw Failure(box.error ?? "The printer did not answer.", unreached: box.unreached)
    }

    /// Walks an IPP response and hands every attribute value to the callback (name, value tag, value bytes).
    static func parse(_ b: Data, _ cb: (String, Int, [UInt8]) -> Void) {
        let bytes = [UInt8](b)
        var p = 8
        var last = ""
        func u16(_ i: Int) -> Int { return (Int(bytes[i]) << 8) | Int(bytes[i + 1]) }
        while p < bytes.count {
            let tag = Int(bytes[p])
            p += 1
            if tag == 0x03 { return }
            if tag <= 0x05 { continue }                            // group delimiter
            if p + 2 > bytes.count { return }
            let nl = u16(p)
            p += 2
            if p + nl + 2 > bytes.count { return }
            if nl > 0 {
                last = String(decoding: bytes[p..<(p + nl)], as: UTF8.self)
                p += nl
            }
            let vl = u16(p)
            p += 2
            if p + vl > bytes.count { return }
            cb(last, tag, Array(bytes[p..<(p + vl)]))
            p += vl
        }
    }

    enum Probe {
        case ok(Caps)                // it answered and told us what it is
        case noIpp                   // it is on the network but does not answer IPP questions
        case unreachable             // no answer at all
    }

    /// Asks the printer who it is, what it can print and how it is. Nothing is printed.
    static func probe(ip: String, port: Int) -> Probe {
        for path in paths {
            let uri = "ipp://\(ip):\(port)\(path)"
            let reply: Reply
            do {
                reply = try post(ip: ip, port: port, path: path, body: capsRequest(uri: uri), timeout: 6)
            } catch {
                return .unreachable                                // not reachable: the other paths will not be either
            }
            if reply.http != 200 || reply.ipp < 0 || reply.ipp > 2 { continue }
            var c = Caps()
            c.path = path
            parse(reply.body) { name, tag, raw in
                let value = String(decoding: raw, as: UTF8.self)
                if name == "document-format-supported" && tag == 0x49 { c.formats.append(value.lowercased()) }
                if name == "printer-make-and-model" && (tag == 0x41 || tag == 0x42) && c.model.isEmpty { c.model = value }
                if name == "print-quality-supported" && tag == 0x23 && raw.count == 4 { c.qualities.append(Int(raw[3])) }
                if name == "print-color-mode-supported" && tag == 0x44 { c.colorModes.append(value) }
                if name == "media-type-supported" && (tag == 0x44 || tag == 0x42) { c.mediaTypes.append(value) }
                if name == "media-supported" && (tag == 0x44 || tag == 0x42) { c.mediaSupported.append(value) }
                if name == "media-ready" && (tag == 0x44 || tag == 0x42) { c.mediaReady.append(value) }
                if name == "printer-state-reasons" && tag == 0x44 { c.stateReasons.append(value) }
                if name == "printer-dns-sd-name" && (tag == 0x41 || tag == 0x42) && c.serviceName.isEmpty { c.serviceName = value }
                if name.hasSuffix("-margin-supported") && tag == 0x21 && raw.count == 4 {
                    let v = (Int(raw[0]) << 24) | (Int(raw[1]) << 16) | (Int(raw[2]) << 8) | Int(raw[3])
                    if v == 0 { c.borderlessCap = true }
                }
            }
            return .ok(c)
        }
        return .noIpp
    }

    /// Asks the printer who it is and what it can print. nil when it does not answer IPP.
    static func fetchCaps(ip: String, port: Int) -> Caps? {
        if case .ok(let c) = probe(ip: ip, port: port) { return c }
        return nil
    }

    /// Wakes the printer up: asks again a few times, because one that is coming out of sleep needs several seconds before it answers.
    static func reach(ip: String, port: Int, tries: Int) -> Probe {
        var last: Probe = .unreachable
        let n = max(1, tries)
        for i in 0..<n {
            last = probe(ip: ip, port: port)
            if case .unreachable = last {
                if i < n - 1 { Thread.sleep(forTimeInterval: 2) }
                continue
            }
            return last
        }
        return last
    }

    /// A problem the printer reports about itself (no paper, a jam ...) in plain words, or nil when it reports none.
    static func problem(_ c: Caps) -> String? {
        func has(_ key: String) -> Bool {
            return c.stateReasons.contains(where: { $0.hasPrefix(key) && !$0.hasSuffix("-report") })
        }
        if has("media-jam") { return "The printer reports a paper jam. Clear it and the photo prints by itself." }
        if has("media-empty") { return "The printer reports it is out of paper. Load paper and the photo prints by itself." }
        if has("door-open") || has("cover-open") { return "The printer reports a cover is open. Close it and the photo prints by itself." }
        if has("marker-supply-empty") { return "The printer reports it is out of ink. Refill it and the photo prints by itself." }
        return nil
    }

    // MARK: printing

    /// Stamps the JFIF DPI header (300 or 600 dpi) so the printer does not take the picture for a small one.
    static func jpegAtDpi(_ d: Data, dpi: Int = 300) -> Data {
        let useDpi = max(72, min(2400, dpi > 0 ? dpi : 300))
        var b = [UInt8](d)
        guard b.count >= 20, b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF, b[3] == 0xE0,
              b[6] == 0x4A, b[7] == 0x46, b[8] == 0x49, b[9] == 0x46 else { return d }      // "JFIF"
        b[13] = 1                                                  // dots per inch
        b[14] = UInt8((useDpi >> 8) & 0xFF); b[15] = UInt8(useDpi & 0xFF)
        b[16] = UInt8((useDpi >> 8) & 0xFF); b[17] = UInt8(useDpi & 0xFF)
        return Data(b)
    }

    /// The IPP paper type keyword for the booth's paper choice. A printer that lists its types gets one of those; an Epson L8050
    /// does not list them in every case, so for it the standard keyword is sent anyway (a printer that refuses it is asked again without).
    static func mediaTypeKeyword(_ media: String, _ listed: [String], _ hard: Bool) -> String {
        func first(_ pred: (String) -> Bool) -> String? { return listed.first(where: pred) }
        switch media {
        case "plain":
            return first({ $0 == "stationery" }) ?? first({ $0.hasPrefix("stationery") }) ?? (hard ? "stationery" : "")
        case "inkjet":
            return first({ $0 == "stationery-inkjet" }) ?? first({ $0.lowercased().contains("inkjet") }) ?? ""
        case "photo", "photopg":
            return first({ $0 == "photographic-glossy" }) ?? first({ $0.hasPrefix("photographic") }) ?? (hard ? "photographic-glossy" : "")
        case "photosg":
            return first({ $0 == "photographic-semi-gloss" }) ?? (hard ? "photographic-semi-gloss" : "")
        case "matte":
            return first({ $0 == "photographic-matte" }) ?? (hard ? "photographic-matte" : "")
        case "":
            return ""
        default:
            return first({ $0.lowercased() == media.lowercased() }) ?? ""
        }
    }

    static func isSelphy(_ c: Caps) -> Bool {
        let s = (c.model + " " + c.serviceName).lowercased()
        if s.contains("selphy") { return true }
        for code in ["cp820", "cp910", "cp1000", "cp1200", "cp1300", "cp1500",
                     "cp 820", "cp 910", "cp 1000", "cp 1200", "cp 1300", "cp 1500",
                     "cp-820", "cp-910", "cp-1000", "cp-1200", "cp-1300", "cp-1500",
                     "cp_820", "cp_910", "cp_1000", "cp_1200", "cp_1300", "cp_1500"] {
            if s.contains(code) { return true }
        }
        return false
    }

    static func mediaDimsMm(_ rawName: String) -> (Double, Double)? {
        var s = rawName.lowercased()
        for suf in ["_borderless", "-borderless", ".borderless", "_fullbleed", "-fullbleed", "_full-bleed", "-full-bleed"] {
            if s.hasSuffix(suf) { s = String(s.dropLast(suf.count)); break }
        }
        var unit = 0.0
        if s.hasSuffix("mm") { unit = 1.0; s = String(s.dropLast(2)) }
        else if s.hasSuffix("in") { unit = 25.4; s = String(s.dropLast(2)) }
        else { return nil }
        guard let us = s.lastIndex(of: "_") else { return nil }
        let dimPart = s[s.index(after: us)...]
        let parts = dimPart.split(separator: "x")
        guard parts.count == 2, let a = Double(parts[0]), let b = Double(parts[1]), a > 0, b > 0 else { return nil }
        let w = a * unit, h = b * unit
        return (min(w, h), max(w, h))
    }

    /// Matches the booth's requested mm size (e.g. 4x6 = 101.6x152.4 mm) to the printer's own loaded/supported paper within 6 mm
    /// (e.g. Canon SELPHY CP1300 / CP1500 Postcard jpn_hagaki_100x148mm = 100x148 mm).
    static func selphyMedia(_ c: Caps, wMm: Double, hMm: Double) -> (name: String, w: Double, h: Double)? {
        guard wMm > 0, hMm > 0 else { return nil }
        let wantW = min(wMm, hMm), wantH = max(wMm, hMm)
        func best(in list: [String]) -> (String, Double, Double)? {
            var found: (String, Double, Double)? = nil
            var bestDiff = 6.0
            for n in list {
                guard let (mw, mh) = mediaDimsMm(n) else { continue }
                let d = max(abs(mw - wantW), abs(mh - wantH))
                if d <= bestDiff && (found == nil || d < bestDiff - 0.01) {
                    bestDiff = d
                    found = (n, mw, mh)
                }
            }
            return found
        }
        if let r = best(in: c.mediaReady) { return (r.0, r.1, r.2) }
        if let s = best(in: c.mediaSupported) { return (s.0, s.1, s.2) }
        if isSelphy(c) {
            if abs(wantW - 54) < 8 && abs(wantH - 86) < 8 { return ("om_card_54x86mm", 54, 86) }
            if abs(wantW - 89) < 8 && abs(wantH - 119) < 8 { return ("oe_photo-l_3.5x5in", 89, 119) }
            if abs(wantW - 100) < 8 && abs(wantH - 148) < 8 { return ("jpn_hagaki_100x148mm", 100, 148) }
        }
        return nil
    }

    private struct JobAttempt {
        let wMm: Double
        let hMm: Double
        let mediaName: String
        let useOpts: Bool
        let scaling: String
        let marginMm100: Int
    }

    /// Prints one photo. Tries the page size with the quality / paper settings first, then drops them one at a time if the
    /// printer refuses. Retries the same request when a dye-sub printer answers 0x0507 (server-error-busy) mid-ribbon-cycle.
    @discardableResult
    static func printPage(ip: String, port: Int, jpegIn: Data, job: String, wMm: Double, hMm: Double,
                          quality: String, color: String, media: String, borderless: Bool, dpi: Int = 300, known: Caps? = nil) throws -> Int? {
        let jpeg = jpegAtDpi(jpegIn, dpi: dpi)
        let found: Caps? = known ?? fetchCaps(ip: ip, port: port)
        let caps = found ?? Caps()
        let selphy = isSelphy(caps)
        let hardEpsonL = !selphy && caps.model.range(of: "L8050", options: .caseInsensitive) != nil
        var q = 0
        if !selphy {
            if quality == "draft" { q = 3 } else if quality == "normal" { q = 4 } else if quality == "high" || quality == "high720" { q = 5 }
        }
        let qv = (q != 0 && (caps.qualities.contains(q) || hardEpsonL)) ? q : 0
        var cm = ""
        if color == "mono" && caps.colorModes.contains("monochrome") { cm = "monochrome" }
        else if color == "color" && caps.colorModes.contains("color") { cm = "color" }
        let mt = selphy ? "" : mediaTypeKeyword(media, caps.mediaTypes, hardEpsonL)
        let hasOpts = qv != 0 || !cm.isEmpty || !mt.isEmpty
        var attempts: [JobAttempt] = []
        if selphy, let matched = selphyMedia(caps, wMm: wMm, hMm: hMm) {
            // Canon SELPHY CP1300 / CP1500 fullbleed over IPP uses its exact paper dimensions (e.g. 100x148 mm) with 0 margins and scaling=fill.
            attempts = [
                JobAttempt(wMm: matched.w, hMm: matched.h, mediaName: "", useOpts: false, scaling: "fill", marginMm100: 0),
                JobAttempt(wMm: matched.w, hMm: matched.h, mediaName: "", useOpts: false, scaling: "", marginMm100: 0),
                JobAttempt(wMm: 0, hMm: 0, mediaName: matched.name, useOpts: false, scaling: "fill", marginMm100: 0),
                JobAttempt(wMm: 0, hMm: 0, mediaName: matched.name, useOpts: false, scaling: "", marginMm100: 0),
                JobAttempt(wMm: 0, hMm: 0, mediaName: "", useOpts: false, scaling: "", marginMm100: 0)
            ]
        } else {
            let ownScaling = borderless ? "none" : "fill"
            let rawAttempts: [(Bool, Bool, String, Int)]
            if hasOpts {
                rawAttempts = borderless
                    ? [(true, true, ownScaling, 0), (true, true, "", 0), (true, true, "fill", 300),
                       (true, false, ownScaling, 0), (true, false, "", 0), (true, false, "fill", 300),
                       (false, true, "", 0), (false, false, "", 0)]
                    : [(true, true, ownScaling, 0), (true, true, "", 0), (true, false, ownScaling, 0),
                       (true, false, "", 0), (false, true, "", 0), (false, false, "", 0)]
            } else {
                rawAttempts = borderless
                    ? [(true, false, ownScaling, 0), (true, false, "", 0), (true, false, "fill", 300), (false, false, "", 0)]
                    : [(true, false, ownScaling, 0), (true, false, "", 0), (false, false, "", 0)]
            }
            attempts = rawAttempts.map { JobAttempt(wMm: $0.0 ? wMm : 0, hMm: hMm, mediaName: "", useOpts: $0.1, scaling: $0.2, marginMm100: $0.3) }
        }
        let pathList: [String] = found == nil ? paths : [caps.path]
        var lastErr = "The printer didn't accept the job."
        for at in attempts {
            for path in pathList {
                let uri = "ipp://\(ip):\(port)\(path)"
                let body = printJobRequest(uri: uri, job: job, doc: jpeg, wMm: at.wMm, hMm: at.hMm, mediaName: at.mediaName,
                                           quality: at.useOpts ? qv : 0, colorMode: at.useOpts ? cm : "", mediaType: at.useOpts ? mt : "",
                                           scaling: at.scaling, marginMm100: at.marginMm100)
                var r = try post(ip: ip, port: port, path: path, body: body, timeout: 90)
                var busyTries = 0
                while r.http == 200 && r.ipp == 0x0507 && busyTries < 24 {
                    Thread.sleep(forTimeInterval: 2.5)
                    r = try post(ip: ip, port: port, path: path, body: body, timeout: 90)
                    busyTries += 1
                }
                if r.http == 200 && r.ipp >= 0 && r.ipp <= 2 { return jobId(r.body) }
                if r.http == 200 && r.ipp == 0x0507 {
                    throw Failure("The printer is still busy with the previous photo (code 0x507). Wait for it to finish, then print again.")
                }
                if r.http == 200 && r.ipp == 0x406 {
                    lastErr = "The printer says it has no print queue (code 0x406). Check that IPP / AirPrint is turned on for it."
                } else if r.http == 200 {
                    lastErr = "The printer refused the photo (code 0x" + String(r.ipp, radix: 16) + ")."
                } else if r.http == 426 || r.http == 301 || r.http == 302 {
                    lastErr = "This printer only accepts secure printing, which the app doesn't support yet."
                } else if r.http != 404 {
                    lastErr = "The printer answered with HTTP \(r.http)."
                }
            }
        }
        throw Failure(lastErr)
    }

    // MARK: watching a job after the printer took it

    /// The job number the printer gave a photo it accepted.
    static func jobId(_ body: Data) -> Int? {
        var id: Int? = nil
        parse(body) { name, tag, raw in
            if name == "job-id" && tag == 0x21 && raw.count == 4 && id == nil {
                id = (Int(raw[0]) << 24) | (Int(raw[1]) << 16) | (Int(raw[2]) << 8) | Int(raw[3])
            }
        }
        return id
    }

    static func jobStateRequest(uri: String, jobId: Int) -> Data {
        var w = Writer()
        w.u16(0x0200); w.u16(0x0009); w.u32(2)                    // IPP 2.0, Get-Job-Attributes, request id 2
        w.u8(0x01)
        w.attr(0x47, "attributes-charset", "utf-8")
        w.attr(0x48, "attributes-natural-language", "en")
        w.attr(0x45, "printer-uri", uri)
        w.u8(0x21); w.str("job-id"); w.u16(4); w.u32(jobId)
        w.attr(0x44, "requested-attributes", "job-state")
        w.u8(0x03)
        return w.d
    }

    enum JobCheck {
        case state(Int)              // 3 waiting, 4 held, 5 printing, 6 stopped, 7 cancelled, 8 aborted, 9 done
        case gone                    // done and forgotten by the printer, or it cannot tell: nothing more to learn
        case unreachable             // no answer this time (a printer that is busy printing often ignores the network for a while)
    }

    static func jobCheck(ip: String, port: Int, path: String, jobId: Int) -> JobCheck {
        let uri = "ipp://\(ip):\(port)\(path)"
        let reply: Reply
        do {
            reply = try post(ip: ip, port: port, path: path, body: jobStateRequest(uri: uri, jobId: jobId), timeout: 8)
        } catch {
            return .unreachable
        }
        if reply.http != 200 || reply.ipp < 0 || reply.ipp > 2 { return .gone }
        var st = 0
        parse(reply.body) { name, tag, raw in
            if name == "job-state" && tag == 0x23 && raw.count == 4 { st = Int(raw[3]) }
        }
        return st == 0 ? .gone : .state(st)
    }

    /// Waits between multi-sheet IPP prints on a Canon SELPHY so the next sheet does not collide with the 4-pass dye-sub cycle.
    static func waitJobIdle(ip: String, port: Int, path: String, jobId: Int?, maxSeconds: TimeInterval = 75) {
        Thread.sleep(forTimeInterval: 1.5)
        guard let id = jobId, id > 0 else {
            Thread.sleep(forTimeInterval: 4.0)
            return
        }
        let started = Date()
        while Date().timeIntervalSince(started) < maxSeconds {
            switch jobCheck(ip: ip, port: port, path: path, jobId: id) {
            case .gone:
                return
            case .state(let st) where st >= 7:
                return
            case .unreachable, .state:
                Thread.sleep(forTimeInterval: 2.0)
            }
        }
    }

    /// Follows the photos after the printer took them. Returns a plain-language warning when one did not print, and nil when
    /// all is well. It stays silent when it cannot tell (a printer that never answers questions about a job proves nothing).
    static func watchJobs(ip: String, port: Int, path: String, ids: [Int], maxSeconds: TimeInterval) -> String? {
        var open = ids
        let started = Date()
        var stoppedSince: Date? = nil
        var sawItWaiting = false
        while !open.isEmpty && Date().timeIntervalSince(started) < maxSeconds {
            Thread.sleep(forTimeInterval: 4)
            var still: [Int] = []
            var anyStopped = false
            for id in open {
                switch jobCheck(ip: ip, port: port, path: path, jobId: id) {
                case .unreachable:
                    still.append(id)
                case .gone:
                    break
                case .state(let st):
                    if st == 7 || st == 8 {
                        return "The printer dropped a photo before it finished printing. Check it for paper, ink or an error message, then print again."
                    }
                    if st != 9 {
                        still.append(id)
                        sawItWaiting = true
                        if st == 6 { anyStopped = true }
                    }
                }
            }
            open = still
            if anyStopped {
                if stoppedSince == nil { stoppedSince = Date() }
            } else {
                stoppedSince = nil
            }
            if let s = stoppedSince, Date().timeIntervalSince(s) > 20 {
                return "The printer has paused printing. Check it for paper, ink, a jam or an error message. It carries on by itself once that is fixed."
            }
        }
        if !open.isEmpty && sawItWaiting {
            return "The printer has not finished printing. Check it is on and has paper and ink."
        }
        return nil
    }

    // MARK: finding a printer again by its name

    private final class FindBox {
        private let lock = NSLock()
        private var ep: NWEndpoint?
        private var addr: String?
        var endpoint: NWEndpoint? { lock.lock(); defer { lock.unlock() }; return ep }
        var address: String? { lock.lock(); defer { lock.unlock() }; return addr }
        /// true the first time only
        func setEndpoint(_ e: NWEndpoint) -> Bool {
            lock.lock(); defer { lock.unlock() }
            if ep != nil { return false }
            ep = e
            return true
        }
        func setAddress(_ a: String) { lock.lock(); addr = a; lock.unlock() }
    }

    /// Looks for the printer on the network by the name it is listed under (Bonjour), so a new address, when the router gave it a
    /// different one, is found again. Returns its IPv4 address, or nil when it is not seen within the wait.
    static func findByName(_ name: String, serviceType: String = "_ipp._tcp", wait: TimeInterval) -> String? {
        let want = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if want.isEmpty { return nil }
        let box = FindBox()
        let q = DispatchQueue(label: "com.photobooth4u.ipp.find")
        let seen = DispatchSemaphore(value: 0)
        let browser = NWBrowser(for: .bonjour(type: serviceType, domain: nil), using: .tcp)
        browser.browseResultsChangedHandler = { results, _ in
            for r in results {
                if case let .service(n, _, _, _) = r.endpoint {
                    let have = n.lowercased()
                    if have == want || have.hasPrefix(want) {
                        if box.setEndpoint(r.endpoint) { seen.signal() }
                        return
                    }
                }
            }
        }
        browser.start(queue: q)
        let got = seen.wait(timeout: .now() + wait)
        browser.cancel()
        guard got == .success, let ep = box.endpoint else { return nil }

        // Connect to it once to learn which IPv4 address that name stands for right now.
        let params = NWParameters.tcp
        if let ipOpts = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ipOpts.version = .v4 }
        let conn = NWConnection(to: ep, using: params)
        let done = DispatchSemaphore(value: 0)
        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                if let remote = conn.currentPath?.remoteEndpoint, case let .hostPort(host, _) = remote, case let .ipv4(a) = host {
                    box.setAddress(a.rawValue.map { String($0) }.joined(separator: "."))
                }
                done.signal()
            case .failed, .cancelled:
                done.signal()
            default:
                break
            }
        }
        conn.start(queue: q)
        _ = done.wait(timeout: .now() + 6)
        conn.cancel()
        return box.address
    }
}
