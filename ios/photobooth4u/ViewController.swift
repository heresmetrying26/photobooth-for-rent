import UIKit
import WebKit
import AVFoundation
import CryptoKit
import Network

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
    private var airPrintBusy = false
    private var airPrintQueue: [(jobName: String, ptW: Double, ptH: Double, pdfData: Data)] = []
    // Photo saves run here, one at a time and off the main thread, so the camera picture and the screen keep moving.
    private let saveQueue = DispatchQueue(label: "com.photobooth4u.save", qos: .userInitiated)
    private let otaHashKey = "pb4u_ota_hash"
    private let otaBundledHashKey = "pb4u_ota_bundled_hash"
    private let airprintUrlKey = "pb4u_airprint_url"
    private let airprintNameKey = "pb4u_airprint_name"
    private let tcpPrintersKey = "pb4u_tcp_printers"

    override var prefersStatusBarHidden: Bool { return true }
    override var prefersHomeIndicatorAutoHidden: Bool { return true }

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

        // 3. Push network state asynchronously to JS (avoids synchronous prompt IPC in navigator.onLine)
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
                }
            }
        }
    }

    deinit {
        checkinTimer?.invalidate()
    }

    private func requestMediaPermissionsAndBoot() {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
        }
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { [weak self] _ in
                DispatchQueue.main.async {
                    self?.bootWithLicence()
                }
            }
        } else {
            bootWithLicence()
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
        userContent.add(self, name: "pbPrintRawTcp")
        userContent.add(self, name: "pbPrintIpp")
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
              savePend[id] = resolve;
              try {
                window.webkit.messageHandlers.pbSave.postMessage({ id: id, op: op, a: a, b: b });
              } catch (e) {
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
              var res = prompt('__PBLocal_lanBase_sync__', '');
              return res || '';
            },
            localBase: function() {
              var res = prompt('__PBLocal_localBase_sync__', '');
              return res || '';
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
            openSpinArm: function() {
              try { window.webkit.messageHandlers.pbSpinArm.postMessage({}); } catch (e) {}
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
              var res = prompt('__PBVoice_voices_sync__', String(lang || 'en'));
              return res || '[]';
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
              var payload = JSON.stringify({
                jobName: String(jobName || 'Photobooth'),
                widthMm: Number(widthMm) || 101.6,
                heightMm: Number(heightMm) || 152.4,
                pagesJson: String(pagesJson || '[]')
              });
              var res = prompt('__PBPrint_sync__', payload);
              return res || '{"ok":false,"error":"Print failed"}';
            },
            pickAirPrint: function() {
              try { window.webkit.messageHandlers.pbPickAirPrint.postMessage({}); } catch (e) {}
            },
            clearAirPrint: function() {
              try { window.webkit.messageHandlers.pbClearAirPrint.postMessage({}); } catch (e) {}
            },
            savedAirPrint: function() {
              var res = prompt('__PBPrint_saved_sync__', '');
              return res || '{}';
            }
          };

          window.__PBNet = {
            list: function() {
              var res = prompt('__PBNet_list_sync__', '');
              return res || '{"printers":[],"scanning":false}';
            },
            scan: function() {},
            addByIp: function(ip) {
              var res = prompt('__PBNet_addByIp_sync__', String(ip || ''));
              return res || 'Invalid IP';
            },
            forgetIp: function(ip) {
              try { prompt('__PBNet_forget_sync__', String(ip || '')); } catch (e) {}
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
            version: function() { return window.__pbIosAppVer || '1.1.12'; },
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
                camPend[id] = resolve;
                try {
                  window.webkit.messageHandlers.pbCam.postMessage({ id: id, op: op, args: args || {} });
                } catch (e) {
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
        if let url = URL(string: "http://localhost:\(IccCameraHelper.port)/booth") {
            webView.load(URLRequest(url: url))
        }
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
        let debugOpt = (feat["debugOpt"] as? NSNumber)?.boolValue ?? false
        let payOpt = (feat["vouchers"] as? NSNumber)?.boolValue ?? false
        let traditional = (feat["traditional"] as? NSNumber)?.boolValue ?? true
        let orientation = (feat["orientation"] as? String) ?? "either"

        let exObj = feat["extras"] as? [String: Any] ?? [:]
        let extrasJs = ["vintage", "roving", "flipbook", "video", "spin360"].map { key in
            let on = (exObj[key] as? NSNumber)?.boolValue ?? true
            return "\(key):\(on ? "true" : "false")"
        }.joined(separator: ",")

        let expMs = (p["exp"] as? NSNumber)?.int64Value ?? 253402300799000
        let lifetime = (p["lifetime"] as? NSNumber)?.boolValue ?? false
        let deviceNo = (feat["deviceNo"] as? NSNumber)?.intValue ?? 1
        let multiDevice = (feat["multiDevice"] as? NSNumber)?.boolValue ?? false
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
        window.__PB.offline=true;
        window.__PB.type='rental';
        window.__PB.gifOpt=\(gifOpt ? "true" : "false");
        window.__PB.extras={\(extrasJs)};
        window.__PB.retakeOpt=\(retakeOpt ? "true" : "false");
        window.__PB.lockOpt=\(lockOpt ? "true" : "false");
        window.__PB.typesOpt=\(typesOpt ? "true" : "false");
        window.__PB.debugOpt=\(debugOpt ? "true" : "false");
        window.__PB.payOpt=\(payOpt ? "true" : "false");
        window.__PB.traditional=\(traditional ? "true" : "false");
        window.__PB.orientation=\(jsonStr(orientation));
        window.__PB.folderKey=\(jsonStr(folderKey));
        window.__PB.folderPrefix=\(jsonStr(folderPrefix));
        window.__PB.lockFolder=\(folderKey.isEmpty ? "false" : "true");
        window.__PB.lifetime=\(lifetime ? "true" : "false");
        window.__PB.deviceNo=\(deviceNo);
        window.__PB.multiDevice=\(multiDevice ? "true" : "false");
        window.__PB.watermark=false;
        window.__PB.exp=\(expMs);
        window.__pbIosOnline=\(PBLocal.shared.isOnline() ? "true" : "false");
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
        gateContainer?.removeFromSuperview()
        gateContainer = nil

        guard let src = activeBoothSource() else {
            let errSt = AppLicence.Status(ok: false, reason: "none", message: "Missing booth.html in app bundle.", payload: nil, warn: "")
            showActivationScreen(st: errSt)
            return
        }
        loadedViaOta = src.isOta

        IccCameraHelper.shared.ensureListening()
        LocalShareServer.shared.ensureListening()

        let pbConfig = buildPbConfigScript()
        let injected: String
        if let headRange = src.raw.range(of: "</head>", options: .caseInsensitive) {
            injected = src.raw.replacingCharacters(in: headRange, with: "\(pbConfig)\n</head>")
        } else {
            injected = pbConfig + src.raw
        }

        IccCameraHelper.shared.setBoothHtml(injected)
        if let url = URL(string: "http://localhost:\(IccCameraHelper.port)/booth") {
            webView.load(URLRequest(url: url))
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
        spinArmNote.text = "Pairs via QR to your laptop's 360 Desk · No licence needed"
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
        guard let data = payloadJson.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
              let pagesJson = obj["pagesJson"] as? String,
              let pagesData = pagesJson.data(using: .utf8),
              let pagesArr = (try? JSONSerialization.jsonObject(with: pagesData, options: [])) as? [String] else {
            return "{\"ok\":false,\"error\":\"Bad print payload\"}"
        }

        let jobName = (obj["jobName"] as? String) ?? "Photobooth"
        let widthMm = (obj["widthMm"] as? NSNumber)?.doubleValue ?? 101.6
        let heightMm = (obj["heightMm"] as? NSNumber)?.doubleValue ?? 152.4
        let ptW = max(72.0, widthMm * 72.0 / 25.4)
        let ptH = max(72.0, heightMm * 72.0 / 25.4)

        var images: [UIImage] = []
        for item in pagesArr {
            let b64: String
            if let comma = item.firstIndex(of: ",") {
                b64 = String(item[item.index(after: comma)...])
            } else {
                b64 = item
            }
            if let imgBytes = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
               let img = UIImage(data: imgBytes) {
                images.append(img)
            }
        }
        guard !images.isEmpty else {
            return "{\"ok\":false,\"error\":\"No printable pages\"}"
        }

        let pageBounds = CGRect(x: 0, y: 0, width: ptW, height: ptH)
        let renderer = UIGraphicsPDFRenderer(bounds: pageBounds)
        let pdfData = renderer.pdfData { ctx in
            for img in images {
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

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.airPrintQueue.append((jobName: jobName, ptW: ptW, ptH: ptH, pdfData: pdfData))
            self.drainAirPrintQueue()
        }
        return "{\"ok\":true}"
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
        controller.printingItem = next.pdfData
        airPrintPageSize = CGSize(width: next.ptW, height: next.ptH)
        controller.delegate = self

        let finishJob: () -> Void = { [weak self] in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.airPrintBusy = false
                self.drainAirPrintQueue()
            }
        }

        if let savedUrlStr = UserDefaults.standard.string(forKey: airprintUrlKey),
           !savedUrlStr.isEmpty,
           let savedUrl = URL(string: savedUrlStr) {
            let targetPrinter = UIPrinter(url: savedUrl)
            targetPrinter.contactPrinter { [weak self] available in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if available {
                        controller.print(to: targetPrinter) { [weak self] _, completed, err in
                            if !completed && err != nil {
                                DispatchQueue.main.async {
                                    self?.presentPrintController(controller, completion: finishJob)
                                }
                            } else {
                                finishJob()
                            }
                        }
                    } else {
                        self.presentPrintController(controller, completion: finishJob)
                    }
                }
            }
        } else {
            presentPrintController(controller, completion: finishJob)
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

    private func presentPrintController(_ controller: UIPrintInteractionController, completion: (() -> Void)? = nil) {
        let doneHandler: UIPrintInteractionController.CompletionHandler = { _, _, _ in
            completion?()
        }
        if UIDevice.current.userInterfaceIdiom == .phone {
            controller.present(animated: true, completionHandler: doneHandler)
        } else {
            let anchor = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
            controller.present(from: anchor, in: view, animated: true, completionHandler: doneHandler)
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
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.__PBAirPrintEvent&&window.__PBAirPrintEvent(\(json));", completionHandler: nil)
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
    }

    private func tcpPrintersListJson() -> String {
        let obj: [String: Any] = ["printers": loadTcpPrinters(), "scanning": false]
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
        var list = loadTcpPrinters().filter { ($0["ip"] as? String) != trimmed }
        list.insert([
            "ip": trimmed,
            "name": "Receipt (\(trimmed))",
            "raw": true,
            "usb": false
        ], at: 0)
        saveTcpPrinters(list)
        probeIppPrinter(trimmed)     // a photo printer that answers IPP (an Epson L8050, say) turns into a photo printer a moment later
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

    // MARK: - IPP photo printers on Wi-Fi (printers that are not AirPrint, e.g. Epson L8050)

    /// After a printer is added by its IP: ask it over IPP what it is. One that answers and takes JPEG photos becomes a photo
    /// printer, with the quality and paper types it lists; one that does not answer stays as it was (a receipt printer).
    private func probeIppPrinter(_ ipPort: String) {
        let host = String(ipPort.split(separator: ":", maxSplits: 1).first ?? Substring(ipPort))
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let caps = IppNet.fetchCaps(ip: host, port: 631) else { return }
            guard caps.formats.isEmpty || caps.formats.contains("image/jpeg") else { return }
            DispatchQueue.main.async { self?.applyIppCaps(ipPort, caps) }
        }
    }

    private func applyIppCaps(_ ipPort: String, _ caps: IppNet.Caps) {
        var list = loadTcpPrinters()
        guard let i = list.firstIndex(where: { ($0["ip"] as? String) == ipPort }) else { return }
        var e = list[i]
        e["ipp"] = true
        e["raw"] = false
        e["usb"] = false
        e["name"] = caps.model.isEmpty ? "Wi-Fi printer (\(ipPort))" : caps.model
        e["ippPath"] = caps.path
        if !caps.serviceName.isEmpty { e["dnssd"] = caps.serviceName }      // lets the app find this printer again by name if its address changes
        e["qualities"] = caps.qualities
        e["colorModes"] = caps.colorModes
        e["mediaTypes"] = caps.mediaTypes
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
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                guard let pd = pagesJson.data(using: .utf8),
                      let arr = try JSONSerialization.jsonObject(with: pd, options: []) as? [String],
                      !arr.isEmpty else {
                    throw IppNet.Failure("Nothing to print.")
                }
                var pages: [Data] = []
                for s in arr {
                    var b64 = s
                    if s.hasPrefix("data:"), let comma = s.firstIndex(of: ",") {
                        b64 = String(s[s.index(after: comma)...])
                    }
                    guard let d = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !d.isEmpty else {
                        throw IppNet.Failure("Could not read the picture to print.")
                    }
                    pages.append(d)
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
                for _ in 0..<sets {
                    for p in pages {
                        do {
                            if let id = try IppNet.printPage(ip: host, port: 631, jpegIn: p, job: "Photobooth", wMm: widthMm, hMm: heightMm,
                                                             quality: quality, color: color, media: media, borderless: borderless, known: known) {
                                ids.append(id)
                            }
                        } catch let f as IppNet.Failure where f.unreached {
                            // The printer dropped off the network between the check and the send, so this photo never reached it:
                            // look for it once more, then send this photo again.
                            guard let fresh = self.ippRefind(ipPort) else { throw f }
                            host = fresh.host
                            if case .ok(let c) = fresh.probe { known = c } else { known = nil }
                            if let id = try IppNet.printPage(ip: host, port: 631, jpegIn: p, job: "Photobooth", wMm: widthMm, hMm: heightMm,
                                                             quality: quality, color: color, media: media, borderless: borderless, known: known) {
                                ids.append(id)
                            }
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
        } else if message.name == "pbSave", let dict = message.body as? [String: Any] {
            // window.__PBLocal.driveAsync / saveImageAsync: write the file in the background, answer through window.__pbSaveResolve
            let id = (dict["id"] as? NSNumber)?.intValue ?? 0
            let op = (dict["op"] as? String) ?? ""
            let a = (dict["a"] as? String) ?? ""
            let b = (dict["b"] as? String) ?? ""
            saveQueue.async { [weak self] in
                let result: String
                if op == "drive" {
                    result = PBLocal.shared.drive(body: a)
                } else if op == "saveImage" {
                    result = PBLocal.shared.saveImage(fileName: a, base64: b)
                } else {
                    result = "{\"ok\":false,\"error\":\"Unknown request\"}"
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
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler(alert.textFields?.first?.text)
            })
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                completionHandler(nil)
            })
            present(alert, animated: true)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        present(alert, animated: true)
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
        (presentedViewController ?? self).present(alert, animated: true)
    }

    private func presentShareSheet(for file: URL) {
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
        (presentedViewController ?? self).present(sheet, animated: true)
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

    // The page was (re)loaded: tell it whether the Bluetooth printer is still connected.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        BtPrinterBridge.shared.pushState()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loadBooth()
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
        IccCameraHelper.shared.ensureListening()
        if loadedViaOta {
            clearOtaCache()
            loadBooth()
        }
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
        var stateReasons: [String] = []          // printer-state-reasons: "media-empty-error", "media-jam-error" ...
        var serviceName = ""                     // printer-dns-sd-name: how the printer is listed by name on the network (Bonjour)
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
                      "printer-state-reasons", "printer-dns-sd-name"]
        for n in wanted { w.u8(0x44); w.u16(0); w.str(n) }
        w.u8(0x03)
        return w.d
    }

    static func printJobRequest(uri: String, job: String, doc: Data, wMm: Double, hMm: Double, quality: Int,
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
        if wMm > 0 {
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
            w.u8(0x37); w.u16(0); w.u16(0)                        // end media-col
        }
        if !scaling.isEmpty { w.attr(0x44, "print-scaling", scaling) }      // "none" for borderless: the printer must not scale or trim
        if quality != 0 { w.u8(0x23); w.str("print-quality"); w.u16(4); w.u32(quality) }    // enum
        if !colorMode.isEmpty { w.attr(0x44, "print-color-mode", colorMode) }
        if !mediaType.isEmpty { w.attr(0x44, "media-type", mediaType) }
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
                if name == "printer-state-reasons" && tag == 0x44 { c.stateReasons.append(value) }
                if name == "printer-dns-sd-name" && (tag == 0x41 || tag == 0x42) && c.serviceName.isEmpty { c.serviceName = value }
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

    /// The JPEG says 300 dpi, so the printer does not take the picture for a small one.
    static func jpegAt300Dpi(_ d: Data) -> Data {
        var b = [UInt8](d)
        guard b.count >= 20, b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF, b[3] == 0xE0,
              b[6] == 0x4A, b[7] == 0x46, b[8] == 0x49, b[9] == 0x46 else { return d }      // "JFIF"
        b[13] = 1                                                  // dots per inch
        b[14] = 1; b[15] = 44                                      // 300 = 0x012C
        b[16] = 1; b[17] = 44
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
        case "photo":
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

    /// Prints one photo. Tries the page size with the quality / paper settings first, then drops them one at a time if the
    /// printer refuses. A printer that cannot be reached, or that goes quiet mid-job, throws at once: nothing is sent twice.
    @discardableResult
    static func printPage(ip: String, port: Int, jpegIn: Data, job: String, wMm: Double, hMm: Double,
                          quality: String, color: String, media: String, borderless: Bool, known: Caps? = nil) throws -> Int? {
        let jpeg = jpegAt300Dpi(jpegIn)
        let found: Caps? = known ?? fetchCaps(ip: ip, port: port)
        let caps = found ?? Caps()
        let hardEpsonL = caps.model.range(of: "L8050", options: .caseInsensitive) != nil
        var q = 0
        if quality == "draft" { q = 3 } else if quality == "normal" { q = 4 } else if quality == "high" { q = 5 }
        let qv = (q != 0 && (caps.qualities.contains(q) || hardEpsonL)) ? q : 0
        var cm = ""
        if color == "mono" && caps.colorModes.contains("monochrome") { cm = "monochrome" }
        else if color == "color" && caps.colorModes.contains("color") { cm = "color" }
        let mt = mediaTypeKeyword(media, caps.mediaTypes, hardEpsonL)
        let hasOpts = qv != 0 || !cm.isEmpty || !mt.isEmpty
        let attempts: [(Bool, Bool)] = hasOpts
            ? [(true, true), (false, true), (true, false), (false, false)]
            : [(true, false), (false, false)]
        let scaling = borderless ? "none" : "fill"
        let pathList: [String] = found == nil ? paths : [caps.path]
        var lastErr = "The printer didn't accept the job."
        for at in attempts {
            for path in pathList {
                let uri = "ipp://\(ip):\(port)\(path)"
                let body = printJobRequest(uri: uri, job: job, doc: jpeg, wMm: at.0 ? wMm : 0, hMm: hMm,
                                           quality: at.1 ? qv : 0, colorMode: at.1 ? cm : "", mediaType: at.1 ? mt : "",
                                           scaling: scaling, marginMm100: 0)
                let r = try post(ip: ip, port: port, path: path, body: body, timeout: 90)
                if r.http == 200 && r.ipp >= 0 && r.ipp <= 2 { return jobId(r.body) }
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
    static func findByName(_ name: String, wait: TimeInterval) -> String? {
        let want = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if want.isEmpty { return nil }
        let box = FindBox()
        let q = DispatchQueue(label: "com.photobooth4u.ipp.find")
        let seen = DispatchSemaphore(value: 0)
        let browser = NWBrowser(for: .bonjour(type: "_ipp._tcp", domain: nil), using: .tcp)
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
