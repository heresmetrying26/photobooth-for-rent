import UIKit
import AVFoundation
import AudioToolbox
import ImageIO
import Network
import SafariServices

/// Standalone Roving DSLR Bridge for iPhone & iPad:
/// Connects to a wired DSLR / mirrorless camera (Canon EOS / R-series, Nikon, Sony Alpha,
/// Olympus / Generic PTP) via USB-C or Apple USB Camera Adapter using ImageCaptureCore,
/// listens for physical shutter presses, queues full-res JPEGs safely on disk, and streams
/// them in real time over local booth Wi-Fi to the laptop Photographer Desk base station.
final class RovingBridgeViewController: UIViewController,
    UITextFieldDelegate,
    UICollectionViewDataSource,
    UICollectionViewDelegateFlowLayout {

    // MARK: - Constants & Types

    private enum Keys {
        static let targetUrl = "pb4u_roving_target_laptop_url"
        static let vibrate = "pb4u_roving_vibrate_on_send"
        static let saveToCard = "pb4u_roving_save_to_card"
    }

    private enum UploadOutcome {
        case ok
        case retry
        case tooBig
    }

    private static let retryDelaySec: TimeInterval = 2.0
    private static let maxUploadBytes: Int64 = 80 * 1024 * 1024

    final class SessionPhoto {
        let thumbUrl: URL
        let timeStr: String
        var success: Bool
        let sizeBytes: Int64
        var pendingUrl: URL?

        init(thumbUrl: URL, timeStr: String, success: Bool, sizeBytes: Int64, pendingUrl: URL? = nil) {
            self.thumbUrl = thumbUrl
            self.timeStr = timeStr
            self.success = success
            self.sizeBytes = sizeBytes
            self.pendingUrl = pendingUrl
        }
    }

    // MARK: - Concurrency & State

    private let stateLock = NSLock()
    private var targetUrl: String = ""
    private var vibrateOnSend: Bool = true
    private var saveToCardEnabled: Bool = true
    private var sentPhotosCount: Int = 0
    private var sessionPhotos: [SessionPhoto] = []
    private var previewingPhoto: SessionPhoto?

    private var workerRunning = false
    private var workerToken: UUID?
    private var workerThread: Thread?
    private let workerLock = NSLock()

    private let ingestQueue = DispatchQueue(label: "com.photobooth4u.roving.ingest", qos: .userInitiated)
    private let uploadQueue = DispatchQueue(label: "com.photobooth4u.roving.upload", qos: .userInitiated)
    private let netQueue = DispatchQueue(label: "com.photobooth4u.roving.net", qos: .utility)

    private let restoreGroup = DispatchGroup()
    private var pendingSeq: Int = 0
    private var drainQueued = false
    private var isDraining = false
    private var consecutiveUploadFails = 0
    private var retryWorkItem: DispatchWorkItem?

    private let activeTaskLock = NSLock()
    private var activeUploadTask: URLSessionTask?

    private var wifiMonitor: NWPathMonitor?
    private var ethMonitor: NWPathMonitor?

    private lazy var lanSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.allowsCellularAccess = false
        cfg.waitsForConnectivity = false
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 35
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        cfg.httpAdditionalHeaders = ["Connection": "close"]
        return URLSession(configuration: cfg)
    }()

    private lazy var publicSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.allowsCellularAccess = true
        cfg.waitsForConnectivity = false
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 25
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        cfg.httpAdditionalHeaders = ["Connection": "close"]
        return URLSession(configuration: cfg)
    }()

    private let hapticGenerator = UINotificationFeedbackGenerator()
    private var savedBrightness: CGFloat?
    private var pocketLockActive = false
    private var pocketTapCount = 0
    private var pocketResetWorkItem: DispatchWorkItem?
    private var toastWorkItem: DispatchWorkItem?

    // MARK: - UI Elements

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()

    private let statusPill = PaddingLabel(inset: UIEdgeInsets(top: 4, left: 10, bottom: 4, right: 10))
    private let cameraTitleLabel = UILabel()
    private let cameraSubLabel = UILabel()
    private let saveToCardSwitch = UISwitch()

    private let laptopInput = UITextField()
    private let connectionStatusLabel = UILabel()

    private let thumbnailView = UIImageView()
    private let statsCountLabel = UILabel()
    private let lastSentLabel = UILabel()

    private let pendingBanner = UIView()
    private let pendingBannerLabel = UILabel()

    private let triggerButton = UIButton(type: .system)

    // Pocket Lock Overlay
    private let pocketLockOverlay = UIView()
    private let pocketStatsLabel = UILabel()
    private let pocketUnlockBtn = UIButton(type: .system)

    // Gallery Overlay
    private let galleryOverlay = UIView()
    private let galleryTitleLabel = UILabel()
    private let galleryRetryBtn = UIButton(type: .system)
    private let galleryEmptyLabel = UILabel()
    private var galleryCollectionView: UICollectionView!

    // Photo Preview Overlay
    private let photoPreviewOverlay = UIView()
    private let previewInfoLabel = UILabel()
    private let previewStatusLabel = UILabel()
    private let previewImageView = UIImageView()
    private let previewRetryBtn = UIButton(type: .system)

    // Diagnostics Overlay
    private let diagOverlay = UIView()
    private let diagTextView = UITextView()

    // Updates Overlay
    private let updatesOverlay = UIView()
    private let updatesStatusLabel = UILabel()
    private let updatesDownloadBtn = UIButton(type: .system)
    private var pendingUpdateUrl: String = ""

    // Floating Toast
    private let toastLabel = PaddingLabel(inset: UIEdgeInsets(top: 10, left: 16, bottom: 10, right: 16))

    // MARK: - Lifecycle

    override var prefersStatusBarHidden: Bool {
        return pocketLockActive
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return pocketLockActive ? .lightContent : .darkContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(hex: "#F5F1EA")
        UIApplication.shared.isIdleTimerDisabled = true
        hapticGenerator.prepare()

        loadPrefs()
        cleanOldThumbnails()
        buildUi()
        restorePendingQueue()
        startNetworkMonitors()
        registerAppLifecycleObservers()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        startWorker()
        if pendingCount() > 0 {
            kickRetryQueue(delay: 0.25)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        restoreBrightnessIfNeeded()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: { [weak self] _ in
            self?.galleryCollectionView?.collectionViewLayout.invalidateLayout()
        })
    }

    deinit {
        stopWorker()
        stopNetworkMonitors()
        restoreBrightnessIfNeeded()
        NotificationCenter.default.removeObserver(self)
        lanSession.invalidateAndCancel()
        publicSession.invalidateAndCancel()
    }

    private func registerAppLifecycleObservers() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
    }

    @objc private func handleAppDidBecomeActive() {
        UIApplication.shared.isIdleTimerDisabled = true
        IccCameraHelper.shared.startCameraBrowserOnly()
        startWorker()
        if pocketLockActive {
            UIScreen.main.brightness = 0.01
        }
        if pendingCount() > 0 {
            kickRetryQueue(delay: 0.3)
        }
    }

    @objc private func handleAppWillResignActive() {
        restoreBrightnessIfNeeded()
    }

    @objc private func handleAppDidEnterBackground() {
        restoreBrightnessIfNeeded()
        stopWorker()
    }

    // MARK: - Preferences & URL Helpers

    private func loadPrefs() {
        let ud = UserDefaults.standard
        let savedUrl = ud.string(forKey: Keys.targetUrl) ?? ""
        let vib = ud.object(forKey: Keys.vibrate) as? Bool ?? true
        let saveCard = ud.object(forKey: Keys.saveToCard) as? Bool ?? true
        stateLock.lock()
        targetUrl = savedUrl
        vibrateOnSend = vib
        saveToCardEnabled = saveCard
        stateLock.unlock()
    }

    private func savePrefs() {
        stateLock.lock()
        let url = targetUrl
        let vib = vibrateOnSend
        let saveCard = saveToCardEnabled
        stateLock.unlock()
        let ud = UserDefaults.standard
        ud.set(url.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.targetUrl)
        ud.set(vib, forKey: Keys.vibrate)
        ud.set(saveCard, forKey: Keys.saveToCard)
    }

    private func currentSaveToCard() -> Bool {
        stateLock.lock()
        let v = saveToCardEnabled
        stateLock.unlock()
        return v
    }

    @objc private func saveToCardChanged(_ sender: UISwitch) {
        let on = sender.isOn
        stateLock.lock()
        saveToCardEnabled = on
        stateLock.unlock()
        savePrefs()
        DispatchQueue.global(qos: .userInitiated).async {
            IccCameraHelper.shared.setRovingSaveToCard(on)
        }
    }

    private func currentPrefs() -> (url: String, vibrate: Bool) {
        stateLock.lock()
        let pair = (targetUrl, vibrateOnSend)
        stateLock.unlock()
        return pair
    }

    private func setTargetUrl(_ value: String) {
        stateLock.lock()
        targetUrl = value.trimmingCharacters(in: .whitespacesAndNewlines)
        stateLock.unlock()
    }

    private func currentTargetUrl() -> String {
        stateLock.lock()
        let u = targetUrl
        stateLock.unlock()
        return u
    }

    private func cleanUrl(_ raw: String) -> String {
        var u = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let rx = try? NSRegularExpression(pattern: "/+(?:photos|photo)/?$", options: [.caseInsensitive]) {
            u = rx.stringByReplacingMatches(in: u, range: NSRange(u.startIndex..., in: u), withTemplate: "")
        }
        while u.hasSuffix("/") { u.removeLast() }
        if !u.isEmpty && !u.lowercased().hasPrefix("http://") && !u.lowercased().hasPrefix("https://") {
            u = "http://\(u)"
        }
        return u
    }

    private func currentVersionName() -> String {
        return (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "1.0.2"
    }

    // MARK: - UI Builder

    private func buildUi() {
        let tapDismiss = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        tapDismiss.cancelsTouchesInView = false
        view.addGestureRecognizer(tapDismiss)

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .onDrag
        view.addSubview(scrollView)

        contentStack.axis = .vertical
        contentStack.spacing = 14
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 16),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.leadingAnchor, constant: 18),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.trailingAnchor, constant: -18),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -32)
        ])

        contentStack.addArrangedSubview(buildTopBar())
        contentStack.addArrangedSubview(buildCameraCard())
        contentStack.addArrangedSubview(buildLaptopCard())
        contentStack.addArrangedSubview(buildStatsCard())
        contentStack.addArrangedSubview(buildPendingBanner())
        contentStack.addArrangedSubview(buildActionButtons())
        contentStack.addArrangedSubview(buildGalleryButton())
        contentStack.addArrangedSubview(buildUpdatesCard())

        buildPocketLockOverlay()
        buildGalleryOverlay()
        buildPhotoPreviewOverlay()
        buildDiagOverlay()
        buildUpdatesOverlay()
        buildToast()
    }

    private func makeCardView(bg: UIColor = .white, radius: CGFloat = 16) -> UIView {
        let v = UIView()
        v.backgroundColor = bg
        v.layer.cornerRadius = radius
        v.layer.masksToBounds = true
        return v
    }

    private func makeButton(
        title: String,
        bg: UIColor,
        fg: UIColor = .white,
        fontSize: CGFloat = 14,
        bold: Bool = true,
        radius: CGFloat = 12,
        height: CGFloat = 46,
        action: Selector
    ) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.setTitleColor(fg, for: .normal)
        b.setTitleColor(fg.withAlphaComponent(0.5), for: .disabled)
        b.titleLabel?.font = bold ? .boldSystemFont(ofSize: fontSize) : .systemFont(ofSize: fontSize, weight: .medium)
        b.backgroundColor = bg
        b.layer.cornerRadius = radius
        b.translatesAutoresizingMaskIntoConstraints = false
        b.heightAnchor.constraint(equalToConstant: height).isActive = true
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    private func buildTopBar() -> UIView {
        let bar = UIStackView()
        bar.axis = .horizontal
        bar.alignment = .center
        bar.spacing = 6

        let titleCol = UIStackView()
        titleCol.axis = .vertical
        titleCol.spacing = 2

        let title = UILabel()
        title.text = "📷 Roving DSLR Bridge"
        title.font = .boldSystemFont(ofSize: 19)
        title.textColor = UIColor(hex: "#1C1A1E")
        title.adjustsFontSizeToFitWidth = true
        title.minimumScaleFactor = 0.8

        let sub = UILabel()
        sub.text = "v\(currentVersionName()) • iOS Wired DSLR ➔ Laptop"
        sub.font = .systemFont(ofSize: 12)
        sub.textColor = UIColor(hex: "#8E8884")
        sub.isUserInteractionEnabled = true
        sub.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(showUpdatesOverlay)))

        titleCol.addArrangedSubview(title)
        titleCol.addArrangedSubview(sub)
        bar.addArrangedSubview(titleCol)

        let queueBtn = makeSmallPillButton(title: "🖥️ Queue", bg: UIColor(hex: "#EAF3FA"), fg: UIColor(hex: "#1D6FA5"), action: #selector(openLaptopQueue))
        let guideBtn = makeSmallPillButton(title: "📖", bg: UIColor(hex: "#FCE8E6"), fg: UIColor(hex: "#C93D27"), action: #selector(openGuidePdf))
        let diagBtn = makeSmallPillButton(title: "🩺", bg: UIColor(hex: "#EAF7EF"), fg: UIColor(hex: "#1B7358"), action: #selector(showDiagOverlay))
        let updBtn = makeSmallPillButton(title: "✨", bg: UIColor(hex: "#FEF5E7"), fg: UIColor(hex: "#B86C12"), action: #selector(showUpdatesOverlay))

        bar.addArrangedSubview(queueBtn)
        bar.addArrangedSubview(guideBtn)
        bar.addArrangedSubview(diagBtn)
        bar.addArrangedSubview(updBtn)

        return bar
    }

    private func makeSmallPillButton(title: String, bg: UIColor, fg: UIColor, action: Selector) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.setTitleColor(fg, for: .normal)
        b.titleLabel?.font = .boldSystemFont(ofSize: 12)
        b.backgroundColor = bg
        b.layer.cornerRadius = 14
        b.translatesAutoresizingMaskIntoConstraints = false
        b.heightAnchor.constraint(equalToConstant: 36).isActive = true
        let minW: CGFloat = title.count <= 2 ? 36 : 74
        b.widthAnchor.constraint(greaterThanOrEqualToConstant: minW).isActive = true
        b.contentEdgeInsets = UIEdgeInsets(top: 0, left: 10, bottom: 0, right: 10)
        b.setContentHuggingPriority(.required, for: .horizontal)
        b.setContentCompressionResistancePriority(.required, for: .horizontal)
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    private func buildCameraCard() -> UIView {
        let card = makeCardView(bg: .white, radius: 16)
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        let topRow = UIStackView()
        topRow.axis = .horizontal
        topRow.alignment = .center

        statusPill.text = "● WAITING"
        statusPill.font = .boldSystemFont(ofSize: 11)
        statusPill.textColor = UIColor(hex: "#C93D27")
        statusPill.backgroundColor = UIColor(hex: "#FBEBE8")
        statusPill.layer.cornerRadius = 10
        statusPill.layer.masksToBounds = true
        statusPill.setContentHuggingPriority(.required, for: .horizontal)

        let spacer = UIView()
        let usbHint = UILabel()
        usbHint.text = "USB-C / PTP"
        usbHint.font = .systemFont(ofSize: 11, weight: .semibold)
        usbHint.textColor = UIColor(hex: "#9A958F")

        topRow.addArrangedSubview(statusPill)
        topRow.addArrangedSubview(spacer)
        topRow.addArrangedSubview(usbHint)

        cameraTitleLabel.text = "No DSLR Connected"
        cameraTitleLabel.font = .boldSystemFont(ofSize: 17)
        cameraTitleLabel.textColor = UIColor(hex: "#1C1A1E")

        cameraSubLabel.text = "Plug your Canon, Nikon, or Sony DSLR into this iPhone/iPad with a USB data cable.\nCanon R50/R-series: Menu → Wrench → Choose USB connection app → Photo Import/Remote Control (Wi-Fi OFF)."
        cameraSubLabel.font = .systemFont(ofSize: 12.5)
        cameraSubLabel.textColor = UIColor(hex: "#6B666C")
        cameraSubLabel.numberOfLines = 0

        stack.addArrangedSubview(topRow)
        stack.addArrangedSubview(cameraTitleLabel)
        stack.addArrangedSubview(cameraSubLabel)

        let div = UIView()
        div.backgroundColor = UIColor(hex: "#ECE6DD")
        div.translatesAutoresizingMaskIntoConstraints = false
        div.heightAnchor.constraint(equalToConstant: 1).isActive = true

        let sdRow = UIStackView()
        sdRow.axis = .horizontal
        sdRow.alignment = .center
        sdRow.spacing = 10

        let sdCol = UIStackView()
        sdCol.axis = .vertical
        sdCol.spacing = 2

        let sdTitle = UILabel()
        sdTitle.text = "💾 Save Backup + RAW on Camera SD Card"
        sdTitle.font = .boldSystemFont(ofSize: 13)
        sdTitle.textColor = UIColor(hex: "#1C1A1E")

        let sdHint = UILabel()
        sdHint.text = "Keeps full RAW (.CR3 / .NEF / .ARW) + JPEG on your camera SD card while sending JPEGs to Laptop."
        sdHint.font = .systemFont(ofSize: 11.5)
        sdHint.textColor = UIColor(hex: "#6B666C")
        sdHint.numberOfLines = 0

        sdCol.addArrangedSubview(sdTitle)
        sdCol.addArrangedSubview(sdHint)

        saveToCardSwitch.isOn = currentSaveToCard()
        saveToCardSwitch.onTintColor = UIColor(hex: "#C93D27")
        saveToCardSwitch.setContentHuggingPriority(.required, for: .horizontal)
        saveToCardSwitch.setContentCompressionResistancePriority(.required, for: .horizontal)
        saveToCardSwitch.addTarget(self, action: #selector(saveToCardChanged(_:)), for: .valueChanged)

        sdRow.addArrangedSubview(sdCol)
        sdRow.addArrangedSubview(saveToCardSwitch)

        stack.setCustomSpacing(10, after: cameraSubLabel)
        stack.addArrangedSubview(div)
        stack.addArrangedSubview(sdRow)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -18),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16)
        ])
        return card
    }

    private func buildLaptopCard() -> UIView {
        let card = makeCardView(bg: .white, radius: 16)
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        let title = UILabel()
        title.text = "🎯 Base Station Connection"
        title.font = .boldSystemFont(ofSize: 14.5)
        title.textColor = UIColor(hex: "#1C1A1E")

        let hint = UILabel()
        hint.text = "Point camera at the Photographer Desk QR on your laptop to connect in 1 second:"
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = UIColor(hex: "#8E8884")
        hint.numberOfLines = 0

        let scanBtn = makeButton(
            title: "📷 Scan QR Code on Laptop",
            bg: UIColor(hex: "#C93D27"),
            fg: .white,
            fontSize: 14.5,
            radius: 12,
            height: 48,
            action: #selector(startQrScanner)
        )

        let divider = UILabel()
        divider.text = "— or enter laptop address manually —"
        divider.font = .systemFont(ofSize: 11)
        divider.textColor = UIColor(hex: "#A39DA6")
        divider.textAlignment = .center

        laptopInput.placeholder = "http://192.168.1.100:49152/send/..."
        laptopInput.text = currentTargetUrl()
        laptopInput.font = .systemFont(ofSize: 13.5)
        laptopInput.textColor = UIColor(hex: "#1C1A1E")
        laptopInput.backgroundColor = UIColor(hex: "#F5F1EA")
        laptopInput.layer.cornerRadius = 8
        laptopInput.keyboardType = .URL
        laptopInput.autocapitalizationType = .none
        laptopInput.autocorrectionType = .no
        laptopInput.returnKeyType = .go
        laptopInput.clearButtonMode = .whileEditing
        laptopInput.delegate = self
        laptopInput.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
        laptopInput.leftViewMode = .always
        laptopInput.translatesAutoresizingMaskIntoConstraints = false
        laptopInput.heightAnchor.constraint(equalToConstant: 42).isActive = true

        let btnRow = UIStackView()
        btnRow.axis = .horizontal
        btnRow.spacing = 8

        let saveBtn = makeButton(
            title: "Save & Test Connection",
            bg: UIColor(hex: "#1C1A1E"),
            fg: .white,
            fontSize: 13,
            radius: 10,
            height: 42,
            action: #selector(testConnectionTapped)
        )

        let pasteBtn = makeButton(
            title: "📋 Paste",
            bg: UIColor(hex: "#E4DCCF"),
            fg: UIColor(hex: "#1C1A1E"),
            fontSize: 13,
            radius: 10,
            height: 42,
            action: #selector(pasteFromClipboard)
        )
        pasteBtn.widthAnchor.constraint(equalToConstant: 90).isActive = true

        btnRow.addArrangedSubview(saveBtn)
        btnRow.addArrangedSubview(pasteBtn)

        connectionStatusLabel.text = currentTargetUrl().isEmpty ? "No laptop URL set" : "Target configured"
        connectionStatusLabel.font = .systemFont(ofSize: 12)
        connectionStatusLabel.textColor = UIColor(hex: "#6B666C")
        connectionStatusLabel.numberOfLines = 0

        stack.addArrangedSubview(title)
        stack.addArrangedSubview(hint)
        stack.addArrangedSubview(scanBtn)
        stack.addArrangedSubview(divider)
        stack.addArrangedSubview(laptopInput)
        stack.addArrangedSubview(btnRow)
        stack.addArrangedSubview(connectionStatusLabel)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -18),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16)
        ])
        return card
    }

    private func buildStatsCard() -> UIView {
        let card = makeCardView(bg: .white, radius: 16)
        card.isUserInteractionEnabled = true
        card.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(showGalleryOverlay)))

        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 14
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)

        thumbnailView.backgroundColor = UIColor(hex: "#E4DCCF")
        thumbnailView.contentMode = .scaleAspectFill
        thumbnailView.layer.cornerRadius = 8
        thumbnailView.layer.masksToBounds = true
        thumbnailView.translatesAutoresizingMaskIntoConstraints = false
        thumbnailView.widthAnchor.constraint(equalToConstant: 70).isActive = true
        thumbnailView.heightAnchor.constraint(equalToConstant: 70).isActive = true

        let col = UIStackView()
        col.axis = .vertical
        col.spacing = 3

        statsCountLabel.text = "0 Photos Sent"
        statsCountLabel.font = .boldSystemFont(ofSize: 18)
        statsCountLabel.textColor = UIColor(hex: "#2EA66B")

        lastSentLabel.text = "Waiting for first shutter click…"
        lastSentLabel.font = .systemFont(ofSize: 12)
        lastSentLabel.textColor = UIColor(hex: "#6B666C")
        lastSentLabel.numberOfLines = 2

        let tapHint = UILabel()
        tapHint.text = "🖼️ Tap to view all sent photos ➔"
        tapHint.font = .boldSystemFont(ofSize: 11.5)
        tapHint.textColor = UIColor(hex: "#1D6FA5")

        col.addArrangedSubview(statsCountLabel)
        col.addArrangedSubview(lastSentLabel)
        col.addArrangedSubview(tapHint)

        row.addArrangedSubview(thumbnailView)
        row.addArrangedSubview(col)

        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
            row.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            row.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -18),
            row.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16)
        ])
        return card
    }

    private func buildPendingBanner() -> UIView {
        pendingBanner.backgroundColor = UIColor(hex: "#FEF5E7")
        pendingBanner.layer.cornerRadius = 14
        pendingBanner.isHidden = true

        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        pendingBanner.addSubview(row)

        pendingBannerLabel.text = "⏳ 0 queued — auto-uploads when Wi-Fi returns"
        pendingBannerLabel.font = .boldSystemFont(ofSize: 12)
        pendingBannerLabel.textColor = UIColor(hex: "#9A5B04")
        pendingBannerLabel.numberOfLines = 0

        let retryBtn = makeButton(
            title: "🔄 Retry Now",
            bg: UIColor(hex: "#D97706"),
            fg: .white,
            fontSize: 12,
            radius: 10,
            height: 36,
            action: #selector(retryPendingNow)
        )
        retryBtn.contentEdgeInsets = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
        retryBtn.setContentHuggingPriority(.required, for: .horizontal)
        retryBtn.setContentCompressionResistancePriority(.required, for: .horizontal)

        row.addArrangedSubview(pendingBannerLabel)
        row.addArrangedSubview(retryBtn)

        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: pendingBanner.topAnchor, constant: 10),
            row.leadingAnchor.constraint(equalTo: pendingBanner.leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: pendingBanner.trailingAnchor, constant: -14),
            row.bottomAnchor.constraint(equalTo: pendingBanner.bottomAnchor, constant: -10)
        ])
        return pendingBanner
    }

    private func buildActionButtons() -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 12
        row.distribution = .fillEqually

        triggerButton.setTitle("📸 Test Shutter", for: .normal)
        triggerButton.setTitleColor(.white, for: .normal)
        triggerButton.setTitleColor(UIColor.white.withAlphaComponent(0.55), for: .disabled)
        triggerButton.titleLabel?.font = .boldSystemFont(ofSize: 14.5)
        triggerButton.backgroundColor = UIColor(hex: "#2EA66B")
        triggerButton.layer.cornerRadius = 12
        triggerButton.isEnabled = false
        triggerButton.translatesAutoresizingMaskIntoConstraints = false
        triggerButton.heightAnchor.constraint(equalToConstant: 48).isActive = true
        triggerButton.addTarget(self, action: #selector(testShutterTrigger), for: .touchUpInside)

        let pocketBtn = makeButton(
            title: "🔒 Pocket Mode",
            bg: UIColor(hex: "#5A535C"),
            fg: .white,
            fontSize: 14.5,
            radius: 12,
            height: 48,
            action: #selector(showPocketLock)
        )

        row.addArrangedSubview(triggerButton)
        row.addArrangedSubview(pocketBtn)
        return row
    }

    private func buildGalleryButton() -> UIView {
        return makeButton(
            title: "🖼️ View Sent Photos Gallery",
            bg: UIColor(hex: "#E4DCCF"),
            fg: UIColor(hex: "#1C1A1E"),
            fontSize: 14,
            radius: 12,
            height: 46,
            action: #selector(showGalleryOverlay)
        )
    }

    private func buildUpdatesCard() -> UIView {
        let card = makeCardView(bg: .white, radius: 14)
        card.isUserInteractionEnabled = true
        card.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(showUpdatesOverlay)))

        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)

        let col = UIStackView()
        col.axis = .vertical
        col.spacing = 2

        let t = UILabel()
        t.text = "✨ Version v\(currentVersionName()) • What's New"
        t.font = .boldSystemFont(ofSize: 13)
        t.textColor = UIColor(hex: "#1C1A1E")

        let s = UILabel()
        s.text = "Check online updates & release changelog"
        s.font = .systemFont(ofSize: 11.5)
        s.textColor = UIColor(hex: "#8E8884")

        col.addArrangedSubview(t)
        col.addArrangedSubview(s)

        let btn = makeSmallPillButton(title: "Updates ➔", bg: UIColor(hex: "#EAF3FA"), fg: UIColor(hex: "#1D6FA5"), action: #selector(showUpdatesOverlay))

        row.addArrangedSubview(col)
        row.addArrangedSubview(btn)

        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: card.topAnchor, constant: 12),
            row.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
            row.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12)
        ])
        return card
    }

    // MARK: - Pocket Lock Overlay (OLED Black, Foreground USB Keep-Alive)

    private func buildPocketLockOverlay() {
        pocketLockOverlay.backgroundColor = .black
        pocketLockOverlay.isHidden = true
        pocketLockOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(pocketLockOverlay)

        let col = UIStackView()
        col.axis = .vertical
        col.alignment = .center
        col.spacing = 10
        col.translatesAutoresizingMaskIntoConstraints = false
        pocketLockOverlay.addSubview(col)

        let icon = UILabel()
        icon.text = "🔒"
        icon.font = .systemFont(ofSize: 48)

        let title = UILabel()
        title.text = "Pocket Lock Active"
        title.font = .boldSystemFont(ofSize: 20)
        title.textColor = .white

        let sub = UILabel()
        sub.text = "Shutter is LIVE. Clicks beam to laptop\n(or queue safely if Wi-Fi drops).\n\nKeep screen open — do NOT press the iPhone side lock button (iOS pauses USB if locked)."
        sub.font = .systemFont(ofSize: 13)
        sub.textColor = UIColor(hex: "#9A958F")
        sub.textAlignment = .center
        sub.numberOfLines = 0

        pocketStatsLabel.text = "Sent: 0"
        pocketStatsLabel.font = .boldSystemFont(ofSize: 13)
        pocketStatsLabel.textColor = UIColor(hex: "#C4BEB9")

        pocketUnlockBtn.setTitle("Tap 3 times to Unlock", for: .normal)
        pocketUnlockBtn.setTitleColor(.white, for: .normal)
        pocketUnlockBtn.titleLabel?.font = .boldSystemFont(ofSize: 14)
        pocketUnlockBtn.backgroundColor = UIColor(hex: "#252329")
        pocketUnlockBtn.layer.cornerRadius = 12
        pocketUnlockBtn.translatesAutoresizingMaskIntoConstraints = false
        pocketUnlockBtn.widthAnchor.constraint(equalToConstant: 230).isActive = true
        pocketUnlockBtn.heightAnchor.constraint(equalToConstant: 48).isActive = true
        pocketUnlockBtn.addTarget(self, action: #selector(pocketUnlockTapped), for: .touchUpInside)

        col.addArrangedSubview(icon)
        col.addArrangedSubview(title)
        col.addArrangedSubview(sub)
        col.addArrangedSubview(pocketStatsLabel)
        col.setCustomSpacing(28, after: pocketStatsLabel)
        col.addArrangedSubview(pocketUnlockBtn)

        NSLayoutConstraint.activate([
            pocketLockOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            pocketLockOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            pocketLockOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pocketLockOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            col.centerXAnchor.constraint(equalTo: pocketLockOverlay.centerXAnchor),
            col.centerYAnchor.constraint(equalTo: pocketLockOverlay.centerYAnchor),
            col.leadingAnchor.constraint(greaterThanOrEqualTo: pocketLockOverlay.leadingAnchor, constant: 28),
            col.trailingAnchor.constraint(lessThanOrEqualTo: pocketLockOverlay.trailingAnchor, constant: -28)
        ])
    }

    @objc private func showPocketLock() {
        dismissKeyboard()
        pocketLockActive = true
        pocketTapCount = 0
        pocketUnlockBtn.setTitle("Tap 3 times to Unlock", for: .normal)
        pocketLockOverlay.isHidden = false
        if savedBrightness == nil {
            savedBrightness = UIScreen.main.brightness
        }
        UIScreen.main.brightness = 0.01
        UIApplication.shared.isIdleTimerDisabled = true
        setNeedsStatusBarAppearanceUpdate()
        refreshQueueUi()
        showToast("Pocket Lock ON. Keep screen open — shutter is live!")
    }

    private func hidePocketLock() {
        pocketLockActive = false
        pocketTapCount = 0
        pocketResetWorkItem?.cancel()
        pocketLockOverlay.isHidden = true
        restoreBrightnessIfNeeded()
        setNeedsStatusBarAppearanceUpdate()
    }

    private func restoreBrightnessIfNeeded() {
        if let prev = savedBrightness {
            UIScreen.main.brightness = prev
            savedBrightness = nil
        }
    }

    @objc private func pocketUnlockTapped() {
        pocketResetWorkItem?.cancel()
        pocketTapCount += 1
        if pocketTapCount >= 3 {
            hidePocketLock()
        } else {
            pocketUnlockBtn.setTitle("Tap \(3 - pocketTapCount) more times…", for: .normal)
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, self.pocketLockActive else { return }
                self.pocketTapCount = 0
                self.pocketUnlockBtn.setTitle("Tap 3 times to Unlock", for: .normal)
            }
            pocketResetWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0, execute: work)
        }
    }

    // MARK: - Session Gallery Overlay

    private func buildGalleryOverlay() {
        galleryOverlay.backgroundColor = UIColor(hex: "#F5F1EA")
        galleryOverlay.isHidden = true
        galleryOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(galleryOverlay)

        let topBar = UIStackView()
        topBar.axis = .horizontal
        topBar.alignment = .center
        topBar.spacing = 6
        topBar.translatesAutoresizingMaskIntoConstraints = false

        galleryTitleLabel.text = "📸 Sent Photos (0)"
        galleryTitleLabel.font = .boldSystemFont(ofSize: 17)
        galleryTitleLabel.textColor = UIColor(hex: "#1C1A1E")
        galleryTitleLabel.adjustsFontSizeToFitWidth = true
        galleryTitleLabel.minimumScaleFactor = 0.75

        galleryRetryBtn.setTitle("🔄 Retry (0)", for: .normal)
        galleryRetryBtn.setTitleColor(.white, for: .normal)
        galleryRetryBtn.titleLabel?.font = .boldSystemFont(ofSize: 12)
        galleryRetryBtn.backgroundColor = UIColor(hex: "#D97706")
        galleryRetryBtn.layer.cornerRadius = 14
        galleryRetryBtn.contentEdgeInsets = UIEdgeInsets(top: 0, left: 10, bottom: 0, right: 10)
        galleryRetryBtn.isHidden = true
        galleryRetryBtn.setContentHuggingPriority(.required, for: .horizontal)
        galleryRetryBtn.setContentCompressionResistancePriority(.required, for: .horizontal)
        galleryRetryBtn.translatesAutoresizingMaskIntoConstraints = false
        galleryRetryBtn.heightAnchor.constraint(equalToConstant: 36).isActive = true
        galleryRetryBtn.addTarget(self, action: #selector(retryPendingNow), for: .touchUpInside)

        let laptopQBtn = makeSmallPillButton(title: "🖥️ Queue", bg: UIColor(hex: "#EAF3FA"), fg: UIColor(hex: "#1D6FA5"), action: #selector(openLaptopQueue))
        let clearBtn = makeSmallPillButton(title: "🗑️", bg: UIColor(hex: "#E4DCCF"), fg: UIColor(hex: "#1C1A1E"), action: #selector(clearSessionGallery))
        let closeBtn = makeSmallPillButton(title: "✕", bg: UIColor(hex: "#E4DCCF"), fg: UIColor(hex: "#6B666C"), action: #selector(hideGalleryOverlay))

        topBar.addArrangedSubview(galleryTitleLabel)
        topBar.addArrangedSubview(galleryRetryBtn)
        topBar.addArrangedSubview(laptopQBtn)
        topBar.addArrangedSubview(clearBtn)
        topBar.addArrangedSubview(closeBtn)

        let subHint = UILabel()
        subHint.text = "Tap any photo to enlarge • Unsent shots auto-upload when Wi-Fi reconnects."
        subHint.font = .systemFont(ofSize: 11.5)
        subHint.textColor = UIColor(hex: "#8E8884")
        subHint.numberOfLines = 0
        subHint.translatesAutoresizingMaskIntoConstraints = false

        galleryEmptyLabel.text = "No photos taken yet in this session.\n\nConnect your DSLR and snap photos with the camera shutter — they will stream to the laptop and appear here!"
        galleryEmptyLabel.font = .systemFont(ofSize: 13.5)
        galleryEmptyLabel.textColor = UIColor(hex: "#8E8884")
        galleryEmptyLabel.textAlignment = .center
        galleryEmptyLabel.numberOfLines = 0
        galleryEmptyLabel.translatesAutoresizingMaskIntoConstraints = false

        let layout = UICollectionViewFlowLayout()
        layout.minimumInteritemSpacing = 8
        layout.minimumLineSpacing = 8
        galleryCollectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        galleryCollectionView.backgroundColor = .clear
        galleryCollectionView.dataSource = self
        galleryCollectionView.delegate = self
        galleryCollectionView.register(PhotoGridCell.self, forCellWithReuseIdentifier: PhotoGridCell.reuseId)
        galleryCollectionView.isHidden = true
        galleryCollectionView.translatesAutoresizingMaskIntoConstraints = false

        galleryOverlay.addSubview(topBar)
        galleryOverlay.addSubview(subHint)
        galleryOverlay.addSubview(galleryEmptyLabel)
        galleryOverlay.addSubview(galleryCollectionView)

        NSLayoutConstraint.activate([
            galleryOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            galleryOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            galleryOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            galleryOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            topBar.topAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.topAnchor, constant: 14),
            topBar.leadingAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            topBar.trailingAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.trailingAnchor, constant: -16),

            subHint.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 6),
            subHint.leadingAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            subHint.trailingAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.trailingAnchor, constant: -16),

            galleryEmptyLabel.centerYAnchor.constraint(equalTo: galleryOverlay.centerYAnchor),
            galleryEmptyLabel.leadingAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.leadingAnchor, constant: 32),
            galleryEmptyLabel.trailingAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.trailingAnchor, constant: -32),

            galleryCollectionView.topAnchor.constraint(equalTo: subHint.bottomAnchor, constant: 12),
            galleryCollectionView.leadingAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            galleryCollectionView.trailingAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            galleryCollectionView.bottomAnchor.constraint(equalTo: galleryOverlay.safeAreaLayoutGuide.bottomAnchor, constant: -12)
        ])
    }

    @objc private func showGalleryOverlay() {
        notifyGalleryChanged()
        galleryOverlay.isHidden = false
    }

    @objc private func hideGalleryOverlay() {
        galleryOverlay.isHidden = true
    }

    // MARK: - Fullscreen Photo Preview Overlay

    private func buildPhotoPreviewOverlay() {
        photoPreviewOverlay.backgroundColor = UIColor.black.withAlphaComponent(0.9)
        photoPreviewOverlay.isHidden = true
        photoPreviewOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(photoPreviewOverlay)

        let card = makeCardView(bg: UIColor(hex: "#1C1A1E"), radius: 16)
        card.translatesAutoresizingMaskIntoConstraints = false
        photoPreviewOverlay.addSubview(card)

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        let head = UIStackView()
        head.axis = .horizontal
        head.alignment = .center

        let infoCol = UIStackView()
        infoCol.axis = .vertical
        infoCol.spacing = 2

        previewInfoLabel.text = "Photo Preview"
        previewInfoLabel.font = .boldSystemFont(ofSize: 14)
        previewInfoLabel.textColor = .white

        previewStatusLabel.text = "● Sent to Laptop Base Station"
        previewStatusLabel.font = .systemFont(ofSize: 11.5, weight: .semibold)
        previewStatusLabel.textColor = UIColor(hex: "#2EA66B")

        infoCol.addArrangedSubview(previewInfoLabel)
        infoCol.addArrangedSubview(previewStatusLabel)

        let closeBtn = makeSmallPillButton(title: "✕", bg: UIColor(hex: "#332F36"), fg: .white, action: #selector(hidePhotoPreview))

        head.addArrangedSubview(infoCol)
        head.addArrangedSubview(closeBtn)

        previewImageView.contentMode = .scaleAspectFit
        previewImageView.backgroundColor = .black
        previewImageView.layer.cornerRadius = 10
        previewImageView.layer.masksToBounds = true
        previewImageView.translatesAutoresizingMaskIntoConstraints = false
        previewImageView.heightAnchor.constraint(equalToConstant: 320).isActive = true

        let btnRow = UIStackView()
        btnRow.axis = .horizontal
        btnRow.spacing = 8

        previewRetryBtn.setTitle("🔄 Send Now", for: .normal)
        previewRetryBtn.setTitleColor(.white, for: .normal)
        previewRetryBtn.titleLabel?.font = .boldSystemFont(ofSize: 13)
        previewRetryBtn.backgroundColor = UIColor(hex: "#D97706")
        previewRetryBtn.layer.cornerRadius = 10
        previewRetryBtn.contentEdgeInsets = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
        previewRetryBtn.isHidden = true
        previewRetryBtn.translatesAutoresizingMaskIntoConstraints = false
        previewRetryBtn.heightAnchor.constraint(equalToConstant: 42).isActive = true
        previewRetryBtn.setContentHuggingPriority(.required, for: .horizontal)
        previewRetryBtn.addTarget(self, action: #selector(retryPendingNow), for: .touchUpInside)

        let queueBtn = makeButton(title: "🖥️ Laptop Queue", bg: UIColor(hex: "#1D6FA5"), fg: .white, fontSize: 13, radius: 10, height: 42, action: #selector(openLaptopQueueFromPreview))
        let dismissBtn = makeButton(title: "Close", bg: UIColor(hex: "#332F36"), fg: .white, fontSize: 13, radius: 10, height: 42, action: #selector(hidePhotoPreview))
        dismissBtn.widthAnchor.constraint(equalToConstant: 78).isActive = true

        btnRow.addArrangedSubview(previewRetryBtn)
        btnRow.addArrangedSubview(queueBtn)
        btnRow.addArrangedSubview(dismissBtn)

        stack.addArrangedSubview(head)
        stack.addArrangedSubview(previewImageView)
        stack.addArrangedSubview(btnRow)

        NSLayoutConstraint.activate([
            photoPreviewOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            photoPreviewOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            photoPreviewOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            photoPreviewOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            card.centerYAnchor.constraint(equalTo: photoPreviewOverlay.centerYAnchor),
            card.leadingAnchor.constraint(equalTo: photoPreviewOverlay.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            card.trailingAnchor.constraint(equalTo: photoPreviewOverlay.safeAreaLayoutGuide.trailingAnchor, constant: -16),

            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16)
        ])
    }

    private func showPhotoPreview(_ photo: SessionPhoto) {
        previewingPhoto = photo
        previewImageView.image = UIImage(contentsOfFile: photo.thumbUrl.path)
        let mb = String(format: "%.1f MB", Double(photo.sizeBytes) / (1024.0 * 1024.0))
        previewInfoLabel.text = "Captured at \(photo.timeStr) • \(mb)"

        if photo.success {
            previewStatusLabel.text = "● Sent to Laptop Base Station"
            previewStatusLabel.textColor = UIColor(hex: "#2EA66B")
            previewRetryBtn.isHidden = true
        } else if let p = photo.pendingUrl, FileManager.default.fileExists(atPath: p.path) {
            previewStatusLabel.text = "● Queued — auto-uploads when Wi-Fi reconnects"
            previewStatusLabel.textColor = UIColor(hex: "#F59E0B")
            previewRetryBtn.isHidden = false
        } else {
            previewStatusLabel.text = "● Upload Failed / Local Backup"
            previewStatusLabel.textColor = UIColor(hex: "#C93D27")
            previewRetryBtn.isHidden = true
        }
        photoPreviewOverlay.isHidden = false
    }

    @objc private func hidePhotoPreview() {
        previewingPhoto = nil
        photoPreviewOverlay.isHidden = true
    }

    @objc private func openLaptopQueueFromPreview() {
        hidePhotoPreview()
        openLaptopQueue()
    }

    // MARK: - USB Diagnostics Overlay

    private func buildDiagOverlay() {
        diagOverlay.backgroundColor = UIColor(hex: "#F5F1EA")
        diagOverlay.isHidden = true
        diagOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(diagOverlay)

        let topBar = UIStackView()
        topBar.axis = .horizontal
        topBar.alignment = .center
        topBar.spacing = 8
        topBar.translatesAutoresizingMaskIntoConstraints = false

        let title = UILabel()
        title.text = "🩺 USB Diagnostics"
        title.font = .boldSystemFont(ofSize: 17)
        title.textColor = UIColor(hex: "#1C1A1E")
        title.adjustsFontSizeToFitWidth = true
        title.minimumScaleFactor = 0.75

        let refreshBtn = makeSmallPillButton(title: "🔄 Refresh", bg: UIColor(hex: "#EAF7EF"), fg: UIColor(hex: "#1B7358"), action: #selector(refreshDiagText))
        let copyBtn = makeSmallPillButton(title: "📋 Copy", bg: UIColor(hex: "#EAF3FA"), fg: UIColor(hex: "#1D6FA5"), action: #selector(copyDiagLogs))
        let closeBtn = makeSmallPillButton(title: "✕", bg: UIColor(hex: "#E4DCCF"), fg: UIColor(hex: "#6B666C"), action: #selector(hideDiagOverlay))

        topBar.addArrangedSubview(title)
        topBar.addArrangedSubview(refreshBtn)
        topBar.addArrangedSubview(copyBtn)
        topBar.addArrangedSubview(closeBtn)

        diagTextView.isEditable = false
        diagTextView.backgroundColor = .white
        diagTextView.textColor = UIColor(hex: "#1C1A1E")
        diagTextView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        diagTextView.layer.cornerRadius = 14
        diagTextView.textContainerInset = UIEdgeInsets(top: 14, left: 12, bottom: 14, right: 12)
        diagTextView.translatesAutoresizingMaskIntoConstraints = false

        diagOverlay.addSubview(topBar)
        diagOverlay.addSubview(diagTextView)

        NSLayoutConstraint.activate([
            diagOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            diagOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            diagOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            diagOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            topBar.topAnchor.constraint(equalTo: diagOverlay.safeAreaLayoutGuide.topAnchor, constant: 14),
            topBar.leadingAnchor.constraint(equalTo: diagOverlay.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            topBar.trailingAnchor.constraint(equalTo: diagOverlay.safeAreaLayoutGuide.trailingAnchor, constant: -16),

            diagTextView.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 12),
            diagTextView.leadingAnchor.constraint(equalTo: diagOverlay.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            diagTextView.trailingAnchor.constraint(equalTo: diagOverlay.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            diagTextView.bottomAnchor.constraint(equalTo: diagOverlay.safeAreaLayoutGuide.bottomAnchor, constant: -16)
        ])
    }

    @objc private func showDiagOverlay() {
        refreshDiagText()
        diagOverlay.isHidden = false
    }

    @objc private func hideDiagOverlay() {
        diagOverlay.isHidden = true
    }

    @objc private func refreshDiagText() {
        let cam = IccCameraHelper.shared
        let discovered = cam.discoveredCameraNames()
        let logs = cam.diagLogs()
        let err = cam.lastErrorText()
        let txt = """
        === iOS Roving DSLR Bridge v\(currentVersionName()) ===
        Camera open: \(cam.isCameraOpen() ? "YES (\(cam.cameraName()))" : "NO")
        Battery: \(cam.cameraBattery() >= 0 ? "\(cam.cameraBattery())%" : "N/A")
        USB devices discovered: \(discovered.isEmpty ? "none" : discovered.joined(separator: ", "))
        Last error: \(err.isEmpty ? "none" : err)
        Base station URL: \(currentTargetUrl().isEmpty ? "(not set)" : currentTargetUrl())
        Queued photos on disk: \(pendingCount())

        === Quick Camera Checklist ===
        • Canon EOS R50 / R-series:
          - Menu → Wrench → Choose USB connection app → Photo Import/Remote Control
          - Do NOT pick "Canon app(s) for iPhone" or "Video calls/streaming"
          - Wi-Fi / Bluetooth OFF, Mode dial M/Av/Tv/P, JPEG or RAW+JPEG, SD card inserted
          - iPhone 15/16/17: direct USB-C data cable (not charge-only)
          - Lightning iPhone: Apple Lightning to USB 3 Camera Adapter + power bank
        • Nikon (D5300 / D5600 / Z-series):
          - Airplane mode / Wi-Fi OFF, SD card inserted (with free space), JPEG or RAW+JPEG
          - Use data-capable USB cable (iPhone 15/16/17 USB-C, or Apple USB 3 Camera Adapter + power)
        • Sony Alpha: USB Connection = PC Remote, Save Dest = PC + Camera, JPEG
        • Local Wi-Fi Upload: iPhone Settings → Privacy & Security → Local Network → Roving DSLR Bridge = ON

        === ImageCaptureCore / PTP Log ===
        \(logs.isEmpty ? "(no logs yet)" : logs.joined(separator: "\n"))
        """
        diagTextView.text = txt
    }

    @objc private func copyDiagLogs() {
        UIPasteboard.general.string = diagTextView.text
        showToast("Diagnostics copied to clipboard")
    }

    // MARK: - Updates & Changelog Overlay

    private func buildUpdatesOverlay() {
        updatesOverlay.backgroundColor = UIColor(hex: "#F5F1EA")
        updatesOverlay.isHidden = true
        updatesOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(updatesOverlay)

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        updatesOverlay.addSubview(scroll)

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)

        let topBar = UIStackView()
        topBar.axis = .horizontal
        topBar.alignment = .center

        let title = UILabel()
        title.text = "✨ App Updates & What's New"
        title.font = .boldSystemFont(ofSize: 18)
        title.textColor = UIColor(hex: "#1C1A1E")

        let closeBtn = makeSmallPillButton(title: "✕", bg: UIColor(hex: "#E4DCCF"), fg: UIColor(hex: "#6B666C"), action: #selector(hideUpdatesOverlay))
        topBar.addArrangedSubview(title)
        topBar.addArrangedSubview(closeBtn)

        let checkCard = makeCardView(bg: .white, radius: 16)
        let checkStack = UIStackView()
        checkStack.axis = .vertical
        checkStack.spacing = 8
        checkStack.translatesAutoresizingMaskIntoConstraints = false
        checkCard.addSubview(checkStack)

        let curVer = UILabel()
        curVer.text = "Installed Version: v\(currentVersionName())"
        curVer.font = .boldSystemFont(ofSize: 15)
        curVer.textColor = UIColor(hex: "#1C1A1E")

        updatesStatusLabel.text = "Tap 'Check Online' to verify the latest iOS release on GitHub."
        updatesStatusLabel.font = .systemFont(ofSize: 12)
        updatesStatusLabel.textColor = UIColor(hex: "#6B666C")
        updatesStatusLabel.numberOfLines = 0

        let btnRow = UIStackView()
        btnRow.axis = .horizontal
        btnRow.spacing = 8

        let checkBtn = makeButton(title: "🔄 Check Online", bg: UIColor(hex: "#1C1A1E"), fg: .white, fontSize: 13, radius: 10, height: 42, action: #selector(checkOnlineUpdates))
        let webBtn = makeButton(title: "🌐 Downloads", bg: UIColor(hex: "#EAF3FA"), fg: UIColor(hex: "#1D6FA5"), fontSize: 12.5, radius: 10, height: 42, action: #selector(openDownloadsPage))
        webBtn.widthAnchor.constraint(equalToConstant: 122).isActive = true

        btnRow.addArrangedSubview(checkBtn)
        btnRow.addArrangedSubview(webBtn)

        updatesDownloadBtn.setTitle("📥 Download Update (.ipa)", for: .normal)
        updatesDownloadBtn.setTitleColor(.white, for: .normal)
        updatesDownloadBtn.titleLabel?.font = .boldSystemFont(ofSize: 13.5)
        updatesDownloadBtn.backgroundColor = UIColor(hex: "#2EA66B")
        updatesDownloadBtn.layer.cornerRadius = 10
        updatesDownloadBtn.isHidden = true
        updatesDownloadBtn.translatesAutoresizingMaskIntoConstraints = false
        updatesDownloadBtn.heightAnchor.constraint(equalToConstant: 44).isActive = true
        updatesDownloadBtn.addTarget(self, action: #selector(openPendingUpdateUrl), for: .touchUpInside)

        checkStack.addArrangedSubview(curVer)
        checkStack.addArrangedSubview(updatesStatusLabel)
        checkStack.addArrangedSubview(btnRow)
        checkStack.addArrangedSubview(updatesDownloadBtn)

        NSLayoutConstraint.activate([
            checkStack.topAnchor.constraint(equalTo: checkCard.topAnchor, constant: 16),
            checkStack.leadingAnchor.constraint(equalTo: checkCard.leadingAnchor, constant: 18),
            checkStack.trailingAnchor.constraint(equalTo: checkCard.trailingAnchor, constant: -18),
            checkStack.bottomAnchor.constraint(equalTo: checkCard.bottomAnchor, constant: -16)
        ])

        let notesHeader = UILabel()
        notesHeader.text = "📜 Release Notes"
        notesHeader.font = .boldSystemFont(ofSize: 15)
        notesHeader.textColor = UIColor(hex: "#1C1A1E")

        func makeReleaseNoteCard(title: String, body: String) -> UIView {
            let card = makeCardView(bg: .white, radius: 14)
            let noteStack = UIStackView()
            noteStack.axis = .vertical
            noteStack.spacing = 6
            noteStack.translatesAutoresizingMaskIntoConstraints = false
            card.addSubview(noteStack)

            let h = UILabel()
            h.text = title
            h.font = .boldSystemFont(ofSize: 14)
            h.textColor = UIColor(hex: "#1B7358")

            let b = UILabel()
            b.text = body
            b.font = .systemFont(ofSize: 12.5)
            b.textColor = UIColor(hex: "#423D44")
            b.numberOfLines = 0

            noteStack.addArrangedSubview(h)
            noteStack.addArrangedSubview(b)

            NSLayoutConstraint.activate([
                noteStack.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),
                noteStack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
                noteStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
                noteStack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14)
            ])
            return card
        }

        let card102 = makeReleaseNoteCard(
            title: "Version 1.0.2 (Current Release)",
            body: """
            • 💾 Save Backup + RAW on Camera SD Card: Keeps full RAW + JPEG copies safely on your camera SD card while sending JPEGs to your laptop.
            • 📶 Faster Reconnect Retry: Speeds up automatic upload retries when booth Wi-Fi briefly drops.
            • 🛠️ Nikon Live View Capture Reliability: Ensures smoother transition from Live View to SD-card shutter capture.
            """
        )

        let card100 = makeReleaseNoteCard(
            title: "Version 1.0.0 (Initial iOS Release)",
            body: """
            • 🚀 Standalone iPhone & iPad Companion: Dedicated app (com.photobooth4u.rovingbridge) with zero booth code or kiosk lock.
            • 🔌 Wired USB-C / PTP DSLR Support: Native ImageCaptureCore PTP for Canon EOS (incl. EOS R50 / R-series), Nikon, Sony Alpha, and passive PTP fallback.
            • 🎯 1-Second QR Pairing: Scan the Photographer Desk QR on your laptop to connect immediately.
            • 📶 Offline Booth Wi-Fi Routing: Keeps local LAN transfers strictly on Wi-Fi even with 4G/5G cellular data enabled.
            • 📦 Offline Disk Queue & Auto-Retry: Saves full-res JPEGs safely on disk if Wi-Fi drops and resumes automatically on reconnect.
            • 🔒 OLED Pocket Mode & Haptic Buzz: Pure black screen, dimmed brightness, 3-tap unlock, and pocket vibration on every delivery.
            """
        )

        stack.addArrangedSubview(topBar)
        stack.addArrangedSubview(checkCard)
        stack.addArrangedSubview(notesHeader)
        stack.addArrangedSubview(card102)
        stack.addArrangedSubview(card100)

        NSLayoutConstraint.activate([
            updatesOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            updatesOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            updatesOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            updatesOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            scroll.topAnchor.constraint(equalTo: updatesOverlay.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: updatesOverlay.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: updatesOverlay.safeAreaLayoutGuide.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: updatesOverlay.bottomAnchor),

            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32)
        ])
    }

    @objc private func showUpdatesOverlay() {
        updatesOverlay.isHidden = false
        checkOnlineUpdates()
    }

    @objc private func hideUpdatesOverlay() {
        updatesOverlay.isHidden = true
    }

    @objc private func openDownloadsPage() {
        openExternalUrl("https://photobooth4u.netlify.app/downloads/#roving-bridge")
    }

    @objc private func openGuidePdf() {
        openExternalUrl("https://photobooth4u.netlify.app/photobooth4u-roving-dslr-guide.pdf")
    }

    @objc private func openPendingUpdateUrl() {
        let target = pendingUpdateUrl.isEmpty ? "https://photobooth4u.netlify.app/downloads/#roving-bridge" : pendingUpdateUrl
        openExternalUrl(target)
    }

    private func openExternalUrl(_ str: String) {
        guard let url = URL(string: str) else {
            showToast("Invalid URL")
            return
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    @objc private func checkOnlineUpdates() {
        updatesStatusLabel.text = "Checking GitHub for updates…"
        updatesStatusLabel.textColor = UIColor(hex: "#6B666C")
        updatesDownloadBtn.isHidden = true
        pendingUpdateUrl = ""

        guard let url = URL(string: "https://api.github.com/repos/heresmetrying26/photobooth-for-rent/releases?per_page=60") else { return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        req.setValue("photobooth4u-roving-bridge-ios", forHTTPHeaderField: "User-Agent")
        req.setValue("application/vnd.github.v3+json", forHTTPHeaderField: "Accept")

        publicSession.dataTask(with: req) { [weak self] data, resp, _ in
            guard let self = self else { return }
            var latestTag = ""
            var dlUrl = ""
            if let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode),
               let data = data,
               let arr = try? JSONSerialization.jsonObject(with: data, options: []) as? [[String: Any]] {
                for obj in arr {
                    if (obj["draft"] as? Bool) == true { continue }
                    guard let tag = obj["tag_name"] as? String, tag.hasPrefix("roving-ios-v") else { continue }
                    let ver = String(tag.dropFirst("roving-ios-v".count))
                    if latestTag.isEmpty || self.compareVersions(ver, latestTag) > 0 {
                        latestTag = ver
                        dlUrl = ""
                        if let assets = obj["assets"] as? [[String: Any]] {
                            for asset in assets {
                                if (asset["name"] as? String) == "roving-dslr-bridge-ios.ipa",
                                   let u = asset["browser_download_url"] as? String {
                                    dlUrl = u
                                    break
                                }
                            }
                        }
                    }
                }
            }

            DispatchQueue.main.async {
                let currentVer = self.currentVersionName()
                if !latestTag.isEmpty {
                    if self.compareVersions(latestTag, currentVer) > 0 {
                        self.pendingUpdateUrl = dlUrl
                        self.updatesStatusLabel.text = "🚀 New version v\(latestTag) is available!"
                        self.updatesStatusLabel.textColor = UIColor(hex: "#2EA66B")
                        self.updatesDownloadBtn.setTitle("📥 Download v\(latestTag) IPA", for: .normal)
                        self.updatesDownloadBtn.isHidden = false
                    } else {
                        self.updatesStatusLabel.text = "✅ You're up to date (v\(currentVer) is the latest)."
                        self.updatesStatusLabel.textColor = UIColor(hex: "#2EA66B")
                    }
                } else {
                    self.updatesStatusLabel.text = "Could not check online (offline or no release published yet)."
                    self.updatesStatusLabel.textColor = UIColor(hex: "#6B666C")
                }
            }
        }.resume()
    }

    private func compareVersions(_ v1: String, _ v2: String) -> Int {
        let p1 = v1.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "v", with: "").split(separator: ".").compactMap { Int($0) }
        let p2 = v2.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "v", with: "").split(separator: ".").compactMap { Int($0) }
        let count = max(p1.count, p2.count)
        for i in 0..<count {
            let a = i < p1.count ? p1[i] : 0
            let b = i < p2.count ? p2[i] : 0
            if a != b { return a < b ? -1 : 1 }
        }
        return 0
    }

    // MARK: - Floating Toast

    private func buildToast() {
        toastLabel.backgroundColor = UIColor(hex: "#1C1A1E").withAlphaComponent(0.92)
        toastLabel.textColor = .white
        toastLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        toastLabel.textAlignment = .center
        toastLabel.numberOfLines = 2
        toastLabel.layer.cornerRadius = 18
        toastLabel.layer.masksToBounds = true
        toastLabel.alpha = 0
        toastLabel.isUserInteractionEnabled = false
        toastLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(toastLabel)

        NSLayoutConstraint.activate([
            toastLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            toastLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            toastLabel.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            toastLabel.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24)
        ])
    }

    private func showToast(_ message: String, duration: TimeInterval = 2.6) {
        DispatchQueue.main.async {
            self.toastWorkItem?.cancel()
            self.toastLabel.text = message
            self.view.bringSubviewToFront(self.toastLabel)
            UIView.animate(withDuration: 0.2) { self.toastLabel.alpha = 1 }
            let work = DispatchWorkItem { [weak self] in
                UIView.animate(withDuration: 0.25) { self?.toastLabel.alpha = 0 }
            }
            self.toastWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: work)
        }
    }

    // MARK: - QR Scanner & Keyboard

    @objc private func dismissKeyboard() {
        view.endEditing(true)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        testConnectionTapped()
        return true
    }

    @objc private func startQrScanner() {
        dismissKeyboard()
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            presentQrScanner()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.presentQrScanner()
                    } else {
                        self?.showToast("Camera permission needed to scan the laptop QR code")
                    }
                }
            }
        default:
            let alert = UIAlertController(
                title: "Camera Permission Needed",
                message: "Allow camera access in iOS Settings so Roving DSLR Bridge can scan the Photographer Desk QR code on your laptop.",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
                if let u = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(u)
                }
            })
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            present(alert, animated: true)
        }
    }

    private func presentQrScanner() {
        let scanner = RovingQrScannerViewController()
        scanner.modalPresentationStyle = .fullScreen
        scanner.onScanned = { [weak self] raw in
            guard let self = self else { return }
            let cleaned = self.cleanUrl(raw)
            guard !cleaned.isEmpty else { return }
            self.setTargetUrl(cleaned)
            self.laptopInput.text = cleaned
            self.savePrefs()
            self.testConnection()
        }
        present(scanner, animated: true)
    }

    // MARK: - Camera Polling Background Worker

    private func startWorker() {
        workerLock.lock()
        if workerRunning {
            workerLock.unlock()
            return
        }
        let token = UUID()
        workerRunning = true
        workerToken = token
        let t = Thread { [weak self] in
            self?.workerLoop(token: token)
        }
        t.name = "roving-bridge-worker"
        workerThread = t
        workerLock.unlock()
        t.start()
    }

    private func stopWorker() {
        workerLock.lock()
        workerRunning = false
        workerToken = nil
        workerThread?.cancel()
        workerThread = nil
        workerLock.unlock()
    }

    private func isWorkerActive(token: UUID) -> Bool {
        workerLock.lock()
        let r = workerRunning && workerToken == token
        workerLock.unlock()
        return r
    }

    private func workerLoop(token: UUID) {
        let cam = IccCameraHelper.shared
        while isWorkerActive(token: token) && !Thread.current.isCancelled {
            autoreleasepool {
                let saveCard = currentSaveToCard()
                IccCameraHelper.shared.setRovingSaveToCard(saveCard)
                if !cam.isCameraOpen() {
                    _ = cam.ensureOpenRoving(saveToCard: saveCard)
                }
                let connected = cam.isCameraOpen()
                let name = connected ? cam.cameraName() : "No DSLR Connected"
                let battery = connected ? cam.cameraBattery() : -1
                let errText = connected ? "" : cam.lastErrorText()
                let seenNames = connected ? [] : cam.discoveredCameraNames()

                DispatchQueue.main.async { [weak self] in
                    self?.updateCameraStatus(connected: connected, name: name, battery: battery, errText: errText, seenNames: seenNames)
                }

                if connected {
                    let photos = cam.pollNewPhotos()
                    for jpeg in photos where !jpeg.isEmpty {
                        enqueueCapturedPhoto(jpeg)
                    }
                }
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
    }

    private func updateCameraStatus(connected: Bool, name: String, battery: Int, errText: String, seenNames: [String]) {
        if connected {
            statusPill.text = "● READY"
            statusPill.textColor = UIColor(hex: "#2EA66B")
            statusPill.backgroundColor = UIColor(hex: "#EAF7EF")
            cameraTitleLabel.text = name
            let base = battery >= 0 ? "Connected via USB • Battery \(battery)%" : "Connected via USB • Physical shutter is live"
            cameraSubLabel.text = currentSaveToCard() ? "\(base)\n💾 Backup + RAW saved to camera SD card" : base
            triggerButton.isEnabled = true
        } else {
            statusPill.text = seenNames.isEmpty ? "● WAITING" : "● CONNECTING"
            statusPill.textColor = UIColor(hex: "#C93D27")
            statusPill.backgroundColor = UIColor(hex: "#FBEBE8")
            cameraTitleLabel.text = seenNames.first ?? "No DSLR Connected"
            if !errText.isEmpty && !seenNames.isEmpty {
                cameraSubLabel.text = errText
            } else {
                cameraSubLabel.text = "Plug your Canon, Nikon, or Sony DSLR into this iPhone/iPad with a USB data cable.\nCanon R50/R-series: Menu → Wrench → Choose USB connection app → Photo Import/Remote Control (Wi-Fi OFF)."
            }
            triggerButton.isEnabled = false
        }
    }

    // MARK: - Network Monitors (Offline Booth Wi-Fi Reconnect)

    private func startNetworkMonitors() {
        let handleUpdate: (NWPath) -> Void = { [weak self] path in
            guard let self = self else { return }
            if path.status == .satisfied {
                if self.pendingCount() > 0 {
                    self.kickRetryQueue(delay: 0.35)
                }
            } else {
                self.cancelActiveUpload()
            }
        }

        let wm = NWPathMonitor(requiredInterfaceType: .wifi)
        wm.pathUpdateHandler = handleUpdate
        wm.start(queue: netQueue)
        wifiMonitor = wm

        let em = NWPathMonitor(requiredInterfaceType: .wiredEthernet)
        em.pathUpdateHandler = handleUpdate
        em.start(queue: netQueue)
        ethMonitor = em
    }

    private func stopNetworkMonitors() {
        wifiMonitor?.cancel()
        wifiMonitor = nil
        ethMonitor?.cancel()
        ethMonitor = nil
    }

    private func cancelActiveUpload() {
        activeTaskLock.lock()
        let task = activeUploadTask
        activeTaskLock.unlock()
        task?.cancel()
    }

    private func isPrivateLanHost(_ host: String) -> Bool {
        let h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if h.isEmpty { return false }
        if h == "localhost" || h == "127.0.0.1" || h.hasSuffix(".local") { return true }
        let parts = h.split(separator: ".")
        guard parts.count == 4,
              let a = Int(parts[0]), let b = Int(parts[1]),
              let c = Int(parts[2]), let d = Int(parts[3]),
              (0...255).contains(a), (0...255).contains(b),
              (0...255).contains(c), (0...255).contains(d) else { return false }
        return a == 10 || (a == 192 && b == 168) || (a == 172 && (16...31).contains(b)) || (a == 169 && b == 254)
    }

    private func sessionFor(url: URL) -> URLSession {
        if let host = url.host, isPrivateLanHost(host) {
            return lanSession
        }
        return publicSession
    }

    // MARK: - Storage & Offline Disk Queue

    private func appSupportDir(named: String) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var dir = base.appendingPathComponent(named, isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var rsrc = URLResourceValues()
            rsrc.isExcludedFromBackup = true
            try? dir.setResourceValues(rsrc)
        }
        return dir
    }

    private func pendingDir() -> URL { return appSupportDir(named: "rove_pending") }
    private func failedDir() -> URL { return appSupportDir(named: "rove_failed") }

    private func thumbsDir() -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("rove_thumbs", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    private func cleanOldThumbnails() {
        let dir = thumbsDir()
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        for f in files {
            if let vals = try? f.resourceValues(forKeys: [.contentModificationDateKey]),
               let m = vals.contentModificationDate, m < cutoff {
                try? FileManager.default.removeItem(at: f)
            }
        }
    }

    private func listPendingFiles() -> [URL] {
        let dir = pendingDir()
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]) else { return [] }
        return files
            .filter { $0.pathExtension.lowercased() == "jpg" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func pendingCount() -> Int {
        return listPendingFiles().count
    }

    private func fileSizeBytes(_ url: URL) -> Int64 {
        let vals = try? url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(vals?.fileSize ?? 0)
    }

    private func quarantineFile(_ url: URL) {
        let dest = failedDir().appendingPathComponent(url.lastPathComponent)
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.moveItem(at: url, to: dest)
        } catch {
            try? FileManager.default.copyItem(at: url, to: dest)
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func savePendingPhotoFile(_ data: Data) -> URL? {
        let dir = pendingDir()
        stateLock.lock()
        pendingSeq = (pendingSeq + 1) % 10000
        let seq = pendingSeq
        stateLock.unlock()

        let ms = Int64(Date().timeIntervalSince1970 * 1000.0)
        let baseName = String(format: "rove_%013lld_%04d.jpg", ms, Int32(seq))
        let tmp = dir.appendingPathComponent("\(baseName).tmp")
        let dest = dir.appendingPathComponent(baseName)
        do {
            try data.write(to: tmp, options: .atomic)
            try FileManager.default.moveItem(at: tmp, to: dest)
            return dest
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            return nil
        }
    }

    private func makeThumbnail(from data: Data) -> URL? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return writeThumbnail(from: src)
    }

    private func makeThumbnail(from fileUrl: URL) -> URL? {
        guard let src = CGImageSourceCreateWithURL(fileUrl as CFURL, nil) else { return nil }
        return writeThumbnail(from: src)
    }

    private func writeThumbnail(from src: CGImageSource) -> URL? {
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 480
        ]
        guard let cgImg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let uiImg = UIImage(cgImage: cgImg)
        guard let jpg = uiImg.jpegData(compressionQuality: 0.75) else { return nil }
        let ms = Int64(Date().timeIntervalSince1970 * 1000.0)
        let url = thumbsDir().appendingPathComponent("thumb_\(ms)_\(Int.random(in: 100...999)).jpg")
        do {
            try jpg.write(to: url)
            return url
        } catch {
            return nil
        }
    }

    private func formatTime(_ date: Date = Date()) -> String {
        let df = DateFormatter()
        df.dateFormat = "HH:mm:ss"
        return df.string(from: date)
    }

    private func restorePendingQueue() {
        restoreGroup.enter()
        ingestQueue.async { [weak self] in
            guard let self = self else { return }
            defer { self.restoreGroup.leave() }

            // Clean up abandoned .tmp files left behind if app was killed mid-write
            let dir = self.pendingDir()
            let staleCutoff = Date().addingTimeInterval(-60)
            if let all = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) {
                for f in all where f.pathExtension.lowercased() == "tmp" {
                    if let m = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate, m < staleCutoff {
                        try? FileManager.default.removeItem(at: f)
                    }
                }
            }

            let files = self.listPendingFiles()
            if files.isEmpty {
                DispatchQueue.main.async { self.refreshQueueUi() }
                return
            }

            var restored: [SessionPhoto] = []
            for f in files {
                let sz = self.fileSizeBytes(f)
                if sz <= 0 {
                    try? FileManager.default.removeItem(at: f)
                    continue
                }
                let mDate = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
                let thumb = self.makeThumbnail(from: f) ?? self.thumbsDir().appendingPathComponent("missing_\(f.lastPathComponent)")
                restored.insert(SessionPhoto(thumbUrl: thumb, timeStr: self.formatTime(mDate), success: false, sizeBytes: sz, pendingUrl: f), at: 0)
            }

            if !restored.isEmpty {
                self.stateLock.lock()
                self.sessionPhotos.append(contentsOf: restored)
                self.stateLock.unlock()
            }

            let latestThumb = restored.first?.thumbUrl
            let count = restored.count
            DispatchQueue.main.async {
                if let t = latestThumb, FileManager.default.fileExists(atPath: t.path) {
                    self.thumbnailView.image = UIImage(contentsOfFile: t.path)
                }
                if count > 0 {
                    self.lastSentLabel.text = "⏳ \(count) queued photo(s) restored — waiting for laptop Wi-Fi…"
                }
                self.refreshQueueUi()
                self.notifyGalleryChanged()
                if count > 0 && !self.currentTargetUrl().isEmpty {
                    self.kickRetryQueue(delay: 0.3)
                }
            }
        }
    }

    // MARK: - Capture Ingest & Upload Drain

    private func enqueueCapturedPhoto(_ bytes: Data) {
        ingestQueue.async { [weak self] in
            self?.handlePhotoCaptured(bytes)
        }
    }

    private func handlePhotoCaptured(_ bytes: Data) {
        let timeStr = formatTime()
        let currentTarget = currentTargetUrl()

        let thumbUrl = makeThumbnail(from: bytes)
        guard let pendingUrl = savePendingPhotoFile(bytes) else {
            // Disk write fallback: upload directly from memory
            let res: UploadOutcome = currentTarget.isEmpty ? .retry : uploadBytesToLaptop(baseUrl: currentTarget, bytes: bytes)
            let ok = (res == .ok)
            if let tu = thumbUrl {
                let item = SessionPhoto(thumbUrl: tu, timeStr: timeStr, success: ok, sizeBytes: Int64(bytes.count), pendingUrl: nil)
                stateLock.lock()
                sessionPhotos.insert(item, at: 0)
                if ok { sentPhotosCount += 1 }
                stateLock.unlock()
            }
            DispatchQueue.main.async {
                if ok {
                    self.lastSentLabel.text = "Last photo sent at \(timeStr)"
                    self.vibrateSuccess()
                } else {
                    self.lastSentLabel.text = "Could not save photo to phone storage!"
                    self.showToast("Storage full — could not queue photo!")
                }
                if let tu = thumbUrl, FileManager.default.fileExists(atPath: tu.path) {
                    self.thumbnailView.image = UIImage(contentsOfFile: tu.path)
                }
                self.refreshQueueUi()
                self.notifyGalleryChanged()
            }
            return
        }

        let displayThumb = thumbUrl ?? thumbsDir().appendingPathComponent("missing_\(pendingUrl.lastPathComponent)")
        let item = SessionPhoto(thumbUrl: displayThumb, timeStr: timeStr, success: false, sizeBytes: Int64(bytes.count), pendingUrl: pendingUrl)
        stateLock.lock()
        sessionPhotos.insert(item, at: 0)
        stateLock.unlock()

        DispatchQueue.main.async {
            if FileManager.default.fileExists(atPath: displayThumb.path) {
                self.thumbnailView.image = UIImage(contentsOfFile: displayThumb.path)
            }
            if currentTarget.isEmpty {
                self.lastSentLabel.text = "⏳ Queued on phone — scan Laptop QR to send"
                self.showToast("Photo queued! Scan Laptop QR to send.")
            } else {
                let q = self.pendingCount()
                self.lastSentLabel.text = q > 1 ? "📤 Uploading (\(q) in queue)…" : "📤 Sending photo…"
            }
            self.refreshQueueUi()
            self.notifyGalleryChanged()
            if !currentTarget.isEmpty {
                self.scheduleDrain()
            }
        }
    }

    private func kickRetryQueue(delay: TimeInterval = 0) {
        DispatchQueue.main.async {
            self.retryWorkItem?.cancel()
            self.retryWorkItem = nil
            if delay > 0 {
                if self.pendingCount() > 0 && !self.currentTargetUrl().isEmpty {
                    let work = DispatchWorkItem { [weak self] in
                        self?.scheduleDrain()
                    }
                    self.retryWorkItem = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
                }
            } else {
                self.scheduleDrain()
            }
        }
    }

    private func scheduleDrain() {
        stateLock.lock()
        if drainQueued {
            stateLock.unlock()
            return
        }
        drainQueued = true
        stateLock.unlock()

        uploadQueue.async { [weak self] in
            self?.drainPendingQueue()
        }
    }

    private func drainPendingQueue() {
        stateLock.lock()
        drainQueued = false
        if isDraining {
            stateLock.unlock()
            return
        }
        isDraining = true
        stateLock.unlock()

        defer {
            stateLock.lock()
            isDraining = false
            stateLock.unlock()
        }

        _ = restoreGroup.wait(timeout: .now() + 5.0)

        let initialFiles = listPendingFiles()
        if initialFiles.isEmpty {
            DispatchQueue.main.async { self.refreshQueueUi() }
            return
        }

        let clean = cleanUrl(currentTargetUrl())
        if clean.isEmpty {
            DispatchQueue.main.async {
                self.lastSentLabel.text = "⏳ \(initialFiles.count) photo(s) queued — scan Laptop QR to send"
                self.refreshQueueUi()
            }
            return
        }

        stateLock.lock()
        let fails = consecutiveUploadFails
        stateLock.unlock()
        if fails > 0 || initialFiles.count > 2 {
            if !isLaptopReachable(cleanBaseUrl: clean) {
                let n = pendingCount()
                DispatchQueue.main.async {
                    self.lastSentLabel.text = "⏳ \(n) queued — waiting for laptop Wi-Fi…"
                    self.refreshQueueUi()
                    if n > 0 {
                        self.kickRetryQueue(delay: Self.retryDelaySec)
                    }
                }
                return
            }
        }

        let files = listPendingFiles()
        var madeProgress = false
        var urlChanged = false

        for (idx, file) in files.enumerated() {
            if !FileManager.default.fileExists(atPath: file.path) { continue }
            let sz = fileSizeBytes(file)
            if sz <= 0 {
                try? FileManager.default.removeItem(at: file)
                madeProgress = true
                markPhotoResult(path: file.path, success: false)
                continue
            }
            let liveClean = cleanUrl(currentTargetUrl())
            if liveClean.isEmpty || liveClean != clean {
                urlChanged = !liveClean.isEmpty
                break
            }

            let total = files.count
            DispatchQueue.main.async {
                self.lastSentLabel.text = total > 1 ? "📤 Sending \(idx + 1)/\(total) queued photos…" : "📤 Sending photo…"
            }

            let t0 = Date()
            let outcome = uploadFileToLaptop(cleanBaseUrl: clean, fileUrl: file)
            switch outcome {
            case .ok:
                madeProgress = true
                let elapsedMs = Int(Date().timeIntervalSince(t0) * 1000.0)
                let timeStr = formatTime()
                try? FileManager.default.removeItem(at: file)
                let remAfter = pendingCount()

                stateLock.lock()
                consecutiveUploadFails = 0
                sentPhotosCount += 1
                for p in sessionPhotos where p.pendingUrl?.path == file.path {
                    p.success = true
                    p.pendingUrl = nil
                    break
                }
                stateLock.unlock()

                DispatchQueue.main.async {
                    self.lastSentLabel.text = remAfter == 0
                        ? "Last photo sent at \(timeStr) (\(elapsedMs)ms)"
                        : "Sent at \(timeStr) (\(elapsedMs)ms) • \(remAfter) left…"
                    self.vibrateSuccess()
                    self.refreshQueueUi()
                    self.notifyGalleryChanged()
                    if let pv = self.previewingPhoto, !self.photoPreviewOverlay.isHidden, pv.pendingUrl == nil {
                        self.showPhotoPreview(pv)
                    }
                }

            case .tooBig:
                quarantineFile(file)
                madeProgress = true
                stateLock.lock()
                consecutiveUploadFails = 0
                stateLock.unlock()
                markPhotoResult(path: file.path, success: false)
                DispatchQueue.main.async {
                    self.lastSentLabel.text = "Skipped oversized photo (>80 MB, kept in local backup)"
                    self.showToast("Photo >80 MB kept in local backup; continuing queue")
                }

            case .retry:
                stateLock.lock()
                consecutiveUploadFails += 1
                stateLock.unlock()
                let rem = pendingCount()
                DispatchQueue.main.async {
                    self.lastSentLabel.text = "⏳ \(rem) queued — Wi-Fi lost, auto-retrying…"
                    self.refreshQueueUi()
                    if rem > 0 {
                        self.kickRetryQueue(delay: Self.retryDelaySec)
                    }
                }
                return
            }
        }

        if urlChanged {
            kickRetryQueue(delay: 0.15)
        } else if pendingCount() > 0 && !cleanUrl(currentTargetUrl()).isEmpty {
            kickRetryQueue(delay: madeProgress ? 0.25 : Self.retryDelaySec)
        }
    }

    private func markPhotoResult(path: String, success: Bool) {
        stateLock.lock()
        for p in sessionPhotos where p.pendingUrl?.path == path {
            p.success = success
            p.pendingUrl = nil
            break
        }
        stateLock.unlock()
        DispatchQueue.main.async {
            self.refreshQueueUi()
            self.notifyGalleryChanged()
        }
    }

    private func isLaptopReachable(cleanBaseUrl: String) -> Bool {
        guard let url = URL(string: "\(cleanBaseUrl)/hello") else { return false }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2.5)
        req.httpMethod = "GET"
        req.setValue("close", forHTTPHeaderField: "Connection")

        let sema = DispatchSemaphore(value: 0)
        var ok = false
        let task = sessionFor(url: url).dataTask(with: req) { _, resp, err in
            if err == nil, let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                ok = true
            }
            sema.signal()
        }
        task.resume()
        if sema.wait(timeout: .now() + 3.0) == .timedOut {
            task.cancel()
            return false
        }
        return ok
    }

    private func uploadFileToLaptop(cleanBaseUrl: String, fileUrl: URL) -> UploadOutcome {
        let len = fileSizeBytes(fileUrl)
        if len <= 0 { return .retry }
        if len > Self.maxUploadBytes { return .tooBig }

        let encodedName = fileUrl.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? fileUrl.lastPathComponent
        guard let url = URL(string: "\(cleanBaseUrl)/photo?name=\(encodedName)&id=\(encodedName)") else { return .retry }

        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20.0)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(fileUrl.lastPathComponent, forHTTPHeaderField: "X-Rove-Id")
        req.setValue("close", forHTTPHeaderField: "Connection")

        let sema = DispatchSemaphore(value: 0)
        var outcome: UploadOutcome = .retry
        let task = sessionFor(url: url).uploadTask(with: req, fromFile: fileUrl) { _, resp, err in
            if err == nil, let http = resp as? HTTPURLResponse {
                if (200...299).contains(http.statusCode) {
                    outcome = .ok
                } else if http.statusCode == 413 {
                    outcome = .tooBig
                }
            }
            sema.signal()
        }

        activeTaskLock.lock()
        activeUploadTask = task
        activeTaskLock.unlock()

        task.resume()
        let timedOut = sema.wait(timeout: .now() + 30.0) == .timedOut
        if timedOut { task.cancel() }

        activeTaskLock.lock()
        if activeUploadTask === task { activeUploadTask = nil }
        activeTaskLock.unlock()

        return timedOut ? .retry : outcome
    }

    private func uploadBytesToLaptop(baseUrl: String, bytes: Data) -> UploadOutcome {
        if Int64(bytes.count) > Self.maxUploadBytes { return .tooBig }
        let clean = cleanUrl(baseUrl)
        let ms = Int64(Date().timeIntervalSince1970 * 1000.0)
        let name = "rove_\(ms).jpg"
        guard let url = URL(string: "\(clean)/photo?name=\(name)") else { return .retry }

        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20.0)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(name, forHTTPHeaderField: "X-Rove-Id")
        req.setValue("close", forHTTPHeaderField: "Connection")

        let sema = DispatchSemaphore(value: 0)
        var outcome: UploadOutcome = .retry
        let task = sessionFor(url: url).uploadTask(with: req, from: bytes) { _, resp, err in
            if err == nil, let http = resp as? HTTPURLResponse {
                if (200...299).contains(http.statusCode) {
                    outcome = .ok
                } else if http.statusCode == 413 {
                    outcome = .tooBig
                }
            }
            sema.signal()
        }
        task.resume()
        if sema.wait(timeout: .now() + 30.0) == .timedOut {
            task.cancel()
            return .retry
        }
        return outcome
    }

    // MARK: - UI Refresh & Haptics

    private func refreshQueueUi() {
        let pending = pendingCount()
        stateLock.lock()
        let sent = sentPhotosCount
        let hasUrl = !targetUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        stateLock.unlock()

        if pending > 0 {
            statsCountLabel.text = "\(sent) Sent • \(pending) Queued"
            statsCountLabel.textColor = UIColor(hex: "#D97706")
            pendingBannerLabel.text = hasUrl
                ? "⏳ \(pending) photo(s) queued — auto-uploads on Wi-Fi"
                : "⏳ \(pending) photo(s) queued — scan Laptop QR to send"
            pendingBanner.isHidden = false
            galleryRetryBtn.setTitle("🔄 Retry (\(pending))", for: .normal)
            galleryRetryBtn.isHidden = false
            pocketStatsLabel.text = "Sent: \(sent) • Queued: \(pending) (auto-retrying)"
        } else {
            statsCountLabel.text = "\(sent) Photos Sent"
            statsCountLabel.textColor = UIColor(hex: "#2EA66B")
            pendingBanner.isHidden = true
            galleryRetryBtn.isHidden = true
            pocketStatsLabel.text = "Sent: \(sent)"
        }
    }

    private func notifyGalleryChanged() {
        stateLock.lock()
        let count = sessionPhotos.count
        stateLock.unlock()
        galleryTitleLabel.text = "📸 Sent Photos (\(count))"
        galleryEmptyLabel.isHidden = count > 0
        galleryCollectionView.isHidden = count == 0
        galleryCollectionView.reloadData()
    }

    private func vibrateSuccess() {
        guard currentPrefs().vibrate else { return }
        hapticGenerator.notificationOccurred(.success)
        hapticGenerator.prepare()
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    }

    // MARK: - Actions

    @objc private func testConnectionTapped() {
        dismissKeyboard()
        testConnection()
    }

    private func testConnection() {
        let raw = (laptopInput.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            showToast("Please enter or scan the laptop URL")
            return
        }
        let cleaned = cleanUrl(raw)
        setTargetUrl(cleaned)
        laptopInput.text = cleaned
        savePrefs()

        connectionStatusLabel.text = "Testing connection to \(cleaned)…"
        connectionStatusLabel.textColor = UIColor(hex: "#6B666C")

        guard let pingUrl = URL(string: "\(cleaned)/hello") else {
            connectionStatusLabel.text = "❌ Invalid laptop URL"
            connectionStatusLabel.textColor = UIColor(hex: "#C93D27")
            return
        }

        var req = URLRequest(url: pingUrl, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4.5)
        req.httpMethod = "GET"
        req.setValue("close", forHTTPHeaderField: "Connection")

        sessionFor(url: pingUrl).dataTask(with: req) { [weak self] _, resp, err in
            guard let self = self else { return }
            var ok = false
            var msg = ""
            if let err = err {
                let nsErr = err as NSError
                if nsErr.domain == NSURLErrorDomain && (nsErr.code == NSURLErrorNotConnectedToInternet || nsErr.code == NSURLErrorCannotConnectToHost || nsErr.code == NSURLErrorNetworkConnectionLost) {
                    msg = "Could not reach laptop (\(err.localizedDescription)). Confirm same Wi-Fi and allow Local Network in iPhone Settings."
                } else {
                    msg = "Could not reach laptop: \(err.localizedDescription)"
                }
            } else if let http = resp as? HTTPURLResponse {
                ok = (200...299).contains(http.statusCode)
                msg = ok ? "Connected! Laptop ready." : "Laptop answered HTTP \(http.statusCode)"
            } else {
                msg = "Could not reach laptop"
            }

            DispatchQueue.main.async {
                self.connectionStatusLabel.text = ok ? "✅ \(msg)" : "❌ \(msg)"
                self.connectionStatusLabel.textColor = ok ? UIColor(hex: "#2EA66B") : UIColor(hex: "#C93D27")
                self.showToast(msg)
                self.refreshQueueUi()
                if self.pendingCount() > 0 {
                    self.kickRetryQueue(delay: ok ? 0.1 : Self.retryDelaySec)
                }
            }
        }.resume()
    }

    @objc private func pasteFromClipboard() {
        if let str = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty {
            laptopInput.text = str
            testConnection()
        } else {
            showToast("Clipboard is empty")
        }
    }

    @objc private func retryPendingNow() {
        let inputText = (laptopInput.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let clean = cleanUrl(inputText.isEmpty ? currentTargetUrl() : inputText)
        guard !clean.isEmpty else {
            showToast("Scan the Photographer Desk QR code on your laptop first!")
            return
        }
        if clean != currentTargetUrl() {
            setTargetUrl(clean)
            laptopInput.text = clean
            savePrefs()
        }
        let pending = pendingCount()
        guard pending > 0 else {
            refreshQueueUi()
            showToast("No pending photos to send")
            return
        }
        lastSentLabel.text = "🔄 Retrying \(pending) queued photo(s)…"
        kickRetryQueue(delay: 0)
    }

    @objc private func openLaptopQueue() {
        let raw = (laptopInput.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let chosen = raw.isEmpty ? currentTargetUrl() : raw
        guard !chosen.isEmpty else {
            showToast("Connect to laptop first by scanning the Photographer Desk QR code")
            return
        }
        let clean = cleanUrl(chosen)
        let targetWeb = (clean.contains("/send/") && !clean.hasSuffix("/photos")) ? "\(clean)/photos" : clean
        guard let url = URL(string: targetWeb) else {
            showToast("Invalid laptop queue URL")
            return
        }
        let safari = SFSafariViewController(url: url)
        present(safari, animated: true)
    }

    @objc private func testShutterTrigger() {
        guard IccCameraHelper.shared.isCameraOpen() else {
            showToast("DSLR is not connected")
            return
        }
        triggerButton.isEnabled = false
        triggerButton.setTitle("Capturing…", for: .normal)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let bytes = try IccCameraHelper.shared.triggerRovingCapture()
                DispatchQueue.main.async {
                    self.triggerButton.isEnabled = IccCameraHelper.shared.isCameraOpen()
                    self.triggerButton.setTitle("📸 Test Shutter", for: .normal)
                    if !bytes.isEmpty {
                        self.enqueueCapturedPhoto(bytes)
                        self.showToast("Photo snapped & queued for laptop!")
                    } else {
                        self.showToast("Shutter refused or no photo returned")
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.triggerButton.isEnabled = IccCameraHelper.shared.isCameraOpen()
                    self.triggerButton.setTitle("📸 Test Shutter", for: .normal)
                    self.showToast("Shutter failed: \(error.localizedDescription)")
                }
            }
        }
    }

    @objc private func clearSessionGallery() {
        let pending = pendingCount()
        if pending > 0 {
            let alert = UIAlertController(
                title: "Unsent Photos Queued",
                message: "\(pending) photo(s) are still waiting to upload to the laptop.",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Clear Sent Only", style: .default) { [weak self] _ in
                guard let self = self else { return }
                self.stateLock.lock()
                self.sessionPhotos.removeAll { p in
                    let hasPending = (p.pendingUrl != nil && FileManager.default.fileExists(atPath: p.pendingUrl!.path))
                    if p.success || !hasPending {
                        try? FileManager.default.removeItem(at: p.thumbUrl)
                        return true
                    }
                    return false
                }
                self.stateLock.unlock()
                self.notifyGalleryChanged()
                self.refreshQueueUi()
                self.showToast("Cleared sent photos; kept \(pending) queued")
            })
            alert.addAction(UIAlertAction(title: "Delete All", style: .destructive) { [weak self] _ in
                guard let self = self else { return }
                for f in self.listPendingFiles() { try? FileManager.default.removeItem(at: f) }
                self.stateLock.lock()
                for p in self.sessionPhotos {
                    try? FileManager.default.removeItem(at: p.thumbUrl)
                    if let pu = p.pendingUrl { try? FileManager.default.removeItem(at: pu) }
                }
                self.sessionPhotos.removeAll()
                self.stateLock.unlock()
                self.notifyGalleryChanged()
                self.refreshQueueUi()
                self.showToast("All photos and pending queue cleared")
            })
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            present(alert, animated: true)
            return
        }

        stateLock.lock()
        for p in sessionPhotos { try? FileManager.default.removeItem(at: p.thumbUrl) }
        sessionPhotos.removeAll()
        stateLock.unlock()
        notifyGalleryChanged()
        refreshQueueUi()
        showToast("Session photos cleared")
    }

    // MARK: - UICollectionViewDataSource & Delegate

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        stateLock.lock()
        let n = sessionPhotos.count
        stateLock.unlock()
        return n
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: PhotoGridCell.reuseId, for: indexPath) as! PhotoGridCell
        stateLock.lock()
        let photo = indexPath.item < sessionPhotos.count ? sessionPhotos[indexPath.item] : nil
        stateLock.unlock()
        if let p = photo {
            cell.configure(with: p)
        }
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        stateLock.lock()
        let photo = indexPath.item < sessionPhotos.count ? sessionPhotos[indexPath.item] : nil
        stateLock.unlock()
        if let p = photo {
            showPhotoPreview(p)
        }
    }

    func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
        let cols: CGFloat = collectionView.bounds.width > 560 ? 5 : 3
        let spacing: CGFloat = 8
        let totalSpacing = spacing * (cols - 1)
        let w = floor((collectionView.bounds.width - totalSpacing) / cols)
        return CGSize(width: max(60, w), height: max(90, w))
    }
}

