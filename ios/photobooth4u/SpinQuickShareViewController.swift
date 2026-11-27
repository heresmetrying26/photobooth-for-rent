import UIKit
import AVFoundation
import CoreImage

/// Universal (iPhone + iPad) post-spin quick share modal for Standalone 360 Mode.
/// Always supports offline local Wi-Fi QR + AirDrop/Save; enables Email & WhatsApp redirect when online with a cloud link.
final class SpinQuickShareViewController: UIViewController, UITextFieldDelegate {

    private let videoURL: URL
    private let localPageURL: String
    private let stationURL: String
    private let eventTitle: String
    private let slug: String
    private let filename: String
    var onDone: (() -> Void)?

    private var onlineShareURL: String?
    private var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var endObserver: NSObjectProtocol?
    private var isMuted = true

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let mainRow = UIStackView()

    private let videoBox = UIView()
    private let muteBtn = UIButton(type: .system)

    private let shareCard = UIView()
    private let qrImageView = UIImageView()
    private let qrSubLabel = UILabel()
    private let stationBadgeLabel = UILabel()
    private let airdropBtn = UIButton(type: .system)

    private let onlineStatusLabel = UILabel()
    private let onlineControlsStack = UIStackView()
    private let waField = UITextField()
    private let waBtn = UIButton(type: .system)
    private let mailField = UITextField()
    private let mailBtn = UIButton(type: .system)
    private let feedbackLabel = UILabel()
    private let doneBtn = UIButton(type: .system)

    init(
        videoURL: URL,
        localPageURL: String,
        stationURL: String,
        eventTitle: String,
        slug: String,
        filename: String,
        initialOnlineURL: String? = nil
    ) {
        self.videoURL = videoURL
        self.localPageURL = localPageURL
        self.stationURL = stationURL
        self.eventTitle = eventTitle
        self.slug = slug
        self.filename = filename
        self.onlineShareURL = initialOnlineURL
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if let obs = endObserver { NotificationCenter.default.removeObserver(obs) }
        player?.pause()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.06, green: 0.055, blue: 0.075, alpha: 0.96)
        buildUI()
        setupPlayer()
        refreshShareState()

        NotificationCenter.default.addObserver(self, selector: #selector(handleKeyboard(_:)), name: UIResponder.keyboardWillShowNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleKeyboard(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        playerLayer?.frame = videoBox.bounds
        let wide = view.bounds.width >= 700
        mainRow.axis = wide ? .horizontal : .vertical
        mainRow.distribution = wide ? .fillEqually : .fill
        mainRow.alignment = .fill
    }

    // MARK: - Cloud Status Updates

    func setCloudSyncStatus(_ text: String) {
        onlineStatusLabel.text = text
    }

    func setOnlineShareURL(_ url: String) {
        onlineShareURL = url
        onlineStatusLabel.text = "☁️ Online: WhatsApp & Email ready"
        refreshShareState()
    }

    // MARK: - UI Construction

    private func buildUI() {
        let tapBg = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        tapBg.cancelsTouchesInView = false
        view.addGestureRecognizer(tapBg)

        let topBar = UIView()
        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)

        let badge = UILabel()
        badge.text = "  360 READY TO SHARE  "
        badge.font = .systemFont(ofSize: 11, weight: .heavy)
        badge.textColor = .white
        badge.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        badge.layer.cornerRadius = 8
        badge.clipsToBounds = true
        badge.translatesAutoresizingMaskIntoConstraints = false

        let titleLbl = UILabel()
        titleLbl.text = eventTitle.isEmpty ? "360 Video Booth" : eventTitle
        titleLbl.font = .systemFont(ofSize: 17, weight: .bold)
        titleLbl.textColor = .white
        titleLbl.lineBreakMode = .byTruncatingTail
        titleLbl.translatesAutoresizingMaskIntoConstraints = false

