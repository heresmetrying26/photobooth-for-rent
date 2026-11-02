import UIKit
import WebKit

/**
 * photobooth4u — iOS Main View Controller
 *
 * Hosts the photobooth HTML inside a full-screen, kiosk-mode WKWebView.
 * Bridges local storage, ImageCaptureCore USB DSLR camera, voice synth, and local Wi-Fi sharing.
 */
class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    private var webView: WKWebView!
    private var activationContainer: UIView?
    private var codeField: UITextField?

    override var prefersStatusBarHidden: Bool {
        return true
    }

    override var prefersHomeIndicatorAutoHidden: Bool {
        return true
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.92, alpha: 1.0) // #F5F1EA

        // 1. Start background services
        IccCameraHelper.shared.start()
        _ = LocalShareServer.shared.start()

        // 2. Setup WKWebView
        setupWebView()

        // 3. Verify licence or show activation screen
        checkLicenceAndLoad()
    }

    // MARK: - WebView Setup & JS Bridges

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()

        // Register script message handlers
        userContent.add(self, name: "pbLocalDrive")
        userContent.add(self, name: "pbLocalLanBase")
        userContent.add(self, name: "pbVoiceSpeak")
        userContent.add(self, name: "pbVoiceStop")

        // Inject configuration & bridges before booth loads
        let initJs = """
        window.__PB = window.__PB || {};
        window.__PB.desktop = { v: '1.0.0', os: 'ios' };
        window.__PB.ios = true;
        window.__PB.offline = true;
        window.__PB.type = 'rental';
        window.__PB.watermark = false;
        window.__PB.print = { enabled: true, sizes: ['4R', '2x6'] };

        // Bridge: window.__PBLocal
        window.__PBLocal = {
            drive: function(body) {
                var res = prompt('__PBLocal_drive_sync__', body);
                return res || '{}';
            },
            lanBase: function() {
                var res = prompt('__PBLocal_lanBase_sync__', '');
                return res || '';
            },
            photosPath: function() { return 'Documents/Pictures/photobooth4u'; },
            guestViewSet: function(mode) { /* guest view */ }
        };

        // Bridge: window.__PBVoice
        window.__PBVoice = {
            speak: function(text) {
                window.webkit.messageHandlers.pbVoiceSpeak.postMessage(text);
            },
            stop: function() {
                window.webkit.messageHandlers.pbVoiceStop.postMessage({});
            }
        };
        """

        let script = WKUserScript(source: initJs, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        userContent.addUserScript(script)
        config.userContentController = userContent
        config.allowsInlineMediaPlayback = true

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        view.addSubview(webView)
    }

    // MARK: - Licence & Booth Loading

    private func checkLicenceAndLoad() {
        let lic = AppLicence.shared.verify()
        if lic.ok {
            loadBooth()
        } else {
            showActivationScreen(message: lic.message)
        }
    }

    private func loadBooth() {
        activationContainer?.removeFromSuperview()
        activationContainer = nil

        // Attempt to load booth.html from bundle
        if let htmlPath = Bundle.main.path(forResource: "booth", ofType: "html") {
            let url = URL(fileURLWithPath: htmlPath)
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            // Fallback for development: load from documents or server
            showActivationScreen(message: "Missing booth.html in app bundle.")
        }
    }

    private func showActivationScreen(message: String) {
        activationContainer?.removeFromSuperview()

        let container = UIView(frame: view.bounds)
        container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.92, alpha: 1.0)

        let label = UILabel()
        label.text = "photobooth4u"
        label.font = UIFont.systemFont(ofSize: 28, weight: .black)
        label.textColor = UIColor(red: 0.11, green: 0.10, blue: 0.12, alpha: 1.0)
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)

        let msgLabel = UILabel()
        msgLabel.text = message
        msgLabel.font = UIFont.systemFont(ofSize: 15, weight: .medium)
        msgLabel.textColor = UIColor(red: 0.42, green: 0.40, blue: 0.42, alpha: 1.0)
        msgLabel.textAlignment = .center
        msgLabel.numberOfLines = 0
        msgLabel.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(msgLabel)

        let textField = UITextField()
        textField.placeholder = "Enter Rental Code"
        textField.textAlignment = .center
        textField.font = UIFont.monospacedSystemFont(ofSize: 18, weight: .bold)
        textField.borderStyle = .roundedRect
        textField.autocapitalizationType = .allCharacters
        textField.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(textField)
        self.codeField = textField

        let btn = UIButton(type: .system)
        btn.setTitle("Activate iPad", for: .normal)
        btn.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .bold)
        btn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1.0) // #C93D27
        btn.setTitleColor(.white, for: .normal)
        btn.layer.cornerRadius = 10
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.addTarget(self, action: #selector(didTapActivate), for: .touchUpInside)
        container.addSubview(btn)

        let midLabel = UILabel()
        midLabel.text = "iPad ID: \(AppLicence.shared.machineId())"
        midLabel.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        midLabel.textColor = .gray
        midLabel.textAlignment = .center
        midLabel.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(midLabel)

        view.addSubview(container)
        self.activationContainer = container

        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: -120),

            msgLabel.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 10),
            msgLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20),
            msgLabel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -20),

            textField.topAnchor.constraint(equalTo: msgLabel.bottomAnchor, constant: 24),
            textField.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            textField.widthAnchor.constraint(equalToConstant: 280),
            textField.heightAnchor.constraint(equalToConstant: 44),

            btn.topAnchor.constraint(equalTo: textField.bottomAnchor, constant: 16),
            btn.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            btn.widthAnchor.constraint(equalToConstant: 280),
            btn.heightAnchor.constraint(equalToConstant: 46),

            midLabel.topAnchor.constraint(equalTo: btn.bottomAnchor, constant: 20),
            midLabel.centerXAnchor.constraint(equalTo: container.centerXAnchor)
        ])
    }

    @objc private func didTapActivate() {
        guard let code = codeField?.text?.trimmingCharacters(in: .whitespacesAndNewlines), !code.isEmpty else {
            return
        }

        // Online activation request to /api/license
        guard let url = URL(string: "\(AppLicence.serverUrl)/api/license?code=\(code)&mid=\(AppLicence.shared.machineId())") else { return }

        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let self = self, let d = data,
                  let json = (try? JSONSerialization.jsonObject(with: d, options: [])) as? [String: Any],
                  let licToken = json["license"] as? String else {
                DispatchQueue.main.async {
                    self?.showActivationScreen(message: "Activation failed. Check internet and code.")
                }
                return
            }

            AppLicence.shared.saveLicence(token: licToken)

            DispatchQueue.main.async {
                self.checkLicenceAndLoad()
            }
        }
        task.resume()
    }

    // MARK: - WKScriptMessageHandler & Sync Prompts

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "pbVoiceSpeak", let text = message.body as? String {
            VoiceBridge.shared.speak(text: text)
        } else if message.name == "pbVoiceStop" {
            VoiceBridge.shared.stop()
        }
    }

    // Synchronous prompt intercepts for JavaScript methods that expect immediate return values
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        if prompt == "__PBLocal_drive_sync__" {
            let res = PBLocal.shared.drive(body: defaultText ?? "{}")
            completionHandler(res)
            return
        } else if prompt == "__PBLocal_lanBase_sync__" {
            let res = PBLocal.shared.lanBase()
            completionHandler(res)
            return
        }
        completionHandler(nil)
    }
}