// MARK: - Gallery Grid Cell

private final class PhotoGridCell: UICollectionViewCell {
    static let reuseId = "PhotoGridCell"

    private let imageView = UIImageView()
    private let badge = PaddingLabel(inset: UIEdgeInsets(top: 2, left: 6, bottom: 2, right: 6))

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = .white
        contentView.layer.cornerRadius = 12
        contentView.layer.masksToBounds = true

        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(imageView)

        badge.font = .boldSystemFont(ofSize: 10)
        badge.textColor = .white
        badge.layer.cornerRadius = 6
        badge.layer.masksToBounds = true
        badge.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(badge)

        NSLayoutConstraint.activate([
            imageView.topAnchor.constraint(equalTo: contentView.topAnchor),
            imageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            imageView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),

            badge.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 4),
            badge.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -4)
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    func configure(with photo: RovingBridgeViewController.SessionPhoto) {
        imageView.image = UIImage(contentsOfFile: photo.thumbUrl.path)
        if photo.success {
            badge.text = "\(photo.timeStr) ✓"
            badge.backgroundColor = UIColor(hex: "#1B7358").withAlphaComponent(0.85)
        } else if let pu = photo.pendingUrl, FileManager.default.fileExists(atPath: pu.path) {
            badge.text = "\(photo.timeStr) ⏳"
            badge.backgroundColor = UIColor(hex: "#D97706").withAlphaComponent(0.85)
        } else {
            badge.text = "\(photo.timeStr) ✗"
            badge.backgroundColor = UIColor(hex: "#C83924").withAlphaComponent(0.85)
        }
    }
}