        let closeBtn = UIButton(type: .system)
        closeBtn.setTitle("✕", for: .normal)
        closeBtn.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
        closeBtn.setTitleColor(.white, for: .normal)
        closeBtn.backgroundColor = UIColor(white: 1, alpha: 0.14)
        closeBtn.layer.cornerRadius = 17
        closeBtn.addTarget(self, action: #selector(didTapDone), for: .touchUpInside)
        closeBtn.translatesAutoresizingMaskIntoConstraints = false

        topBar.addSubview(badge)
        topBar.addSubview(titleLbl)
        topBar.addSubview(closeBtn)

        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .interactive
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)

        contentStack.axis = .vertical
        contentStack.spacing = 14
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)

        let wide = view.bounds.width >= 700
        mainRow.axis = wide ? .horizontal : .vertical
        mainRow.spacing = 16
        mainRow.distribution = wide ? .fillEqually : .fill
        mainRow.alignment = .fill
        contentStack.addArrangedSubview(mainRow)

        // Video Preview Box
        videoBox.backgroundColor = .black
        videoBox.layer.cornerRadius = 18
        videoBox.layer.borderWidth = 1
        videoBox.layer.borderColor = UIColor(white: 1, alpha: 0.12).cgColor
        videoBox.clipsToBounds = true
        videoBox.translatesAutoresizingMaskIntoConstraints = false
        videoBox.heightAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true

        muteBtn.setTitle("🔇 Tap for Sound", for: .normal)
        muteBtn.titleLabel?.font = .systemFont(ofSize: 12, weight: .bold)
        muteBtn.setTitleColor(.white, for: .normal)
        muteBtn.backgroundColor = UIColor(white: 0.08, alpha: 0.78)
        muteBtn.layer.cornerRadius = 14
        muteBtn.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        muteBtn.addTarget(self, action: #selector(didTapMute), for: .touchUpInside)
        muteBtn.translatesAutoresizingMaskIntoConstraints = false
        videoBox.addSubview(muteBtn)

        NSLayoutConstraint.activate([
            muteBtn.trailingAnchor.constraint(equalTo: videoBox.trailingAnchor, constant: -12),
            muteBtn.bottomAnchor.constraint(equalTo: videoBox.bottomAnchor, constant: -12)
        ])

        // Right/Bottom Share Panel
        shareCard.backgroundColor = UIColor(white: 1, alpha: 0.05)
        shareCard.layer.cornerRadius = 18
        shareCard.layer.borderWidth = 1
        shareCard.layer.borderColor = UIColor(white: 1, alpha: 0.12).cgColor

        let cardStack = UIStackView()
        cardStack.axis = .vertical
        cardStack.alignment = .center
        cardStack.spacing = 10
        cardStack.translatesAutoresizingMaskIntoConstraints = false
        shareCard.addSubview(cardStack)

        let qrHeading = UILabel()
        qrHeading.text = "Scan to Save 360 Video"
        qrHeading.font = .systemFont(ofSize: 19, weight: .heavy)
        qrHeading.textColor = .white
        qrHeading.textAlignment = .center

        qrSubLabel.font = .systemFont(ofSize: 12.5, weight: .medium)
        qrSubLabel.textColor = UIColor(white: 0.72, alpha: 1)
        qrSubLabel.textAlignment = .center
        qrSubLabel.numberOfLines = 0

        let qrBg = UIView()
        qrBg.backgroundColor = .white
        qrBg.layer.cornerRadius = 16
        qrBg.translatesAutoresizingMaskIntoConstraints = false
        qrImageView.contentMode = .scaleAspectFit
        qrImageView.translatesAutoresizingMaskIntoConstraints = false
        qrBg.addSubview(qrImageView)
        NSLayoutConstraint.activate([
            qrImageView.topAnchor.constraint(equalTo: qrBg.topAnchor, constant: 10),
            qrImageView.bottomAnchor.constraint(equalTo: qrBg.bottomAnchor, constant: -10),
            qrImageView.leadingAnchor.constraint(equalTo: qrBg.leadingAnchor, constant: 10),
            qrImageView.trailingAnchor.constraint(equalTo: qrBg.trailingAnchor, constant: -10),
            qrImageView.widthAnchor.constraint(equalToConstant: 168),
            qrImageView.heightAnchor.constraint(equalToConstant: 168)
        ])

        airdropBtn.setTitle("📤 Save / AirDrop Video", for: .normal)
        airdropBtn.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
        airdropBtn.setTitleColor(.white, for: .normal)
        airdropBtn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        airdropBtn.layer.cornerRadius = 12
        airdropBtn.contentEdgeInsets = UIEdgeInsets(top: 12, left: 18, bottom: 12, right: 18)
        airdropBtn.addTarget(self, action: #selector(didTapAirDrop(_:)), for: .touchUpInside)

        onlineStatusLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        onlineStatusLabel.textColor = UIColor(red: 0.55, green: 0.85, blue: 0.68, alpha: 1)
        onlineStatusLabel.textAlignment = .center
        onlineStatusLabel.numberOfLines = 0

        onlineControlsStack.axis = .vertical
        onlineControlsStack.spacing = 8
        onlineControlsStack.alignment = .fill

        configureField(waField, placeholder: "WhatsApp number (e.g. 0917...)", keyboard: .phonePad)
        waBtn.setTitle("WhatsApp", for: .normal)
        waBtn.titleLabel?.font = .systemFont(ofSize: 13.5, weight: .bold)
        waBtn.setTitleColor(.white, for: .normal)
        waBtn.backgroundColor = UIColor(red: 0.12, green: 0.56, blue: 0.30, alpha: 1)
        waBtn.layer.cornerRadius = 10
        waBtn.contentEdgeInsets = UIEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
        waBtn.setContentHuggingPriority(.required, for: .horizontal)
        waBtn.addTarget(self, action: #selector(didTapWhatsApp), for: .touchUpInside)

        let waRow = UIStackView(arrangedSubviews: [waField, waBtn])
        waRow.axis = .horizontal
        waRow.spacing = 8

        configureField(mailField, placeholder: "Guest email (optional)", keyboard: .emailAddress)
        mailBtn.setTitle("Send Email", for: .normal)
        mailBtn.titleLabel?.font = .systemFont(ofSize: 13.5, weight: .bold)
        mailBtn.setTitleColor(.white, for: .normal)
        mailBtn.backgroundColor = UIColor(white: 1, alpha: 0.18)
        mailBtn.layer.cornerRadius = 10
        mailBtn.contentEdgeInsets = UIEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
        mailBtn.setContentHuggingPriority(.required, for: .horizontal)
        mailBtn.addTarget(self, action: #selector(didTapSendEmail), for: .touchUpInside)

        let mailRow = UIStackView(arrangedSubviews: [mailField, mailBtn])
        mailRow.axis = .horizontal
        mailRow.spacing = 8

        onlineControlsStack.addArrangedSubview(waRow)
        onlineControlsStack.addArrangedSubview(mailRow)

        feedbackLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        feedbackLabel.textColor = UIColor(white: 0.85, alpha: 1)
        feedbackLabel.textAlignment = .center
        feedbackLabel.numberOfLines = 0

        stationBadgeLabel.font = .monospacedSystemFont(ofSize: 11.5, weight: .medium)
        stationBadgeLabel.textColor = UIColor(white: 0.65, alpha: 1)
        stationBadgeLabel.textAlignment = .center
        stationBadgeLabel.numberOfLines = 0
        stationBadgeLabel.text = stationURL.isEmpty
            ? "Connect to Wi-Fi/Hotspot to open a separate Sharing Station"
            : "Sharing Station live at: \(stationURL)"

        doneBtn.setTitle("✓ Done — Next Spin", for: .normal)
        doneBtn.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
        doneBtn.setTitleColor(.white, for: .normal)
        doneBtn.backgroundColor = UIColor(white: 1, alpha: 0.14)
        doneBtn.layer.cornerRadius = 12
        doneBtn.contentEdgeInsets = UIEdgeInsets(top: 12, left: 20, bottom: 12, right: 20)
        doneBtn.addTarget(self, action: #selector(didTapDone), for: .touchUpInside)

        [qrHeading, qrSubLabel, qrBg, airdropBtn, onlineStatusLabel, onlineControlsStack, feedbackLabel, stationBadgeLabel, doneBtn].forEach {
            cardStack.addArrangedSubview($0)
        }
        airdropBtn.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
        onlineControlsStack.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
        doneBtn.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true

        NSLayoutConstraint.activate([
            cardStack.topAnchor.constraint(equalTo: shareCard.topAnchor, constant: 18),
            cardStack.bottomAnchor.constraint(equalTo: shareCard.bottomAnchor, constant: -18),
            cardStack.leadingAnchor.constraint(equalTo: shareCard.leadingAnchor, constant: 18),
            cardStack.trailingAnchor.constraint(equalTo: shareCard.trailingAnchor, constant: -18)
        ])

        mainRow.addArrangedSubview(videoBox)
        mainRow.addArrangedSubview(shareCard)

        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            topBar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            topBar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -14),
            topBar.heightAnchor.constraint(equalToConstant: 40),

            badge.leadingAnchor.constraint(equalTo: topBar.leadingAnchor),
            badge.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            badge.heightAnchor.constraint(equalToConstant: 24),

            titleLbl.leadingAnchor.constraint(equalTo: badge.trailingAnchor, constant: 10),
            titleLbl.trailingAnchor.constraint(lessThanOrEqualTo: closeBtn.leadingAnchor, constant: -10),
            titleLbl.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),

            closeBtn.trailingAnchor.constraint(equalTo: topBar.trailingAnchor),
            closeBtn.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            closeBtn.widthAnchor.constraint(equalToConstant: 34),
            closeBtn.heightAnchor.constraint(equalToConstant: 34),

            scrollView.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 10),
            scrollView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 14),
            scrollView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -14),
            scrollView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -10),

            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor)
        ])
    }

    private func configureField(_ tf: UITextField, placeholder: String, keyboard: UIKeyboardType) {
        tf.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: UIColor(white: 0.6, alpha: 1)])
        tf.textColor = .white
        tf.font = .systemFont(ofSize: 14, weight: .medium)
        tf.backgroundColor = UIColor(white: 1, alpha: 0.08)
        tf.layer.cornerRadius = 10
        tf.layer.borderWidth = 1
        tf.layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
        tf.keyboardType = keyboard
        tf.autocapitalizationType = .none
        tf.autocorrectionType = .no
        tf.returnKeyType = .done
        tf.delegate = self
        tf.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
        tf.leftViewMode = .always
        tf.heightAnchor.constraint(equalToConstant: 42).isActive = true
    }

    // MARK: - Video Playback

    private func setupPlayer() {
        let item = AVPlayerItem(url: videoURL)
        let p = AVPlayer(playerItem: item)
        p.isMuted = isMuted
        let layer = AVPlayerLayer(player: p)
        layer.videoGravity = .resizeAspect
        layer.frame = videoBox.bounds
        videoBox.layer.insertSublayer(layer, at: 0)
        self.player = p
        self.playerLayer = layer

        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak p] _ in
            p?.seek(to: .zero)
            p?.play()
        }
        p.play()
    }

    // MARK: - State Refresh & QR

    private func refreshShareState() {
        let targetQR = (onlineShareURL?.isEmpty == false ? onlineShareURL : nil) ?? localPageURL
        if !targetQR.isEmpty {
            qrImageView.image = Self.generateQRCode(from: targetQR)
        } else {
            qrImageView.image = nil
        }

        let online = PBLocal.shared.isOnline()
        if let cloud = onlineShareURL, !cloud.isEmpty, online {
            qrSubLabel.text = "Scan QR to save (cloud link ready)"
            onlineControlsStack.isHidden = false
            if onlineStatusLabel.text?.isEmpty != false {
                onlineStatusLabel.text = "☁️ Online: WhatsApp & Email ready"
            }
            onlineStatusLabel.textColor = UIColor(red: 0.55, green: 0.85, blue: 0.68, alpha: 1)
        } else {
            qrSubLabel.text = localPageURL.isEmpty
                ? "Join Wi-Fi/Hotspot for QR download, or tap Save / AirDrop below"
                : "Join booth Wi-Fi & scan QR to save directly in browser"
            onlineControlsStack.isHidden = true
            if onlineStatusLabel.text?.isEmpty != false {
                onlineStatusLabel.text = online
                    ? "Local Wi-Fi QR & AirDrop ready (set Drive folder in Setup for WhatsApp/Email links)"
                    : "Offline mode — scan QR code, Save, or AirDrop"
            }
            onlineStatusLabel.textColor = UIColor(white: 0.72, alpha: 1)
        }
    }

    static func generateQRCode(from string: String) -> UIImage? {
        guard let data = string.data(using: .utf8),
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let transformed = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let ctx = CIContext()
        guard let cg = ctx.createCGImage(transformed, from: transformed.extent) else { return nil }
        return UIImage(cgImage: cg)
    }

    private static let queryValueAllowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))

    private static func encodeQueryValue(_ value: String) -> String {
        return value.addingPercentEncoding(withAllowedCharacters: queryValueAllowed) ?? value
    }

    static func normalizeWhatsAppPhone(_ raw: String) -> String {
        var digits = raw.filter { $0.isNumber || $0 == "+" }
        if digits.isEmpty { return "" }
        if digits.hasPrefix("+") {
            digits.removeFirst()
        } else if digits.hasPrefix("09") && digits.count == 11 {
            digits = "63" + String(digits.dropFirst())
        } else if digits.hasPrefix("9") && digits.count == 10 {
            digits = "63" + digits
        } else {
            while digits.hasPrefix("0") { digits.removeFirst() }
        }
        return (digits.count >= 7 && digits.count <= 15 && digits.allSatisfy { $0.isNumber }) ? digits : ""
    }

    // MARK: - Actions

    @objc private func didTapMute() {
        isMuted.toggle()
        player?.isMuted = isMuted
        muteBtn.setTitle(isMuted ? "🔇 Tap for Sound" : "🔊 Sound On", for: .normal)
    }

    @objc private func didTapAirDrop(_ sender: UIButton) {
        let ac = UIActivityViewController(activityItems: [videoURL], applicationActivities: nil)
        if let pop = ac.popoverPresentationController {
            pop.sourceView = sender
            pop.sourceRect = sender.bounds
        }
        present(ac, animated: true)
    }

    @objc private func didTapWhatsApp() {
        dismissKeyboard()
        guard PBLocal.shared.isOnline(), let shareUrl = onlineShareURL, !shareUrl.isEmpty else {
            feedbackLabel.text = "Online link needed for WhatsApp."
            return
        }
        let phone = Self.normalizeWhatsAppPhone(waField.text ?? "")
        guard !phone.isEmpty else {
            feedbackLabel.text = "Enter a valid WhatsApp number (e.g. 09171234567)."
            return
        }
        let title = eventTitle.isEmpty ? "your 360 event" : eventTitle
        let msg = "Here is your 360 video from \(title): \(shareUrl)"
        let encPhone = Self.encodeQueryValue(phone)
        let encMsg = Self.encodeQueryValue(msg)

        if let appURL = URL(string: "whatsapp://send?phone=\(encPhone)&text=\(encMsg)"),
           UIApplication.shared.canOpenURL(appURL) {
            feedbackLabel.text = "Opening WhatsApp…"
            UIApplication.shared.open(appURL, options: [:], completionHandler: nil)
        } else if let webURL = URL(string: "https://wa.me/\(encPhone)?text=\(encMsg)") {
            feedbackLabel.text = "Opening WhatsApp…"
            UIApplication.shared.open(webURL, options: [:], completionHandler: nil)
        }
    }

    @objc private func didTapSendEmail() {
        dismissKeyboard()
        guard PBLocal.shared.isOnline(), let shareUrl = onlineShareURL, !shareUrl.isEmpty else {
            feedbackLabel.text = "Online link needed to send email."
            return
        }
        let to = (mailField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard to.contains("@"), to.contains(".") else {
            feedbackLabel.text = "Enter a valid email address."
            return
        }

        mailBtn.isEnabled = false
        mailBtn.setTitle("Sending…", for: .normal)
        feedbackLabel.text = ""

        let ctx = PBLocal.shared.spinContext
        var payload: [String: Any] = [
            "to": to,
            "shareUrl": shareUrl,
            "eventName": eventTitle.isEmpty ? "360 Video Booth" : eventTitle,
            "kind": "video"
        ]
        if !ctx.driveFolderId.isEmpty { payload["folderId"] = ctx.driveFolderId }
        if !ctx.opKey.isEmpty { payload["k"] = ctx.opKey }
        let licStr = ctx.licence.isEmpty ? (AppLicence.shared.currentLicenceString() ?? "") : ctx.licence
        let midStr = ctx.mid.isEmpty ? AppLicence.shared.machineId() : ctx.mid
        if !licStr.isEmpty { payload["licence"] = licStr }
        if !midStr.isEmpty { payload["mid"] = midStr }
        if !ctx.token.isEmpty { payload["token"] = ctx.token }
        if !ctx.deviceId.isEmpty { payload["deviceId"] = ctx.deviceId }

        guard let endpoint = URL(string: "\(AppLicence.serverUrl)/api/station-mail"),
              let body = try? JSONSerialization.data(withJSONObject: payload) else {
            mailBtn.isEnabled = true
            mailBtn.setTitle("Send Email", for: .normal)
            return
        }

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body

        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.mailBtn.isEnabled = true
                self.mailBtn.setTitle("Send Email", for: .normal)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let obj = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
                if code == 200, (obj?["ok"] as? Bool) == true {
                    self.feedbackLabel.text = "✓ Email sent to \(to)"
                    self.mailField.text = ""
                } else {
                    let subj = "\(self.eventTitle.isEmpty ? "360 Video Booth" : self.eventTitle) — Your 360 Video"
                    let bodyTxt = "Watch and save your 360 video:\n\n\(shareUrl)"
                    let sEnc = Self.encodeQueryValue(subj)
                    let bEnc = Self.encodeQueryValue(bodyTxt)
                    let tEnc = to.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? to
                    if let mailto = URL(string: "mailto:\(tEnc)?subject=\(sEnc)&body=\(bEnc)") {
                        UIApplication.shared.open(mailto, options: [:], completionHandler: nil)
                    }
                    self.feedbackLabel.text = (obj?["error"] as? String) ?? "Opening Mail app…"
                }
            }
        }.resume()
    }

    @objc private func didTapDone() {
        player?.pause()
        dismiss(animated: true) { [weak self] in
            self?.onDone?()
        }
    }

    @objc private func dismissKeyboard() {
        view.endEditing(true)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    @objc private func handleKeyboard(_ note: Notification) {
        guard let info = note.userInfo,
              let endFrame = info[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let showing = note.name == UIResponder.keyboardWillShowNotification
        let inset = showing ? max(0, endFrame.height - view.safeAreaInsets.bottom + 12) : 0
        scrollView.contentInset.bottom = inset
        scrollView.verticalScrollIndicatorInsets.bottom = inset
    }
}
