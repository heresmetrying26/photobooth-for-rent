import UIKit
import AVFoundation
import CoreMotion
import AudioToolbox
import Photos

/// Native 360 Arm Camera Companion & Built-In Mode.
/// Mounts on the spinning 360 arm, reads CoreMotion rotation rate at 50 Hz,
/// supports guided "Configure Sensitivity" calibration, records 1080p 60/120 fps,
/// and streams clips offline over local booth Wi-Fi to the desktop 360 Desk.
final class SpinArmViewController: UIViewController,
    AVCaptureFileOutputRecordingDelegate,
    AVCaptureMetadataOutputObjectsDelegate,
    URLSessionDataDelegate {

    // MARK: - Persistence Keys

    private enum Keys {
        static let sendUrl = "pb4u_spin_arm_url"
        static let startThresh = "pb4u_spin_arm_thresh"
        static let stopThresh = "pb4u_spin_arm_stop_thresh"
        static let lens = "pb4u_spin_arm_lens"
        static let fps = "pb4u_spin_arm_fps"
        static let savePhotos = "pb4u_spin_arm_save_photos"
    }

    // MARK: - Desk Synced Settings & State Machine

    private struct ArmConfig: Equatable {
        var trigger: String = "arm"       // "arm" | "manual" | "desk"
        var stopMode: String = "follow"   // "follow" | "fixed"
        var fixedSec: Double = 10.0
        var tailSec: Double = 1.5
        var maxSec: Double = 30.0
        var cooldownSec: Double = 4.0
        var fps: Int = 60
    }

    private enum ArmPhase: String {
        case idle
        case calibrating
        case recording
        case cooldown
    }

    private enum CalStep {
        case still
        case spin
    }

    private enum LensChoice: String {
        case ultrawide
        case wide
        case front

        var label: String {
            switch self {
            case .ultrawide: return "0.5×"
            case .wide: return "1×"
            case .front: return "Front"
            }
        }
    }

    var onDismiss: (() -> Void)?

    // MARK: - Runtime State (Main Thread)

    private var sendUrl: String = ""
    private var deskConnected: Bool = false
    private var deskLaptopName: String = ""
    private var armConfig = ArmConfig()
    private var lastConfigSig: String = ""

    private var phase: ArmPhase = .idle
    private var isPairingScan: Bool = false
    private var isSettingsOpen: Bool = false
    private var isScreenLocked: Bool = false
    private var aeAfLocked: Bool = false

    private var lensChoice: LensChoice = .ultrawide
    private var targetFps: Int = 60
    private var activeFps: Int = 60
    private var saveToPhotos: Bool = false

    private var startThresholdDps: Double = 25.0
    private var stopThresholdDps: Double = 11.0
    private var smoothedDps: Double = 0.0

    // Motion trigger & auto-stop tracking
    private var aboveThresholdSince: CFTimeInterval?
    private var recordingStartedAt: CFTimeInterval = 0
    private var belowStopSince: CFTimeInterval?
    private var tailStartAt: CFTimeInterval?
    private var cooldownStartedAt: CFTimeInterval = 0
    private var stillSince: CFTimeInterval?

    // Calibration wizard tracking
    private var calStep: CalStep = .still
    private var calStepStartedAt: CFTimeInterval = 0
    private var calStillSamples: [Double] = []
    private var calSpinSamples: [Double] = []

    // Capture & Upload tracking
    private var sentCount: Int = 0
    private var activeUploadPct: Int = 0
    private var isUploadingNow: Bool = false
    private var uploadQueue: [URL] = []
    private var currentUploadFile: URL?
    private var currentUploadRetries: Int = 0
    private var currentUploadResponseData = Data()
    private var didCreateUploadSession: Bool = false
    private lazy var uploadSession: URLSession = {
        didCreateUploadSession = true
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 300
        return URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
    }()

    // MARK: - AVFoundation & CoreMotion

    private let camQueue = DispatchQueue(label: "com.photobooth4u.spinarm.cam", qos: .userInitiated)
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer!
    private var currentDevice: AVCaptureDevice?
    private var currentVideoInput: AVCaptureDeviceInput?
    private var audioInput: AVCaptureDeviceInput?
    private let movieOutput = AVCaptureMovieFileOutput()
    private var metadataOutput: AVCaptureMetadataOutput?
    private var rotationCoordinatorObj: AnyObject?
    private var rotationObserverPreview: NSKeyValueObservation?
    private var rotationObserverCapture: NSKeyValueObservation?
    private var orientationObserver: NSObjectProtocol?
    private var isSessionConfigured = false

    private let motionManager = CMMotionManager()
    private let motionOpQueue: OperationQueue = {
        let q = OperationQueue()
        q.name = "com.photobooth4u.spinarm.motion"
        q.maxConcurrentOperationCount = 1
        return q
    }()
    private var heartbeatTimer: Timer?
    private var heartbeatInFlightCount = 0
    private var recClockTimer: Timer?
    private var toastWorkItem: DispatchWorkItem?
    private var hasTornDown = false
    private var prevIdleTimerDisabled: Bool = false
    private var prevBatteryMonitoring: Bool = false

    // MARK: - UI Elements

    private let previewContainer = UIView()
    private let topBar = UIView()
    private let connPill = UILabel()
    private let lensSeg = UISegmentedControl(items: ["0.5×", "1×", "Front"])
    private let fpsBadge = UILabel()
    private let aeLockBtn = UIButton(type: .system)
    private let settingsBtn = UIButton(type: .system)
    private let closeBtn = UIButton(type: .system)

    private let centerOverlay = UIView()
    private let centerIconLabel = UILabel()
    private let centerTitleLabel = UILabel()
    private let centerSubLabel = UILabel()
    private let centerProg = UIProgressView(progressViewStyle: .default)
    private let centerCancelBtn = UIButton(type: .system)

    private let toastLabel = UILabel()
    private let focusReticle = UIView()

    // QR Scan overlay
    private let qrOverlay = UIView()
    private let qrBoxView = UIView()
    private let qrTitleLabel = UILabel()
    private let qrManualBtn = UIButton(type: .system)
    private let qrCancelBtn = UIButton(type: .system)

    // Bottom HUD
    private let bottomBar = UIView()
    private let stateBanner = UILabel()
    private let meterTrack = UIView()
    private let meterFill = UIView()
    private var meterFillWidth: NSLayoutConstraint!
    private let meterThreshMark = UIView()
    private var meterThreshLeading: NSLayoutConstraint!
    private let meterValueLabel = UILabel()
    private let calBtn = UIButton(type: .system)
    private let recBtn = UIButton(type: .system)
    private let lockBtn = UIButton(type: .system)
    private let pairBtn = UIButton(type: .system)
    private let pendingBtn = UIButton(type: .system)

    // Settings Sheet
    private let settingsOverlay = UIView()
    private let settingsCard = UIView()
    private let threshSlider = UISlider()
    private let threshReadoutLabel = UILabel()
    private let liveGyroSettingsLabel = UILabel()
    private let savePhotosSwitch = UISwitch()
    private let deskCfgSummaryLabel = UILabel()
    private let settingsPendingBtn = UIButton(type: .system)

    // Screen Lock Shield
    private let lockOverlay = UIView()
    private let lockStatusLabel = UILabel()
    private let lockHintLabel = UILabel()

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        loadPreferences()
        buildUI()
        refreshLensSegments()
        refreshPendingQueueFromDisk()

        NotificationCenter.default.addObserver(self, selector: #selector(handleOrientationDidChange), name: UIDevice.orientationDidChangeNotification, object: nil)
        orientationObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.syncOrientationIfIdle()
        }

        requestPermissionsAndStart()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        prevIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
        prevBatteryMonitoring = UIDevice.current.isBatteryMonitoringEnabled
        UIApplication.shared.isIdleTimerDisabled = true
        UIDevice.current.isBatteryMonitoringEnabled = true
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = previewContainer.bounds
        updateMeterLayout()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed || isMovingFromParent {
            teardownRuntime()
            UIApplication.shared.isIdleTimerDisabled = prevIdleTimerDisabled
            UIDevice.current.isBatteryMonitoringEnabled = prevBatteryMonitoring
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if let obs = orientationObserver { NotificationCenter.default.removeObserver(obs) }
        teardownRuntime()
    }

    private func teardownRuntime() {
        guard !hasTornDown else { return }
        hasTornDown = true
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        recClockTimer?.invalidate()
        recClockTimer = nil
        toastWorkItem?.cancel()
        toastWorkItem = nil
        motionManager.stopDeviceMotionUpdates()
        motionManager.stopGyroUpdates()
        rotationObserverPreview?.invalidate()
        rotationObserverPreview = nil
        rotationObserverCapture?.invalidate()
        rotationObserverCapture = nil
        rotationCoordinatorObj = nil
        if didCreateUploadSession {
            uploadSession.invalidateAndCancel()
        }

        let sess = session
        let mov = movieOutput
        camQueue.async {
            if mov.isRecording {
                mov.stopRecording()
            }
            if sess.isRunning {
                sess.stopRunning()
            }
        }
    }

    // MARK: - Preferences & Storage

    private func loadPreferences() {
        let ud = UserDefaults.standard
        sendUrl = Self.normalizeSendUrl(ud.string(forKey: Keys.sendUrl) ?? "") ?? ""
        let st = ud.double(forKey: Keys.startThresh)
        if st >= 10 && st <= 120 { startThresholdDps = st }
        let sp = ud.double(forKey: Keys.stopThresh)
        if sp >= 4 && sp < startThresholdDps { stopThresholdDps = sp }
        else { stopThresholdDps = max(5.0, startThresholdDps * 0.45) }

        if let rawLens = ud.string(forKey: Keys.lens), let lc = LensChoice(rawValue: rawLens) {
            lensChoice = lc
        }
        let savedFps = ud.integer(forKey: Keys.fps)
        if [30, 60, 120].contains(savedFps) { targetFps = savedFps }
        saveToPhotos = ud.bool(forKey: Keys.savePhotos)
    }

    private func saveThresholds() {
        let ud = UserDefaults.standard
        ud.set(startThresholdDps, forKey: Keys.startThresh)
        ud.set(stopThresholdDps, forKey: Keys.stopThresh)
    }

    private static func normalizeSendUrl(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        let pattern = #"^(https?://[^/\s]+/send/[A-Za-z0-9]+)"#
        guard let range = s.range(of: pattern, options: .regularExpression) else { return nil }
        return String(s[range])
    }

    private func pendingDirectory() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("pb360_pending", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func refreshPendingQueueFromDisk() {
        let dir = pendingDirectory()
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey], options: [.skipsHiddenFiles])) ?? []
        let videos = files.filter { ["mov", "mp4", "m4v"].contains($0.pathExtension.lowercased()) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for f in videos where !uploadQueue.contains(f) && currentUploadFile != f {
            uploadQueue.append(f)
        }
        updatePendingUI()
    }

    // MARK: - Permissions & Boot

    private func requestPermissionsAndStart() {
        let checkAudioAndStart: () -> Void = { [weak self] in
            guard let self = self else { return }
            let audioStatus = AVCaptureDevice.authorizationStatus(for: .audio)
            if audioStatus == .notDetermined {
                AVCaptureDevice.requestAccess(for: .audio) { _ in
                    DispatchQueue.main.async { self.bootCameraAndSensors() }
                }
            } else {
                DispatchQueue.main.async { self.bootCameraAndSensors() }
            }
        }

        let camStatus = AVCaptureDevice.authorizationStatus(for: .video)
        if camStatus == .authorized {
            checkAudioAndStart()
        } else if camStatus == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                if granted {
                    checkAudioAndStart()
                } else {
                    DispatchQueue.main.async { self?.showCameraDeniedAlert() }
                }
            }
        } else {
            showCameraDeniedAlert()
        }
    }

    private func showCameraDeniedAlert() {
        let ac = UIAlertController(
            title: "Camera Permission Needed",
            message: "Allow Camera access in iOS Settings so photobooth4u can record 360 videos and scan the laptop's pairing QR.",
            preferredStyle: .alert
        )
        ac.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
            if let u = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(u)
            }
        })
        ac.addAction(UIAlertAction(title: "Close", style: .cancel) { [weak self] _ in
            self?.dismissSelf()
        })
        present(ac, animated: true)
    }

    private func bootCameraAndSensors() {
        isPairingScan = sendUrl.isEmpty
        updateQRScanVisibility()
        configureCameraSession()
        startMotionEngine()
        startHeartbeatTimer()
        if !sendUrl.isEmpty {
            verifyPairAndFetchConfig(url: sendUrl, silent: true)
            processNextUploadIfNeeded()
        }
        updateUIState()
    }

    // MARK: - Camera Session (60/120 fps + QR Scanner)

    private func refreshLensSegments() {
        let hasUltra = AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back) != nil
        lensSeg.setEnabled(hasUltra, forSegmentAt: 0)
        if !hasUltra && lensChoice == .ultrawide {
            lensChoice = .wide
        }
        switch lensChoice {
        case .ultrawide: lensSeg.selectedSegmentIndex = 0
        case .wide: lensSeg.selectedSegmentIndex = 1
        case .front: lensSeg.selectedSegmentIndex = 2
        }
    }

    private func pickCaptureDevice(for choice: LensChoice, scanningQr: Bool) -> AVCaptureDevice? {
        if scanningQr {
            return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(for: .video)
        }
        switch choice {
        case .ultrawide:
            return AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        case .wide:
            return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back)
        case .front:
            return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
                ?? AVCaptureDevice.default(for: .video)
        }
    }

    private func bestFormat(for device: AVCaptureDevice, desiredFps: Int) -> (AVCaptureDevice.Format, Int)? {
        let candidates = desiredFps >= 120 ? [120, 60, 30] : (desiredFps >= 60 ? [60, 30] : [30])
        for fps in candidates {
            var best1080: AVCaptureDevice.Format?
            var best720: AVCaptureDevice.Format?
            var bestAny: AVCaptureDevice.Format?

            for fmt in device.formats {
                let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
                let w = Int(dims.width), h = Int(dims.height)
                guard w >= 1280 && h >= 720 else { continue }
                let supportsFps = fmt.videoSupportedFrameRateRanges.contains { r in
                    r.minFrameRate <= Double(fps) + 0.01 && r.maxFrameRate >= Double(fps) - 0.01
                }
                guard supportsFps else { continue }

                let sub = CMFormatDescriptionGetMediaSubType(fmt.formatDescription)
                let is420 = (sub == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || sub == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
                if !is420 && bestAny != nil { continue }

                if w == 1920 && h == 1080 {
                    if best1080 == nil || (!fmt.isVideoBinned && (best1080?.isVideoBinned ?? true)) {
                        best1080 = fmt
                    }
                } else if w == 1280 && h == 720 {
                    if best720 == nil { best720 = fmt }
                } else if w <= 1920 && bestAny == nil {
                    bestAny = fmt
                }
            }
            if let chosen = best1080 ?? best720 ?? bestAny {
                return (chosen, fps)
            }
        }
        return nil
    }

    private func configureCameraSession() {
        let scanning = isPairingScan
        let choice = lensChoice
        let wantedFps = targetFps
        let lockAeAf = aeAfLocked
        let fallbackVo = currentLegacyVideoOrientation()

        camQueue.async { [weak self] in
            guard let self = self else { return }
            guard let device = self.pickCaptureDevice(for: choice, scanningQr: scanning) else {
                DispatchQueue.main.async { self.showToast("No camera available on this device.") }
                return
            }

            if self.session.isRunning {
                self.session.stopRunning()
            }

            self.session.beginConfiguration()
            if scanning {
                self.session.sessionPreset = .high
            } else {
                self.session.sessionPreset = .inputPriority
            }

            if let oldIn = self.currentVideoInput {
                self.session.removeInput(oldIn)
                self.currentVideoInput = nil
            }
            if let oldAudio = self.audioInput {
                self.session.removeInput(oldAudio)
                self.audioInput = nil
            }
            if let oldMeta = self.metadataOutput {
                self.session.removeOutput(oldMeta)
                self.metadataOutput = nil
            }

            do {
                let vIn = try AVCaptureDeviceInput(device: device)
                if self.session.canAddInput(vIn) {
                    self.session.addInput(vIn)
                    self.currentVideoInput = vIn
                    self.currentDevice = device
                }
            } catch {
                self.session.commitConfiguration()
                DispatchQueue.main.async { self.showToast("Could not open camera.") }
                return
            }

            if !scanning && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized {
                if let mic = AVCaptureDevice.default(for: .audio),
                   let aIn = try? AVCaptureDeviceInput(device: mic),
                   self.session.canAddInput(aIn) {
                    let avs = AVAudioSession.sharedInstance()
                    try? avs.setCategory(.playAndRecord, mode: .videoRecording, options: [.defaultToSpeaker, .allowBluetooth])
                    try? avs.setActive(true)
                    self.session.addInput(aIn)
                    self.audioInput = aIn
                }
            }

            if !self.session.outputs.contains(self.movieOutput), self.session.canAddOutput(self.movieOutput) {
                self.session.addOutput(self.movieOutput)
            }
            self.movieOutput.movieFragmentInterval = .invalid

            var chosenFormat: (AVCaptureDevice.Format, Int)? = nil
            if !scanning {
                chosenFormat = self.bestFormat(for: device, desiredFps: wantedFps)
                if let (fmt, fps) = chosenFormat {
                    do {
                        try device.lockForConfiguration()
                        device.activeFormat = fmt
                        let dur = CMTime(value: 1, timescale: CMTimeScale(fps))
                        device.activeVideoMinFrameDuration = dur
                        device.activeVideoMaxFrameDuration = dur
                        device.unlockForConfiguration()
                    } catch { /* fallback to default format */ }
                }
            } else {
                let meta = AVCaptureMetadataOutput()
                if self.session.canAddOutput(meta) {
                    self.session.addOutput(meta)
                    if meta.availableMetadataObjectTypes.contains(.qr) {
                        meta.metadataObjectTypes = [.qr]
                    }
                    meta.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
                    self.metadataOutput = meta
                }
            }

            self.session.commitConfiguration()

            // Re-apply frame duration after commitConfiguration() so AVFoundation does not revert to 30 fps.
            var finalFps = 30
            if let (_, fps) = chosenFormat {
                finalFps = fps
                do {
                    try device.lockForConfiguration()
                    let dur = CMTime(value: 1, timescale: CMTimeScale(fps))
                    device.activeVideoMinFrameDuration = dur
                    device.activeVideoMaxFrameDuration = dur
                    if !lockAeAf {
                        if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
                        if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
                    } else {
                        if device.isFocusModeSupported(.locked) { device.focusMode = .locked }
                        if device.isExposureModeSupported(.locked) { device.exposureMode = .locked }
                    }
                    device.unlockForConfiguration()
                } catch { /* ignore */ }
            }

            if let conn = self.movieOutput.connection(with: .video) {
                if self.movieOutput.availableVideoCodecTypes.contains(.h264) {
                    self.movieOutput.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: conn)
                }
                if conn.isVideoStabilizationSupported {
                    conn.preferredVideoStabilizationMode = .standard
                }
                if #available(iOS 17.0, *) {
                    // Handled by AVCaptureDevice.RotationCoordinator in setupRotation(for:)
                } else if conn.isVideoOrientationSupported {
                    conn.videoOrientation = fallbackVo
                }
            }

            self.isSessionConfigured = true
            if !self.session.isRunning {
                self.session.startRunning()
            }

            self.setupRotation(for: device)

            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.activeFps = finalFps
                self.fpsBadge.text = "\(finalFps) FPS"
                self.updateAeAfButtonUI()
            }
        }
    }

    private func setupRotation(for dev: AVCaptureDevice) {
        if #available(iOS 17.0, *) {
            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.currentDevice?.uniqueID == dev.uniqueID else { return }
                self.rotationObserverPreview?.invalidate()
                self.rotationObserverCapture?.invalidate()
                let coord = AVCaptureDevice.RotationCoordinator(device: dev, previewLayer: self.previewLayer)
                self.rotationCoordinatorObj = coord

                self.applyPreviewRotationAngle(coord.videoRotationAngleForHorizonLevelPreview)
                self.applyCaptureRotationAngle(coord.videoRotationAngleForHorizonLevelCapture)

                self.rotationObserverPreview = coord.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] _, ch in
                    if let ang = ch.newValue {
                        DispatchQueue.main.async { self?.applyPreviewRotationAngle(ang) }
                    }
                }
                self.rotationObserverCapture = coord.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.new]) { [weak self] _, ch in
                    if let ang = ch.newValue {
                        self?.applyCaptureRotationAngle(ang)
                    }
                }
            }
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.syncLegacyOrientation()
            }
        }
    }

    @available(iOS 17.0, *)
    private func applyPreviewRotationAngle(_ angle: CGFloat) {
        if let conn = previewLayer?.connection, conn.isVideoRotationAngleSupported(angle) {
            conn.videoRotationAngle = angle
        }
    }

    @available(iOS 17.0, *)
    private func applyCaptureRotationAngle(_ angle: CGFloat) {
        camQueue.async { [weak self] in
            guard let self = self, !self.movieOutput.isRecording else { return }
            if let conn = self.movieOutput.connection(with: .video), conn.isVideoRotationAngleSupported(angle) {
                conn.videoRotationAngle = angle
            }
        }
    }

    @objc private func handleOrientationDidChange() {
        syncOrientationIfIdle()
    }

    private func syncOrientationIfIdle() {
        if #available(iOS 17.0, *) {
            guard let coord = rotationCoordinatorObj as? AVCaptureDevice.RotationCoordinator else { return }
            applyPreviewRotationAngle(coord.videoRotationAngleForHorizonLevelPreview)
            applyCaptureRotationAngle(coord.videoRotationAngleForHorizonLevelCapture)
        } else {
            syncLegacyOrientation()
        }
    }

    private func syncLegacyOrientation() {
        let vo = currentLegacyVideoOrientation()
        if let pConn = previewLayer?.connection, pConn.isVideoOrientationSupported {
            pConn.videoOrientation = vo
        }
        camQueue.async { [weak self] in
            guard let self = self, !self.movieOutput.isRecording else { return }
            if let mConn = self.movieOutput.connection(with: .video), mConn.isVideoOrientationSupported {
                mConn.videoOrientation = vo
            }
        }
    }

    private func currentLegacyVideoOrientation() -> AVCaptureVideoOrientation {
        switch UIDevice.current.orientation {
        case .portrait: return .portrait
        case .portraitUpsideDown: return .portraitUpsideDown
        case .landscapeLeft: return .landscapeRight
        case .landscapeRight: return .landscapeLeft
        default:
            let iface = view.window?.windowScene?.interfaceOrientation ?? .portrait
            switch iface {
            case .portraitUpsideDown: return .portraitUpsideDown
            case .landscapeLeft: return .landscapeLeft
            case .landscapeRight: return .landscapeRight
            default: return .portrait
            }
        }
    }

    // MARK: - CoreMotion Engine (50 Hz)

    private func startMotionEngine() {
        motionManager.stopDeviceMotionUpdates()
        motionManager.stopGyroUpdates()

        if motionManager.isDeviceMotionAvailable {
            motionManager.deviceMotionUpdateInterval = 0.02
            motionManager.startDeviceMotionUpdates(to: motionOpQueue) { [weak self] dm, _ in
                guard let dm = dm else { return }
                let r = dm.rotationRate
                let rawDps = sqrt(r.x * r.x + r.y * r.y + r.z * r.z) * (180.0 / .pi)
                DispatchQueue.main.async { self?.onMotionSample(rawDps) }
            }
        } else if motionManager.isGyroAvailable {
            motionManager.gyroUpdateInterval = 0.02
            motionManager.startGyroUpdates(to: motionOpQueue) { [weak self] g, _ in
                guard let g = g else { return }
                let r = g.rotationRate
                let rawDps = sqrt(r.x * r.x + r.y * r.y + r.z * r.z) * (180.0 / .pi)
                DispatchQueue.main.async { self?.onMotionSample(rawDps) }
            }
        } else {
            showToast("Motion sensor unavailable — use Manual / Desk trigger.")
        }
    }

    private func onMotionSample(_ rawDps: Double) {
        smoothedDps = smoothedDps * 0.72 + rawDps * 0.28
        let now = CACurrentMediaTime()

        updateMeterUI()
        if isSettingsOpen {
            liveGyroSettingsLabel.text = String(format: "Live rotation: %.0f°/s (trigger %.0f°/s)", smoothedDps, startThresholdDps)
        }

        switch phase {
        case .calibrating:
            handleCalibrationTick(now: now)
        case .idle:
            handleIdleMotionTick(now: now)
        case .recording:
            handleRecordingMotionTick(now: now)
        case .cooldown:
            handleCooldownMotionTick(now: now)
        }
    }

    private func handleIdleMotionTick(now: CFTimeInterval) {
        guard !isPairingScan, !isSettingsOpen, armConfig.trigger == "arm", !movieOutput.isRecording else {
            aboveThresholdSince = nil
            return
        }
        if smoothedDps >= startThresholdDps {
            if aboveThresholdSince == nil {
                aboveThresholdSince = now
            } else if now - (aboveThresholdSince ?? now) >= 0.32 {
                aboveThresholdSince = nil
                beginRecording(reason: "motion")
            }
        } else if smoothedDps < startThresholdDps * 0.85 {
            aboveThresholdSince = nil
        }
    }

    private func handleRecordingMotionTick(now: CFTimeInterval) {
        let elapsed = now - recordingStartedAt
        if elapsed >= armConfig.maxSec {
            stopRecording(reason: "max")
            return
        }
        if armConfig.stopMode == "fixed" {
            if elapsed >= armConfig.fixedSec {
                stopRecording(reason: "fixed")
            }
            return
        }

        // "follow" mode: wait at least 2.5 s into the spin, then stop after 0.8 s still + tailSec
        guard elapsed >= 2.5 else { return }
        if smoothedDps < stopThresholdDps {
            if belowStopSince == nil {
                belowStopSince = now
            } else if now - (belowStopSince ?? now) >= 0.8 {
                if tailStartAt == nil {
                    tailStartAt = now
                } else if now - (tailStartAt ?? now) >= armConfig.tailSec {
                    stopRecording(reason: "armStopped")
                }
            }
        } else if smoothedDps >= startThresholdDps || (tailStartAt != nil && smoothedDps >= stopThresholdDps + 3.0) {
            belowStopSince = nil
            tailStartAt = nil
        } else if tailStartAt == nil {
            belowStopSince = nil
        }
    }

    private func handleCooldownMotionTick(now: CFTimeInterval) {
        if smoothedDps < stopThresholdDps {
            if stillSince == nil { stillSince = now }
        } else {
            stillSince = nil
        }
        let elapsed = now - cooldownStartedAt
        let stillElapsed = stillSince.map { now - $0 } ?? 0.0
        if (elapsed >= armConfig.cooldownSec && stillElapsed >= 1.2) || elapsed >= armConfig.cooldownSec + 10.0 {
            phase = .idle
            stillSince = nil
            updateUIState()
        }
    }

    // MARK: - Guided "Configure Sensitivity" Calibration Wizard

    private func startCalibration() {
        guard phase != .recording, !movieOutput.isRecording else {
            showToast("Finish the current recording first.")
            return
        }
        if isPairingScan {
            isPairingScan = false
            updateQRScanVisibility()
            configureCameraSession()
        }
        isSettingsOpen = false
        settingsOverlay.isHidden = true

        aboveThresholdSince = nil
        belowStopSince = nil
        tailStartAt = nil
        calStep = .still
        calStepStartedAt = CACurrentMediaTime()
        calStillSamples.removeAll()
        calSpinSamples.removeAll()
        phase = .calibrating
        updateUIState()
        sendHeartbeat()
    }

    private func cancelCalibration() {
        guard phase == .calibrating else { return }
        phase = .idle
        updateUIState()
    }

    private func handleCalibrationTick(now: CFTimeInterval) {
        let elapsed = now - calStepStartedAt
        switch calStep {
        case .still:
            calStillSamples.append(smoothedDps)
            centerProg.progress = Float(min(1.0, elapsed / 1.5))
            if elapsed >= 1.5 {
                calStep = .spin
                calStepStartedAt = now
                AudioServicesPlaySystemSound(1057)
                updateUIState()
            }
        case .spin:
            let sortedStill = calStillSamples.sorted()
            let noiseFloor: Double
            if sortedStill.count >= 10 {
                noiseFloor = sortedStill[Int(Double(sortedStill.count - 1) * 0.95)]
            } else {
                noiseFloor = sortedStill.max() ?? 2.0
            }
            let minSpin = max(10.0, noiseFloor * 2.2)
            if smoothedDps >= minSpin {
                calSpinSamples.append(smoothedDps)
            }
            centerProg.progress = Float(min(1.0, Double(calSpinSamples.count) / 75.0))
            let enoughSpin = calSpinSamples.count >= 75 && elapsed >= 2.0
            let timedOut = elapsed >= 6.0
            guard enoughSpin || timedOut else { return }

            if calSpinSamples.count >= 15 {
                let sortedSpin = calSpinSamples.sorted()
                let spinMedian = sortedSpin[sortedSpin.count / 2]
                let newStart = min(120.0, max(10.0, max(noiseFloor * 3.0 + 6.0, spinMedian * 0.35)))
                let newStop = min(newStart - 4.0, max(5.0, newStart * 0.45))
                startThresholdDps = round(newStart)
                stopThresholdDps = round(newStop)
                saveThresholds()
                AudioServicesPlaySystemSound(1113)
                showToast(String(format: "✓ Calibrated! Spin: %.0f°/s · Trigger: %.0f°/s", spinMedian, startThresholdDps))
                phase = .cooldown
                cooldownStartedAt = now
                stillSince = nil
            } else {
                showToast("No spin detected — tap Calibrate and spin the arm.")
                phase = .idle
            }
            updateUIState()
            sendHeartbeat()
        }
    }

    // MARK: - Recording Start / Stop

    private func beginRecording(reason: String) {
        guard phase == .idle || phase == .cooldown else { return }
        guard !movieOutput.isRecording, !isPairingScan else { return }

        let dir = pendingDirectory()
        let df = DateFormatter()
        df.dateFormat = "yyyyMMdd_HHmmss_SSS"
        let outURL = dir.appendingPathComponent("360_\(df.string(from: Date())).mov")

        phase = .recording
        recordingStartedAt = CACurrentMediaTime()
        belowStopSince = nil
        tailStartAt = nil
        aboveThresholdSince = nil

        AudioServicesPlaySystemSound(1113)
        updateUIState()
        startRecClock()
        sendHeartbeat(force: true)

        camQueue.async { [weak self] in
            guard let self = self else { return }
            guard self.session.isRunning, !self.movieOutput.isRecording else {
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, self.phase == .recording else { return }
                    self.recClockTimer?.invalidate()
                    self.recClockTimer = nil
                    self.phase = .idle
                    self.updateUIState()
                    self.sendHeartbeat(force: true)
                    self.showToast("Camera not ready yet — try again.")
                }
                return
            }
            self.movieOutput.startRecording(to: outURL, recordingDelegate: self)
        }
    }

    private func stopRecording(reason: String) {
        guard phase == .recording else { return }
        recClockTimer?.invalidate()
        recClockTimer = nil
        AudioServicesPlaySystemSound(1114)

        phase = .cooldown
        cooldownStartedAt = CACurrentMediaTime()
        stillSince = nil
        updateUIState()
        sendHeartbeat(force: true)

        camQueue.async { [weak self] in
            guard let self = self, self.movieOutput.isRecording else { return }
            self.movieOutput.stopRecording()
        }
    }

    private func startRecClock() {
        recClockTimer?.invalidate()
        recClockTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self = self, self.phase == .recording else { return }
            let el = CACurrentMediaTime() - self.recordingStartedAt
            let secs = Int(el)
            let tenths = Int((el - Double(secs)) * 10) % 10
            let clock = String(format: "● REC %02d:%02d.%d", secs / 60, secs % 60, tenths)
            self.centerTitleLabel.text = clock
            if self.armConfig.stopMode == "fixed" {
                self.centerProg.progress = Float(min(1.0, el / max(1.0, self.armConfig.fixedSec)))
            } else {
                self.centerProg.progress = Float(min(1.0, el / max(1.0, self.armConfig.maxSec)))
            }
            if self.isScreenLocked {
                self.lockStatusLabel.text = clock
            }
        }
    }

    // MARK: - AVCaptureFileOutputRecordingDelegate

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        let finishedOk: Bool
        if let err = error as NSError? {
            finishedOk = (err.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) ?? false
        } else {
            finishedOk = true
        }
        let size = (try? outputFileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard finishedOk, size > 2048 else {
            try? FileManager.default.removeItem(at: outputFileURL)
            DispatchQueue.main.async { [weak self] in
                self?.showToast("Recording was too short or failed.")
                if self?.phase == .recording {
                    self?.phase = .idle
                    self?.updateUIState()
                }
            }
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.saveToPhotos {
                let tmpURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent("pb360_photos_\(UUID().uuidString).mov")
                let staged: Bool
                if (try? FileManager.default.linkItem(at: outputFileURL, to: tmpURL)) != nil {
                    staged = true
                } else if (try? FileManager.default.copyItem(at: outputFileURL, to: tmpURL)) != nil {
                    staged = true
                } else {
                    staged = false
                }
                if staged {
                    PHPhotoLibrary.shared().performChanges({
                        PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: tmpURL)
                    }) { _, _ in
                        try? FileManager.default.removeItem(at: tmpURL)
                    }
                }
            }
            if !self.uploadQueue.contains(outputFileURL) && self.currentUploadFile != outputFileURL {
                self.uploadQueue.append(outputFileURL)
            }
            self.updatePendingUI()
            self.processNextUploadIfNeeded()
        }
    }

    // MARK: - QR Scanner Delegate

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard isPairingScan else { return }
        for obj in metadataObjects {
            guard let qr = obj as? AVMetadataMachineReadableCodeObject,
                  let raw = qr.stringValue,
                  let normalized = Self.normalizeSendUrl(raw) else { continue }
            isPairingScan = false
            AudioServicesPlaySystemSound(1113)
            updateQRScanVisibility()
            verifyPairAndFetchConfig(url: normalized, silent: false)
            configureCameraSession()
            break
        }
    }

    // MARK: - Offline Wi-Fi Uploader + Retry Queue

    private func processNextUploadIfNeeded() {
        guard !isUploadingNow, !sendUrl.isEmpty else { return }
        guard let next = uploadQueue.first else {
            updatePendingUI()
            return
        }
        guard FileManager.default.fileExists(atPath: next.path) else {
            uploadQueue.removeFirst()
            processNextUploadIfNeeded()
            return
        }
        uploadQueue.removeFirst()
        currentUploadFile = next
        currentUploadRetries = 0
        startCurrentUpload()
    }

    private func startCurrentUpload() {
        guard let fileURL = currentUploadFile, !sendUrl.isEmpty else {
            isUploadingNow = false
            updatePendingUI()
            return
        }
        var comps = URLComponents(string: sendUrl + "/upload")
        comps?.queryItems = [URLQueryItem(name: "name", value: fileURL.lastPathComponent)]
        guard let targetURL = comps?.url else {
            isUploadingNow = false
            return
        }

        isUploadingNow = true
        activeUploadPct = 0
        currentUploadResponseData = Data()
        var req = URLRequest(url: targetURL)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        updatePendingUI()

        let task = uploadSession.uploadTask(with: req, fromFile: fileURL)
        task.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        activeUploadPct = min(99, max(0, Int((Double(totalBytesSent) / Double(totalBytesExpectedToSend)) * 100.0)))
        updatePendingUI()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        currentUploadResponseData.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let httpCode = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let jsonOk = ((try? JSONSerialization.jsonObject(with: currentUploadResponseData, options: [])) as? [String: Any])?["ok"] as? Bool
        let succeeded = (error == nil && httpCode == 200 && jsonOk != false)

        if succeeded {
            if let f = currentUploadFile {
                try? FileManager.default.removeItem(at: f)
            }
            sentCount += 1
            currentUploadFile = nil
            isUploadingNow = false
            activeUploadPct = 0
            showToast("✓ Clip sent to 360 Desk (\(sentCount) sent)")
            updatePendingUI()
            processNextUploadIfNeeded()
            return
        }

        // Auto-retry up to 3 times on network error or 5xx
        let retryable = (error != nil || httpCode >= 500 || httpCode == 0)
        if retryable && currentUploadRetries < 3 {
            currentUploadRetries += 1
            let delays = [1.5, 3.0, 5.0]
            let delay = delays[min(delays.count - 1, currentUploadRetries - 1)]
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.startCurrentUpload()
            }
            return
        }

        // Keep file on disk so user can tap "Retry pending"
        if let f = currentUploadFile, FileManager.default.fileExists(atPath: f.path), !uploadQueue.contains(f) {
            uploadQueue.append(f)
        }
        currentUploadFile = nil
        isUploadingNow = false
        activeUploadPct = 0
        showToast("Upload paused — clip saved on phone. Tap Retry pending when on booth Wi-Fi.")
        updatePendingUI()
    }

    // MARK: - Pairing, Heartbeat & Desk Sync

    private func verifyPairAndFetchConfig(url base: String, silent: Bool) {
        guard let helloURL = URL(string: base + "/hello?r=1") else { return }
        var req = URLRequest(url: helloURL)
        req.timeoutInterval = 4.0
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if err == nil, code == 200,
                   let data = data,
                   let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   (obj["ok"] as? Bool) == true {
                    self.sendUrl = base
                    UserDefaults.standard.set(base, forKey: Keys.sendUrl)
                    self.deskConnected = true
                    if !silent {
                        self.showToast("✓ Paired with laptop 360 Desk!")
                    }
                    self.updateUIState()
                    self.sendHeartbeat()
                    self.processNextUploadIfNeeded()
                } else {
                    self.deskConnected = false
                    if !silent {
                        self.showToast("Could not reach laptop — check booth Wi-Fi.")
                    }
                    self.updateUIState()
                }
            }
        }.resume()
    }

    private func startHeartbeatTimer() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] _ in
            self?.sendHeartbeat()
        }
    }

    private func sendHeartbeat(force: Bool = false) {
        guard !sendUrl.isEmpty, let url = URL(string: sendUrl + "/arm-state") else { return }
        if !force && heartbeatInFlightCount > 0 { return }
        let reportedState: String
        switch phase {
        case .recording: reportedState = "recording"
        case .calibrating: reportedState = "calibrating"
        case .cooldown: reportedState = "cooldown"
        case .idle: reportedState = isUploadingNow ? "uploading" : "idle"
        }

        let batRaw = UIDevice.current.batteryLevel
        let batPct = batRaw >= 0 ? Int(round(batRaw * 100)) : -1
        let recSec = (phase == .recording) ? max(0.0, CACurrentMediaTime() - recordingStartedAt) : 0.0
        let payload: [String: Any] = [
            "device": UIDevice.current.name,
            "state": reportedState,
            "gyroDps": round(smoothedDps * 10) / 10,
            "thresholdDps": round(startThresholdDps),
            "battery": batPct,
            "fps": activeFps,
            "recSec": round(recSec * 10) / 10,
            "uploadPct": activeUploadPct,
            "lens": lensChoice.label
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
        heartbeatInFlightCount += 1
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 3.0
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body

        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.heartbeatInFlightCount = max(0, self.heartbeatInFlightCount - 1)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard err == nil, code == 200,
                      let data = data,
                      let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      (obj["ok"] as? Bool) == true else {
                    self.deskConnected = false
                    self.updateConnPill()
                    return
                }
                self.deskConnected = true
                if let cfg = obj["config"] as? [String: Any] {
                    self.applyDeskConfig(cfg)
                }
                if let cmds = obj["cmds"] as? [[String: Any]] {
                    for item in cmds {
                        if let cmd = item["cmd"] as? String {
                            self.executeDeskCommand(cmd)
                        }
                    }
                }
                self.updateConnPill()
            }
        }.resume()
    }

    private func applyDeskConfig(_ cfg: [String: Any]) {
        if let laptop = cfg["laptop"] as? String, !laptop.isEmpty {
            deskLaptopName = laptop
        }
        guard let a = cfg["arm"] as? [String: Any] else { return }
        var next = ArmConfig()
        if let t = a["trigger"] as? String, ["arm", "manual", "desk"].contains(t) { next.trigger = t }
        if let sm = a["stopMode"] as? String, ["follow", "fixed"].contains(sm) { next.stopMode = sm }
        if let fx = (a["fixedSec"] as? NSNumber)?.doubleValue { next.fixedSec = min(60, max(3, fx)) }
        if let tl = (a["tailSec"] as? NSNumber)?.doubleValue { next.tailSec = min(10, max(0, tl)) }
        if let mx = (a["maxSec"] as? NSNumber)?.doubleValue { next.maxSec = min(60, max(5, mx)) }
        if let cd = (a["cooldownSec"] as? NSNumber)?.doubleValue { next.cooldownSec = min(20, max(1, cd)) }
        if let fp = (a["fps"] as? NSNumber)?.intValue, [30, 60, 120].contains(fp) { next.fps = fp }

        let sig = "\(next.trigger)|\(next.stopMode)|\(next.fixedSec)|\(next.tailSec)|\(next.maxSec)|\(next.cooldownSec)|\(next.fps)"
        let hadSig = !lastConfigSig.isEmpty
        if sig != lastConfigSig {
            let fpsChanged = (next.fps != targetFps)
            lastConfigSig = sig
            armConfig = next
            targetFps = next.fps
            UserDefaults.standard.set(targetFps, forKey: Keys.fps)
            if fpsChanged && phase != .recording && !isPairingScan {
                configureCameraSession()
            }
            if hadSig {
                showToast("Settings updated from 360 Desk")
            }
            updateUIState()
        }
    }

    private func executeDeskCommand(_ cmd: String) {
        switch cmd {
        case "start":
            if phase == .idle || phase == .cooldown {
                phase = .idle
                beginRecording(reason: "desk")
            }
        case "stop":
            if phase == .recording {
                stopRecording(reason: "desk")
            }
        case "calibrate":
            if phase != .recording {
                startCalibration()
            }
        default:
            break
        }
    }

    // MARK: - Actions

    @objc private func didTapClose() {
        if phase == .recording {
            let ac = UIAlertController(title: "Stop recording & exit?", message: "A 360 recording is in progress.", preferredStyle: .alert)
            ac.addAction(UIAlertAction(title: "Keep Recording", style: .cancel))
            ac.addAction(UIAlertAction(title: "Stop & Exit", style: .destructive) { [weak self] _ in
                self?.stopRecording(reason: "exit")
                self?.dismissSelf()
            })
            present(ac, animated: true)
            return
        }
        dismissSelf()
    }

    private func dismissSelf() {
        dismiss(animated: true) { [weak self] in
            self?.onDismiss?()
        }
    }

    @objc private func didChangeLens() {
        guard phase != .recording else {
            refreshLensSegments()
            return
        }
        switch lensSeg.selectedSegmentIndex {
        case 0: lensChoice = .ultrawide
        case 2: lensChoice = .front
        default: lensChoice = .wide
        }
        UserDefaults.standard.set(lensChoice.rawValue, forKey: Keys.lens)
        configureCameraSession()
    }

    @objc private func didTapAeAfLock() {
        aeAfLocked.toggle()
        let locked = aeAfLocked
        camQueue.async { [weak self] in
            guard let dev = self?.currentDevice else { return }
            do {
                try dev.lockForConfiguration()
                if locked {
                    if dev.isFocusModeSupported(.locked) { dev.focusMode = .locked }
                    if dev.isExposureModeSupported(.locked) { dev.exposureMode = .locked }
                } else {
                    if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
                    if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
                }
                dev.unlockForConfiguration()
            } catch { /* ignore */ }
        }
        updateAeAfButtonUI()
        showToast(locked ? "AE/AF Locked" : "Auto Focus & Exposure On")
    }

    @objc private func didTapPreviewTap(_ gr: UITapGestureRecognizer) {
        guard !isPairingScan, !isScreenLocked, !isSettingsOpen else { return }
        let pt = gr.location(in: previewContainer)
        let devPt = previewLayer.captureDevicePointConverted(fromLayerPoint: pt)

        focusReticle.center = pt
        focusReticle.alpha = 1
        focusReticle.transform = CGAffineTransform(scaleX: 1.25, y: 1.25)
        UIView.animate(withDuration: 0.25) {
            self.focusReticle.transform = .identity
        } completion: { _ in
            UIView.animate(withDuration: 0.4, delay: 0.8) {
                self.focusReticle.alpha = 0
            }
        }

        let keepLock = aeAfLocked
        camQueue.async { [weak self] in
            guard let dev = self?.currentDevice else { return }
            do {
                try dev.lockForConfiguration()
                if dev.isFocusPointOfInterestSupported {
                    dev.focusPointOfInterest = devPt
                    if dev.isFocusModeSupported(keepLock ? .autoFocus : .continuousAutoFocus) {
                        dev.focusMode = keepLock ? .autoFocus : .continuousAutoFocus
                    }
                }
                if dev.isExposurePointOfInterestSupported {
                    dev.exposurePointOfInterest = devPt
                    if dev.isExposureModeSupported(keepLock ? .autoExpose : .continuousAutoExposure) {
                        dev.exposureMode = keepLock ? .autoExpose : .continuousAutoExposure
                    }
                }
                dev.unlockForConfiguration()
            } catch { /* ignore */ }
        }
    }

    @objc private func didTapCalibrate() { startCalibration() }
    @objc private func didTapCancelCal() { cancelCalibration() }

    @objc private func didTapRecord() {
        if phase == .recording {
            stopRecording(reason: "manual")
        } else {
            if phase == .cooldown { phase = .idle }
            beginRecording(reason: "manual")
        }
    }

    @objc private func didTapLock() {
        isScreenLocked = true
        lockOverlay.isHidden = false
        lockStatusLabel.text = phase == .recording ? (centerTitleLabel.text ?? "● REC") : "ARMED · \(armConfig.trigger == "arm" ? "Motion Auto-Start" : "Manual")"
    }

    @objc private func handleUnlockLongPress(_ gr: UILongPressGestureRecognizer) {
        if gr.state == .began {
            AudioServicesPlaySystemSound(1057)
            isScreenLocked = false
            lockOverlay.isHidden = true
            showToast("Screen unlocked")
        }
    }

    @objc private func didTapPairQR() {
        guard phase != .recording else {
            showToast("Stop recording before pairing.")
            return
        }
        isPairingScan = true
        updateQRScanVisibility()
        configureCameraSession()
    }

    @objc private func didTapCancelQR() {
        isPairingScan = false
        updateQRScanVisibility()
        configureCameraSession()
    }

    @objc private func didTapManualUrl() {
        let ac = UIAlertController(
            title: "Pair with Laptop 360 Desk",
            message: "Paste the Send URL shown on the laptop's 360 Desk (e.g. http://192.168.1.20:47777/send/xxxx).",
            preferredStyle: .alert
        )
        ac.addTextField { [weak self] tf in
            tf.placeholder = "http://192.168.1.20:47777/send/..."
            tf.text = self?.sendUrl
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.autocorrectionType = .no
        }
        ac.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        ac.addAction(UIAlertAction(title: "Connect", style: .default) { [weak self] _ in
            guard let self = self else { return }
            let raw = ac.textFields?.first?.text ?? ""
            guard let norm = Self.normalizeSendUrl(raw) else {
                self.showToast("Invalid 360 Desk URL (must include /send/...).")
                return
            }
            self.isPairingScan = false
            self.updateQRScanVisibility()
            self.verifyPairAndFetchConfig(url: norm, silent: false)
            self.configureCameraSession()
        })
        present(ac, animated: true)
    }

    @objc private func didTapSettings() {
        isSettingsOpen = true
        threshSlider.value = Float(startThresholdDps)
        savePhotosSwitch.isOn = saveToPhotos
        threshReadoutLabel.text = String(format: "%.0f°/s (Stop: %.0f°/s)", startThresholdDps, stopThresholdDps)
        deskCfgSummaryLabel.text = "Desk sync: Start = \(armConfig.trigger), Stop = \(armConfig.stopMode == "fixed" ? "Fixed \(Int(armConfig.fixedSec))s" : "Follow arm + \(armConfig.tailSec)s tail"), \(targetFps) fps, Cooldown \(Int(armConfig.cooldownSec))s"
        settingsOverlay.isHidden = false
        updatePendingUI()
    }

    @objc private func didTapCloseSettings() {
        isSettingsOpen = false
        settingsOverlay.isHidden = true
    }

    @objc private func didSlideThreshold() {
        startThresholdDps = round(Double(threshSlider.value))
        stopThresholdDps = round(min(startThresholdDps - 4.0, max(5.0, startThresholdDps * 0.45)))
        threshReadoutLabel.text = String(format: "%.0f°/s (Stop: %.0f°/s)", startThresholdDps, stopThresholdDps)
        saveThresholds()
        updateMeterLayout()
    }

    @objc private func didToggleSavePhotos() {
        saveToPhotos = savePhotosSwitch.isOn
        UserDefaults.standard.set(saveToPhotos, forKey: Keys.savePhotos)
    }

    @objc private func didTapRetryPending() {
        refreshPendingQueueFromDisk()
        if sendUrl.isEmpty {
            showToast("Pair with a laptop 360 Desk first.")
            return
        }
        processNextUploadIfNeeded()
    }

    // MARK: - UI Construction & State Updates

    private func buildUI() {
        previewContainer.frame = view.bounds
        previewContainer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        previewContainer.backgroundColor = .black
        previewContainer.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(didTapPreviewTap(_:))))
        view.addSubview(previewContainer)

        previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        previewLayer.frame = previewContainer.bounds
        previewContainer.layer.addSublayer(previewLayer)

        focusReticle.frame = CGRect(x: 0, y: 0, width: 72, height: 72)
        focusReticle.layer.borderColor = UIColor(red: 1.0, green: 0.84, blue: 0.04, alpha: 1.0).cgColor
        focusReticle.layer.borderWidth = 2
        focusReticle.layer.cornerRadius = 10
        focusReticle.alpha = 0
        focusReticle.isUserInteractionEnabled = false
        previewContainer.addSubview(focusReticle)

        buildTopBar()
        buildCenterOverlay()
        buildBottomBar()
        buildQROverlay()
        buildSettingsOverlay()
        buildLockOverlay()

        toastLabel.backgroundColor = UIColor(white: 0.1, alpha: 0.88)
        toastLabel.textColor = .white
        toastLabel.font = .systemFont(ofSize: 13, weight: .bold)
        toastLabel.textAlignment = .center
        toastLabel.numberOfLines = 2
        toastLabel.layer.cornerRadius = 14
        toastLabel.clipsToBounds = true
        toastLabel.alpha = 0
        toastLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(toastLabel)

        NSLayoutConstraint.activate([
            toastLabel.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 12),
            toastLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            toastLabel.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -32)
        ])
    }

    private func buildTopBar() {
        topBar.backgroundColor = UIColor(white: 0.06, alpha: 0.72)
        topBar.layer.cornerRadius = 16
        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)

        connPill.font = .systemFont(ofSize: 11, weight: .bold)
        connPill.textColor = .white
        connPill.backgroundColor = UIColor(white: 1, alpha: 0.16)
        connPill.layer.cornerRadius = 10
        connPill.clipsToBounds = true
        connPill.textAlignment = .center
        connPill.adjustsFontSizeToFitWidth = true
        connPill.minimumScaleFactor = 0.75
        connPill.translatesAutoresizingMaskIntoConstraints = false

        lensSeg.apportionsSegmentWidthsByContent = true
        lensSeg.selectedSegmentTintColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        lensSeg.setTitleTextAttributes([.foregroundColor: UIColor.white, .font: UIFont.systemFont(ofSize: 11.5, weight: .bold)], for: .selected)
        lensSeg.setTitleTextAttributes([.foregroundColor: UIColor(white: 0.85, alpha: 1), .font: UIFont.systemFont(ofSize: 11.5, weight: .semibold)], for: .normal)
        lensSeg.backgroundColor = UIColor(white: 1, alpha: 0.12)
        lensSeg.addTarget(self, action: #selector(didChangeLens), for: .valueChanged)
        lensSeg.translatesAutoresizingMaskIntoConstraints = false

        fpsBadge.text = "\(targetFps) FPS"
        fpsBadge.font = .monospacedDigitSystemFont(ofSize: 11, weight: .bold)
        fpsBadge.textColor = UIColor(red: 0.35, green: 0.78, blue: 0.98, alpha: 1)
        fpsBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        fpsBadge.translatesAutoresizingMaskIntoConstraints = false

        aeLockBtn.setTitle("🔓 AE", for: .normal)
        aeLockBtn.titleLabel?.font = .systemFont(ofSize: 11.5, weight: .bold)
        aeLockBtn.setTitleColor(.white, for: .normal)
        aeLockBtn.backgroundColor = UIColor(white: 1, alpha: 0.14)
        aeLockBtn.layer.cornerRadius = 10
        aeLockBtn.contentEdgeInsets = UIEdgeInsets(top: 5, left: 6, bottom: 5, right: 6)
        aeLockBtn.setContentCompressionResistancePriority(.required, for: .horizontal)
        aeLockBtn.addTarget(self, action: #selector(didTapAeAfLock), for: .touchUpInside)
        aeLockBtn.translatesAutoresizingMaskIntoConstraints = false

        settingsBtn.setTitle("⚙️", for: .normal)
        settingsBtn.titleLabel?.font = .systemFont(ofSize: 17)
        settingsBtn.setContentCompressionResistancePriority(.required, for: .horizontal)
        settingsBtn.addTarget(self, action: #selector(didTapSettings), for: .touchUpInside)
        settingsBtn.translatesAutoresizingMaskIntoConstraints = false

        closeBtn.setTitle("✕", for: .normal)
        closeBtn.titleLabel?.font = .systemFont(ofSize: 16, weight: .bold)
        closeBtn.setTitleColor(.white, for: .normal)
        closeBtn.backgroundColor = UIColor(white: 1, alpha: 0.14)
        closeBtn.layer.cornerRadius = 14
        closeBtn.addTarget(self, action: #selector(didTapClose), for: .touchUpInside)
        closeBtn.translatesAutoresizingMaskIntoConstraints = false

        let row = UIStackView(arrangedSubviews: [connPill, lensSeg, fpsBadge, aeLockBtn, settingsBtn, closeBtn])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 4
        row.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(row)

        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            topBar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
            topBar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
            row.topAnchor.constraint(equalTo: topBar.topAnchor, constant: 7),
            row.bottomAnchor.constraint(equalTo: topBar.bottomAnchor, constant: -7),
            row.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -8),
            connPill.heightAnchor.constraint(equalToConstant: 24),
            connPill.widthAnchor.constraint(greaterThanOrEqualToConstant: 56),
            closeBtn.widthAnchor.constraint(equalToConstant: 28),
            closeBtn.heightAnchor.constraint(equalToConstant: 28)
        ])
    }

    private func buildCenterOverlay() {
        centerOverlay.backgroundColor = UIColor(white: 0.06, alpha: 0.78)
        centerOverlay.layer.cornerRadius = 18
        centerOverlay.isHidden = true
        centerOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(centerOverlay)

        centerIconLabel.font = .systemFont(ofSize: 34)
        centerIconLabel.textAlignment = .center
        centerTitleLabel.font = .monospacedDigitSystemFont(ofSize: 24, weight: .black)
        centerTitleLabel.textColor = .white
        centerTitleLabel.textAlignment = .center
        centerTitleLabel.numberOfLines = 2
        centerSubLabel.font = .systemFont(ofSize: 14, weight: .medium)
        centerSubLabel.textColor = UIColor(white: 0.85, alpha: 1)
        centerSubLabel.textAlignment = .center
        centerSubLabel.numberOfLines = 3
        centerProg.progressTintColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        centerProg.trackTintColor = UIColor(white: 1, alpha: 0.22)
        centerCancelBtn.setTitle("Cancel", for: .normal)
        centerCancelBtn.setTitleColor(.white, for: .normal)
        centerCancelBtn.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        centerCancelBtn.backgroundColor = UIColor(white: 1, alpha: 0.18)
        centerCancelBtn.layer.cornerRadius = 10
        centerCancelBtn.contentEdgeInsets = UIEdgeInsets(top: 7, left: 16, bottom: 7, right: 16)
        centerCancelBtn.addTarget(self, action: #selector(didTapCancelCal), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [centerIconLabel, centerTitleLabel, centerSubLabel, centerProg, centerCancelBtn])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        centerOverlay.addSubview(stack)

        NSLayoutConstraint.activate([
            centerOverlay.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            centerOverlay.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -24),
            centerOverlay.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
            centerOverlay.widthAnchor.constraint(greaterThanOrEqualToConstant: 240),
            stack.topAnchor.constraint(equalTo: centerOverlay.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: centerOverlay.bottomAnchor, constant: -18),
            stack.leadingAnchor.constraint(equalTo: centerOverlay.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: centerOverlay.trailingAnchor, constant: -18),
            centerProg.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
    }

    private func buildBottomBar() {
        bottomBar.backgroundColor = UIColor(white: 0.06, alpha: 0.78)
        bottomBar.layer.cornerRadius = 18
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bottomBar)

        stateBanner.font = .systemFont(ofSize: 13, weight: .bold)
        stateBanner.textColor = .white
        stateBanner.textAlignment = .center
        stateBanner.numberOfLines = 2

        meterTrack.backgroundColor = UIColor(white: 1, alpha: 0.16)
        meterTrack.layer.cornerRadius = 5
        meterTrack.clipsToBounds = true
        meterTrack.translatesAutoresizingMaskIntoConstraints = false

        meterFill.backgroundColor = UIColor(red: 0.35, green: 0.78, blue: 0.98, alpha: 1)
        meterFill.layer.cornerRadius = 5
        meterFill.translatesAutoresizingMaskIntoConstraints = false
        meterTrack.addSubview(meterFill)

        meterThreshMark.backgroundColor = UIColor(red: 1.0, green: 0.84, blue: 0.04, alpha: 1)
        meterThreshMark.translatesAutoresizingMaskIntoConstraints = false
        meterTrack.addSubview(meterThreshMark)

        meterFillWidth = meterFill.widthAnchor.constraint(equalToConstant: 0)
        meterThreshLeading = meterThreshMark.leadingAnchor.constraint(equalTo: meterTrack.leadingAnchor, constant: 40)

        NSLayoutConstraint.activate([
            meterTrack.heightAnchor.constraint(equalToConstant: 10),
            meterFill.leadingAnchor.constraint(equalTo: meterTrack.leadingAnchor),
            meterFill.topAnchor.constraint(equalTo: meterTrack.topAnchor),
            meterFill.bottomAnchor.constraint(equalTo: meterTrack.bottomAnchor),
            meterFillWidth,
            meterThreshMark.topAnchor.constraint(equalTo: meterTrack.topAnchor),
            meterThreshMark.bottomAnchor.constraint(equalTo: meterTrack.bottomAnchor),
            meterThreshMark.widthAnchor.constraint(equalToConstant: 3),
            meterThreshLeading
        ])

        meterValueLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        meterValueLabel.textColor = UIColor(white: 0.88, alpha: 1)
        meterValueLabel.textAlignment = .center

        let styleBtn: (UIButton, String, UIColor) -> Void = { b, title, bg in
            b.setTitle(title, for: .normal)
            b.setTitleColor(.white, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 13, weight: .bold)
            b.titleLabel?.numberOfLines = 1
            b.backgroundColor = bg
            b.layer.cornerRadius = 12
            b.contentEdgeInsets = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        }
        styleBtn(calBtn, "🎯 Calibrate", UIColor(red: 0.12, green: 0.23, blue: 0.32, alpha: 1))
        styleBtn(recBtn, "● Record", UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1))
        styleBtn(lockBtn, "🔒 Lock", UIColor(white: 1, alpha: 0.16))
        styleBtn(pairBtn, "📷 Pair QR", UIColor(white: 1, alpha: 0.16))

        calBtn.addTarget(self, action: #selector(didTapCalibrate), for: .touchUpInside)
        recBtn.addTarget(self, action: #selector(didTapRecord), for: .touchUpInside)
        lockBtn.addTarget(self, action: #selector(didTapLock), for: .touchUpInside)
        pairBtn.addTarget(self, action: #selector(didTapPairQR), for: .touchUpInside)

        let btnRow = UIStackView(arrangedSubviews: [calBtn, recBtn, lockBtn, pairBtn])
        btnRow.axis = .horizontal
        btnRow.distribution = .fillEqually
        btnRow.spacing = 6

        pendingBtn.setTitleColor(UIColor(red: 1.0, green: 0.84, blue: 0.04, alpha: 1), for: .normal)
        pendingBtn.titleLabel?.font = .systemFont(ofSize: 12, weight: .bold)
        pendingBtn.isHidden = true
        pendingBtn.addTarget(self, action: #selector(didTapRetryPending), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [stateBanner, meterTrack, meterValueLabel, btnRow, pendingBtn])
        stack.axis = .vertical
        stack.spacing = 7
        stack.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.addSubview(stack)

        NSLayoutConstraint.activate([
            bottomBar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 10),
            bottomBar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -10),
            bottomBar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: bottomBar.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: bottomBar.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -12)
        ])
    }

    private func buildQROverlay() {
        qrOverlay.backgroundColor = UIColor(white: 0, alpha: 0.35)
        qrOverlay.isHidden = true
        qrOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(qrOverlay)

        qrBoxView.layer.borderColor = UIColor(red: 1.0, green: 0.84, blue: 0.04, alpha: 1).cgColor
        qrBoxView.layer.borderWidth = 3
        qrBoxView.layer.cornerRadius = 18
        qrBoxView.backgroundColor = .clear
        qrBoxView.translatesAutoresizingMaskIntoConstraints = false
        qrOverlay.addSubview(qrBoxView)

        qrTitleLabel.text = "Scan the QR code on your laptop's 360 Desk"
        qrTitleLabel.font = .systemFont(ofSize: 16, weight: .bold)
        qrTitleLabel.textColor = .white
        qrTitleLabel.textAlignment = .center
        qrTitleLabel.numberOfLines = 0
        qrTitleLabel.translatesAutoresizingMaskIntoConstraints = false
        qrOverlay.addSubview(qrTitleLabel)

        qrManualBtn.setTitle("Paste / Enter Laptop URL", for: .normal)
        qrManualBtn.setTitleColor(.white, for: .normal)
        qrManualBtn.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        qrManualBtn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        qrManualBtn.layer.cornerRadius = 12
        qrManualBtn.contentEdgeInsets = UIEdgeInsets(top: 10, left: 18, bottom: 10, right: 18)
        qrManualBtn.addTarget(self, action: #selector(didTapManualUrl), for: .touchUpInside)
        qrManualBtn.translatesAutoresizingMaskIntoConstraints = false
        qrOverlay.addSubview(qrManualBtn)

        qrCancelBtn.setTitle("Cancel scan", for: .normal)
        qrCancelBtn.setTitleColor(.white, for: .normal)
        qrCancelBtn.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
        qrCancelBtn.backgroundColor = UIColor(white: 0.15, alpha: 0.85)
        qrCancelBtn.layer.cornerRadius = 10
        qrCancelBtn.contentEdgeInsets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
        qrCancelBtn.addTarget(self, action: #selector(didTapCancelQR), for: .touchUpInside)
        qrCancelBtn.translatesAutoresizingMaskIntoConstraints = false
        qrOverlay.addSubview(qrCancelBtn)

        NSLayoutConstraint.activate([
            qrOverlay.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 6),
            qrOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            qrOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            qrOverlay.bottomAnchor.constraint(equalTo: bottomBar.topAnchor, constant: -6),

            qrBoxView.centerXAnchor.constraint(equalTo: qrOverlay.centerXAnchor),
            qrBoxView.centerYAnchor.constraint(equalTo: qrOverlay.centerYAnchor, constant: -24),
            qrBoxView.widthAnchor.constraint(equalToConstant: 210),
            qrBoxView.heightAnchor.constraint(equalToConstant: 210),

            qrTitleLabel.bottomAnchor.constraint(equalTo: qrBoxView.topAnchor, constant: -16),
            qrTitleLabel.leadingAnchor.constraint(equalTo: qrOverlay.leadingAnchor, constant: 24),
            qrTitleLabel.trailingAnchor.constraint(equalTo: qrOverlay.trailingAnchor, constant: -24),

            qrManualBtn.topAnchor.constraint(equalTo: qrBoxView.bottomAnchor, constant: 18),
            qrManualBtn.centerXAnchor.constraint(equalTo: qrOverlay.centerXAnchor),

            qrCancelBtn.topAnchor.constraint(equalTo: qrManualBtn.bottomAnchor, constant: 10),
            qrCancelBtn.centerXAnchor.constraint(equalTo: qrOverlay.centerXAnchor)
        ])
    }

    private func buildSettingsOverlay() {
        settingsOverlay.backgroundColor = UIColor(white: 0, alpha: 0.65)
        settingsOverlay.isHidden = true
        settingsOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(settingsOverlay)

        settingsCard.backgroundColor = UIColor(red: 0.11, green: 0.10, blue: 0.12, alpha: 1)
        settingsCard.layer.cornerRadius = 18
        settingsCard.layer.borderWidth = 1
        settingsCard.layer.borderColor = UIColor(white: 1, alpha: 0.15).cgColor
        settingsCard.translatesAutoresizingMaskIntoConstraints = false
        settingsOverlay.addSubview(settingsCard)

        let title = UILabel()
        title.text = "360 Arm Motion Settings"
        title.font = .systemFont(ofSize: 18, weight: .bold)
        title.textColor = .white

        let note = UILabel()
        note.text = "Motion auto-start pauses while Settings is open."
        note.font = .systemFont(ofSize: 12, weight: .regular)
        note.textColor = UIColor(white: 0.72, alpha: 1)

        threshReadoutLabel.font = .monospacedDigitSystemFont(ofSize: 14, weight: .bold)
        threshReadoutLabel.textColor = UIColor(red: 1.0, green: 0.84, blue: 0.04, alpha: 1)

        threshSlider.minimumValue = 10
        threshSlider.maximumValue = 120
        threshSlider.tintColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        threshSlider.addTarget(self, action: #selector(didSlideThreshold), for: .valueChanged)

        liveGyroSettingsLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        liveGyroSettingsLabel.textColor = UIColor(red: 0.35, green: 0.78, blue: 0.98, alpha: 1)

        let calInSettingsBtn = UIButton(type: .system)
        calInSettingsBtn.setTitle("🎯 Run Configure Sensitivity Wizard", for: .normal)
        calInSettingsBtn.setTitleColor(.white, for: .normal)
        calInSettingsBtn.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        calInSettingsBtn.backgroundColor = UIColor(red: 0.12, green: 0.23, blue: 0.32, alpha: 1)
        calInSettingsBtn.layer.cornerRadius = 10
        calInSettingsBtn.contentEdgeInsets = UIEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        calInSettingsBtn.addTarget(self, action: #selector(didTapCalibrate), for: .touchUpInside)

        let saveLbl = UILabel()
        saveLbl.text = "Also save clips to Photos app"
        saveLbl.font = .systemFont(ofSize: 14, weight: .medium)
        saveLbl.textColor = .white
        savePhotosSwitch.addTarget(self, action: #selector(didToggleSavePhotos), for: .valueChanged)
        let saveRow = UIStackView(arrangedSubviews: [saveLbl, savePhotosSwitch])
        saveRow.axis = .horizontal
        saveRow.alignment = .center

        deskCfgSummaryLabel.font = .systemFont(ofSize: 12, weight: .regular)
        deskCfgSummaryLabel.textColor = UIColor(white: 0.78, alpha: 1)
        deskCfgSummaryLabel.numberOfLines = 0

        let urlBtn = UIButton(type: .system)
        urlBtn.setTitle("Enter Laptop URL Manually", for: .normal)
        urlBtn.setTitleColor(.white, for: .normal)
        urlBtn.titleLabel?.font = .systemFont(ofSize: 13, weight: .bold)
        urlBtn.backgroundColor = UIColor(white: 1, alpha: 0.14)
        urlBtn.layer.cornerRadius = 10
        urlBtn.contentEdgeInsets = UIEdgeInsets(top: 9, left: 12, bottom: 9, right: 12)
        urlBtn.addTarget(self, action: #selector(didTapManualUrl), for: .touchUpInside)

        settingsPendingBtn.setTitleColor(.white, for: .normal)
        settingsPendingBtn.titleLabel?.font = .systemFont(ofSize: 13, weight: .bold)
        settingsPendingBtn.backgroundColor = UIColor(red: 0.72, green: 0.45, blue: 0.08, alpha: 1)
        settingsPendingBtn.layer.cornerRadius = 10
        settingsPendingBtn.contentEdgeInsets = UIEdgeInsets(top: 9, left: 12, bottom: 9, right: 12)
        settingsPendingBtn.addTarget(self, action: #selector(didTapRetryPending), for: .touchUpInside)

        let doneBtn = UIButton(type: .system)
        doneBtn.setTitle("Done", for: .normal)
        doneBtn.setTitleColor(.white, for: .normal)
        doneBtn.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
        doneBtn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        doneBtn.layer.cornerRadius = 12
        doneBtn.contentEdgeInsets = UIEdgeInsets(top: 11, left: 14, bottom: 11, right: 14)
        doneBtn.addTarget(self, action: #selector(didTapCloseSettings), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [
            title, note, threshReadoutLabel, threshSlider, liveGyroSettingsLabel,
            calInSettingsBtn, saveRow, deskCfgSummaryLabel, urlBtn, settingsPendingBtn, doneBtn
        ])
        stack.axis = .vertical
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        settingsCard.addSubview(stack)

        NSLayoutConstraint.activate([
            settingsOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            settingsOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            settingsOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            settingsOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            settingsCard.centerXAnchor.constraint(equalTo: settingsOverlay.centerXAnchor),
            settingsCard.centerYAnchor.constraint(equalTo: settingsOverlay.centerYAnchor),
            settingsCard.widthAnchor.constraint(lessThanOrEqualToConstant: 360),
            settingsCard.leadingAnchor.constraint(greaterThanOrEqualTo: settingsOverlay.leadingAnchor, constant: 18),
            settingsCard.trailingAnchor.constraint(lessThanOrEqualTo: settingsOverlay.trailingAnchor, constant: -18),

            stack.topAnchor.constraint(equalTo: settingsCard.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: settingsCard.bottomAnchor, constant: -18),
            stack.leadingAnchor.constraint(equalTo: settingsCard.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: settingsCard.trailingAnchor, constant: -18)
        ])
    }

    private func buildLockOverlay() {
        lockOverlay.backgroundColor = UIColor(white: 0.0, alpha: 0.86)
        lockOverlay.isHidden = true
        lockOverlay.translatesAutoresizingMaskIntoConstraints = false
        let lp = UILongPressGestureRecognizer(target: self, action: #selector(handleUnlockLongPress(_:)))
        lp.minimumPressDuration = 1.4
        lockOverlay.addGestureRecognizer(lp)
        view.addSubview(lockOverlay)

        lockStatusLabel.font = .monospacedDigitSystemFont(ofSize: 20, weight: .bold)
        lockStatusLabel.textColor = .white
        lockStatusLabel.textAlignment = .center
        lockStatusLabel.translatesAutoresizingMaskIntoConstraints = false
        lockOverlay.addSubview(lockStatusLabel)

        lockHintLabel.text = "Screen locked for spinning.\nPress & hold 1.5 s anywhere to unlock."
        lockHintLabel.font = .systemFont(ofSize: 14, weight: .medium)
        lockHintLabel.textColor = UIColor(white: 0.72, alpha: 1)
        lockHintLabel.textAlignment = .center
        lockHintLabel.numberOfLines = 0
        lockHintLabel.translatesAutoresizingMaskIntoConstraints = false
        lockOverlay.addSubview(lockHintLabel)

        NSLayoutConstraint.activate([
            lockOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            lockOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            lockOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            lockOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            lockStatusLabel.centerXAnchor.constraint(equalTo: lockOverlay.centerXAnchor),
            lockStatusLabel.centerYAnchor.constraint(equalTo: lockOverlay.centerYAnchor, constant: -18),
            lockHintLabel.topAnchor.constraint(equalTo: lockStatusLabel.bottomAnchor, constant: 12),
            lockHintLabel.centerXAnchor.constraint(equalTo: lockOverlay.centerXAnchor)
        ])
    }

    private func updateQRScanVisibility() {
        qrOverlay.isHidden = !isPairingScan
        qrCancelBtn.isHidden = sendUrl.isEmpty
        updateUIState()
    }

    private func updateAeAfButtonUI() {
        aeLockBtn.setTitle(aeAfLocked ? "🔒 AE/AF" : "🔓 AE", for: .normal)
        aeLockBtn.backgroundColor = aeAfLocked
            ? UIColor(red: 0.72, green: 0.45, blue: 0.08, alpha: 0.9)
            : UIColor(white: 1, alpha: 0.14)
    }

    private func updateConnPill() {
        if sendUrl.isEmpty {
            connPill.text = " Not Paired "
            connPill.backgroundColor = UIColor(red: 0.72, green: 0.45, blue: 0.08, alpha: 0.9)
        } else if deskConnected {
            connPill.text = deskLaptopName.isEmpty ? " ✓ 360 Desk " : " ✓ \(deskLaptopName) "
            connPill.backgroundColor = UIColor(red: 0.18, green: 0.65, blue: 0.42, alpha: 0.9)
        } else {
            connPill.text = " ⏳ Reconnecting "
            connPill.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 0.9)
        }
    }

    private func updatePendingUI() {
        let count = uploadQueue.count + (isUploadingNow ? 1 : 0)
        if isUploadingNow {
            pendingBtn.isHidden = false
            pendingBtn.setTitle("⬆ Uploading \(activeUploadPct)% (\(uploadQueue.count) queued)", for: .normal)
            settingsPendingBtn.isHidden = false
            settingsPendingBtn.setTitle("Uploading \(activeUploadPct)%…", for: .normal)
        } else if count > 0 {
            pendingBtn.isHidden = false
            pendingBtn.setTitle("↻ Retry pending (\(count))", for: .normal)
            settingsPendingBtn.isHidden = false
            settingsPendingBtn.setTitle("Retry pending uploads (\(count))", for: .normal)
        } else {
            pendingBtn.isHidden = true
            settingsPendingBtn.isHidden = true
        }
    }

    private func updateMeterLayout() {
        let w = meterTrack.bounds.width
        guard w > 10 else { return }
        let maxDps = 120.0
        let tx = CGFloat(min(1.0, max(0.0, startThresholdDps / maxDps))) * (w - 3)
        meterThreshLeading.constant = tx
    }

    private func updateMeterUI() {
        let w = meterTrack.bounds.width
        if w > 10 {
            let maxDps = 120.0
            let fw = CGFloat(min(1.0, max(0.0, smoothedDps / maxDps))) * w
            meterFillWidth.constant = fw
        }
        meterFill.backgroundColor = smoothedDps >= startThresholdDps
            ? UIColor(red: 0.18, green: 0.80, blue: 0.44, alpha: 1)
            : UIColor(red: 0.35, green: 0.78, blue: 0.98, alpha: 1)
        meterValueLabel.text = String(format: "%.0f°/s  ·  Trigger: %.0f°/s  ·  Sent: %d", smoothedDps, startThresholdDps, sentCount)
    }

    private func updateUIState() {
        updateConnPill()
        updatePendingUI()
        updateMeterLayout()
        updateMeterUI()

        switch phase {
        case .calibrating:
            centerOverlay.isHidden = false
            centerCancelBtn.isHidden = false
            centerProg.isHidden = false
            if calStep == .still {
                centerIconLabel.text = "🎯"
                centerTitleLabel.text = "Step 1 of 2: Hold Still"
                centerSubLabel.text = "Measuring idle floor / stand vibration…"
            } else {
                centerIconLabel.text = "🔄"
                centerTitleLabel.text = "Step 2 of 2: Spin Arm Now!"
                centerSubLabel.text = "Start spinning your 360 arm at normal event speed."
            }
            stateBanner.text = "Calibrating sensitivity…"
            recBtn.isEnabled = false
            calBtn.isEnabled = false
        case .recording:
            centerOverlay.isHidden = false
            centerCancelBtn.isHidden = true
            centerProg.isHidden = false
            centerIconLabel.text = "🎥"
            let el = max(0.0, CACurrentMediaTime() - recordingStartedAt)
            let secs = Int(el)
            let tenths = Int((el - Double(secs)) * 10) % 10
            centerTitleLabel.text = String(format: "● REC %02d:%02d.%d", secs / 60, secs % 60, tenths)
            centerSubLabel.text = armConfig.stopMode == "fixed"
                ? "Fixed \(Int(armConfig.fixedSec)) s · \(activeFps) fps"
                : "Auto-stops when arm stops + \(armConfig.tailSec) s tail"
            stateBanner.text = "Recording 360 spin…"
            recBtn.setTitle("■ Stop", for: .normal)
            recBtn.backgroundColor = UIColor(red: 0.85, green: 0.18, blue: 0.12, alpha: 1)
            recBtn.isEnabled = true
            calBtn.isEnabled = false
            if isScreenLocked { lockStatusLabel.text = centerTitleLabel.text ?? "● REC" }
        case .cooldown:
            centerOverlay.isHidden = false
            centerCancelBtn.isHidden = true
            centerProg.isHidden = true
            centerIconLabel.text = "⏳"
            centerTitleLabel.text = "Cooldown"
            centerSubLabel.text = "Waiting for arm to stop before re-arming…"
            stateBanner.text = "Cooldown — waiting for arm to stop"
            recBtn.setTitle("● Record", for: .normal)
            recBtn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
            recBtn.isEnabled = true
            calBtn.isEnabled = true
            if isScreenLocked { lockStatusLabel.text = "COOLDOWN" }
        case .idle:
            centerOverlay.isHidden = true
            recBtn.setTitle("● Record", for: .normal)
            recBtn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
            recBtn.isEnabled = !isPairingScan
            calBtn.isEnabled = true
            if isPairingScan {
                stateBanner.text = "Scan the QR on your laptop's 360 Desk"
            } else if armConfig.trigger == "arm" {
                stateBanner.text = "● Armed — recording auto-starts when the 360 arm spins"
            } else if armConfig.trigger == "desk" {
                stateBanner.text = "Ready — press Start on the laptop 360 Desk (or Record)"
            } else {
                stateBanner.text = "Ready — tap Record or use remote"
            }
            if isScreenLocked {
                lockStatusLabel.text = armConfig.trigger == "arm" ? "● ARMED (MOTION)" : "READY"
            }
        }
    }

    private func showToast(_ text: String) {
        toastWorkItem?.cancel()
        toastLabel.layer.removeAllAnimations()
        toastLabel.text = "  \(text)  "
        toastLabel.alpha = 1
        let work = DispatchWorkItem { [weak self] in
            UIView.animate(withDuration: 0.35, delay: 0, options: [.allowUserInteraction]) {
                self?.toastLabel.alpha = 0
            }
        }
        toastWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.8, execute: work)
    }
}