// MARK: - Native QR Code Scanner

private final class RovingQrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {

    var onScanned: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.photobooth4u.roving.qr", qos: .userInitiated)
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didFinish = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        let reticle = UIView()
        reticle.layer.borderColor = UIColor(hex: "#2EA66B").cgColor
        reticle.layer.borderWidth = 3
        reticle.layer.cornerRadius = 18
        reticle.backgroundColor = .clear
        reticle.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(reticle)

        let prompt = PaddingLabel(inset: UIEdgeInsets(top: 10, left: 16, bottom: 10, right: 16))
        prompt.text = "Point camera at Photographer Desk QR on your laptop"
        prompt.font = .boldSystemFont(ofSize: 14)
        prompt.textColor = .white
        prompt.backgroundColor = UIColor.black.withAlphaComponent(0.7)
        prompt.layer.cornerRadius = 12
        prompt.layer.masksToBounds = true
        prompt.textAlignment = .center
        prompt.numberOfLines = 0
        prompt.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(prompt)

        let cancelBtn = UIButton(type: .system)
        cancelBtn.setTitle("Cancel", for: .normal)
        cancelBtn.setTitleColor(.white, for: .normal)
        cancelBtn.titleLabel?.font = .boldSystemFont(ofSize: 15)
        cancelBtn.backgroundColor = UIColor.black.withAlphaComponent(0.75)
        cancelBtn.layer.cornerRadius = 22
        cancelBtn.translatesAutoresizingMaskIntoConstraints = false
        cancelBtn.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        view.addSubview(cancelBtn)

