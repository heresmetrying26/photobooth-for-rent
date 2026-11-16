import UIKit
import WebKit
import AVFoundation

/**
 * photobooth4u — iOS / iPadOS Main View Controller
 *
 * Hosts the bundled photobooth HTML inside a full-screen, kiosk-mode WKWebView
 * served from http://localhost:17321/booth (a WebKit Secure Context so built-in
 * camera, UVC capture cards, and same-origin USB DSLR calls all work cleanly).
 */
class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    private var webView: WKWebView!
    private var backToBoothBtn: UIButton?
    private var gateContainer: UIView?
    private var gateMessageLabel: UILabel?
    private var codeField: UITextField?
    private var activateBtn: UIButton?
    private var gateReason: String = ""

    private var activePayload: [String: Any]?
    private var checkinTimer: Timer?

    override var prefersStatusBarHidden: Bool { return true }
    override var prefersHomeIndicatorAutoHidden: Bool { return true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.92, alpha: 1.0) // #F5F1EA

        // 1. Start local servers & USB camera browser
        IccCameraHelper.shared.start()
        _ = LocalShareServer.shared.start()

        // 2. Request native camera/mic permissions upfront
        requestMediaPermissionsIfNeeded()

        // 3. Setup WKWebView
        setupWebView()

        // 4. Verify licence or show activation gate
        bootWithLicence()

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

    private func requestMediaPermissionsIfNeeded() {
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { _ in }
        }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
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

        let bridgeJs = """
        (function(){
          if (window.__pbIosBridgeReady) return;
          window.__pbIosBridgeReady = true;

          window.__PBLocal = {
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
            isOnline: function() {
              return prompt('__PBLocal_isOnline_sync__', '') === '1';
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
            }
          };

          window.print = function() {
            try { window.webkit.messageHandlers.pbPrintWebView.postMessage({}); } catch (e) {}
          };

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
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.customUserAgent = (webView.value(forKey: "userAgent") as? String ?? "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)") + " PB4uIOS/\(AppLicence.shared.appVersion())"
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
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
        webView.scrollView.isScrollEnabled = false
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
        let traditional = (feat["traditional"] as? NSNumber)?.boolValue ?? false
        let orientation = (feat["orientation"] as? String) ?? "landscape"

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

        return """
        <script>
        window.__PB=window.__PB||{};
        window.__PB.desktop={v:\(jsonStr(AppLicence.shared.appVersion())),os:'ios'};
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
        window.__PB.print={enabled:\(printEnabled ? "true" : "false"),sizes:[\(sizesJs)]};
        </script>
        """
    }

    private func loadBooth() {
        gateContainer?.removeFromSuperview()
        gateContainer = nil

        guard let htmlPath = Bundle.main.path(forResource: "booth", ofType: "html"),
              let raw = try? String(contentsOfFile: htmlPath, encoding: .utf8) else {
            let errSt = AppLicence.Status(ok: false, reason: "none", message: "Missing booth.html in app bundle.", payload: nil, warn: "")
            showActivationScreen(st: errSt)
            return
        }

        let pbConfig = buildPbConfigScript()
        let injected: String
        if let headRange = raw.range(of: "</head>", options: .caseInsensitive) {
            injected = raw.replacingCharacters(in: headRange, with: "\(pbConfig)\n</head>")
        } else {
            injected = pbConfig + raw
        }

        IccCameraHelper.shared.setBoothHtml(injected)
        if let url = URL(string: "http://localhost:\(IccCameraHelper.port)/booth") {
            webView.load(URLRequest(url: url))
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
            title.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: -130),

            msg.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 12),
            msg.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            msg.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
            msg.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 24),
            msg.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -24),

            tf.topAnchor.constraint(equalTo: msg.bottomAnchor, constant: 22),
            tf.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            tf.widthAnchor.constraint(equalToConstant: 300),
            tf.heightAnchor.constraint(equalToConstant: 46),

            btn.topAnchor.constraint(equalTo: tf.bottomAnchor, constant: 16),
            btn.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            btn.widthAnchor.constraint(equalToConstant: 300),
            btn.heightAnchor.constraint(equalToConstant: 48),

            mid.topAnchor.constraint(equalTo: btn.bottomAnchor, constant: 20),
            mid.centerXAnchor.constraint(equalTo: container.centerXAnchor)
        ])
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
                img.draw(in: pageBounds)
            }
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let controller = UIPrintInteractionController.shared
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = jobName
            info.outputType = .photo
            info.orientation = (ptW > ptH) ? .landscape : .portrait
            controller.printInfo = info
            controller.printingItem = pdfData
            let anchor = CGRect(x: self.view.bounds.midX, y: self.view.bounds.maxY - 80, width: 1, height: 1)
            controller.present(from: anchor, in: self.view, animated: true, completionHandler: nil)
        }
        return "{\"ok\":true}"
    }

    private func printWebViewFallback() {
        guard UIPrintInteractionController.isPrintingAvailable else { return }
        let controller = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.jobName = "Photobooth"
        info.outputType = .photo
        controller.printInfo = info
        controller.printFormatter = webView.viewPrintFormatter()
        let anchor = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
        controller.present(from: anchor, in: view, animated: true, completionHandler: nil)
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
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let host = (url.host ?? "").lowercased()
        let path = url.path

        if host == "localhost" || host == "127.0.0.1" {
            let isGallery = path.hasPrefix("/e/") || path.hasPrefix("/o/")
            backToBoothBtn?.isHidden = !isGallery
            webView.scrollView.isScrollEnabled = isGallery
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
}