        NSLayoutConstraint.activate([
            reticle.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            reticle.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -20),
            reticle.widthAnchor.constraint(equalToConstant: 240),
            reticle.heightAnchor.constraint(equalToConstant: 240),

            prompt.bottomAnchor.constraint(equalTo: reticle.topAnchor, constant: -20),
            prompt.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            prompt.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
            prompt.centerXAnchor.constraint(equalTo: view.centerXAnchor),

            cancelBtn.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            cancelBtn.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancelBtn.widthAnchor.constraint(equalToConstant: 140),
            cancelBtn.heightAnchor.constraint(equalToConstant: 44)
        ])

        configureCaptureSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
        if let conn = previewLayer?.connection, conn.isVideoOrientationSupported,
           let io = view.window?.windowScene?.interfaceOrientation {
            switch io {
            case .landscapeLeft: conn.videoOrientation = .landscapeLeft
            case .landscapeRight: conn.videoOrientation = .landscapeRight
            case .portraitUpsideDown: conn.videoOrientation = .portraitUpsideDown
            default: conn.videoOrientation = .portrait
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [weak self] in
            if self?.session.isRunning == true {
                self?.session.stopRunning()
            }
        }
    }

    private func configureCaptureSession() {
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  self.session.canAddInput(input) else {
                DispatchQueue.main.async {
                    self.dismiss(animated: true)
                }
                return
            }
            self.session.beginConfiguration()
            self.session.addInput(input)

            let meta = AVCaptureMetadataOutput()
            if self.session.canAddOutput(meta) {
                self.session.addOutput(meta)
                meta.setMetadataObjectsDelegate(self, queue: .main)
                meta.metadataObjectTypes = [.qr]
            }
            self.session.commitConfiguration()
            self.session.startRunning()
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didFinish else { return }
        guard let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let val = obj.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !val.isEmpty else { return }
        didFinish = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        sessionQueue.async { [weak self] in
            self?.session.stopRunning()
        }
        dismiss(animated: true) { [weak self] in
            self?.onScanned?(val)
        }
    }

    @objc private func cancelTapped() {
        didFinish = true
        sessionQueue.async { [weak self] in
            self?.session.stopRunning()
        }
        dismiss(animated: true)
    }
}

// MARK: - Helpers

private final class PaddingLabel: UILabel {
    private let inset: UIEdgeInsets

    init(inset: UIEdgeInsets) {
        self.inset = inset
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: inset))
    }

    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + inset.left + inset.right, height: s.height + inset.top + inset.bottom)
    }
}

private extension UIColor {
    convenience init(hex: String) {
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("#") { cleaned.removeFirst() }
        var rgb: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&rgb)
        let r = CGFloat((rgb >> 16) & 0xFF) / 255.0
        let g = CGFloat((rgb >> 8) & 0xFF) / 255.0
        let b = CGFloat(rgb & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b, alpha: 1.0)
    }
}
