import UIKit
import AVFoundation
import CoreMotion
import AudioToolbox
import Photos
import PhotosUI
import UniformTypeIdentifiers

/// Native 360 Arm Camera Companion & Standalone 360 Booth Mode.
/// Mounts on the spinning 360 arm, reads CoreMotion rotation rate at 50 Hz,
/// supports guided "Configure Sensitivity" calibration, records 1080p 60/120 fps,
/// and either renders on-device (PNG overlay + slow-mo/speed ramp + music -> local /station Sharing Station)
/// or streams raw clips offline over local booth Wi-Fi to the desktop 360 Desk.
final class SpinArmViewController: UIViewController,
    AVCaptureFileOutputRecordingDelegate,
    AVCaptureMetadataOutputObjectsDelegate,
    URLSessionDataDelegate,
    UIDocumentPickerDelegate,
    PHPickerViewControllerDelegate,
    UITextFieldDelegate {

    // MARK: - Persistence Keys

    private enum Keys {
        static let sendUrl = "pb4u_spin_arm_url"
        static let startThresh = "pb4u_spin_arm_thresh"
        static let stopThresh = "pb4u_spin_arm_stop_thresh"
        static let lens = "pb4u_spin_arm_lens"
        static let fps = "pb4u_spin_arm_fps"
        static let savePhotos = "pb4u_spin_arm_save_photos"
        static let standaloneMode = "pb4u_spin_standalone_mode"
        static let motionPreset = "pb4u_spin_sa_motion"
        static let outputAspect = "pb4u_spin_sa_aspect"
        static let colorLook = "pb4u_spin_sa_look"
        static let overlayFile = "pb4u_spin_sa_overlay"
        static let musicFile = "pb4u_spin_sa_music"
        static let overlayTitle = "pb4u_spin_sa_title"
        static let overlaySub = "pb4u_spin_sa_sub"
        static let saTrigger = "pb4u_spin_sa_trigger"
        static let saStopMode = "pb4u_spin_sa_stop"
        static let saFixedSec = "pb4u_spin_sa_fixed"
        static let skipQuickShare = "pb4u_spin_sa_skip_share"
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
        case rendering
        case cooldown
    }

    private enum PickerKind {
        case overlayFile
        case musicFile
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

    // Standalone 360 Mode state
    private var isStandaloneMode: Bool = true
    private var saMotion: SpinRenderer.MotionPreset = .slowMo
    private var saAspect: SpinRenderer.OutputAspect = .portrait9x16
    private var saLook: SpinRenderer.ColorLook = .natural
    private var saOverlayFilename: String = ""
    private var saOverlayImage: UIImage? = nil
    private var saMusicFilename: String = ""
    private var saTitleText: String = ""
    private var saSubText: String = ""
    private var saTrigger: String = "arm"
    private var saStopMode: String = "follow"
    private var saFixedSec: Double = 8.0
    private var skipQuickSharePopup: Bool = false
    private var activePickerKind: PickerKind = .overlayFile
    private var isQuickSharePresented: Bool = false
    private weak var activeQuickShareVC: SpinQuickShareViewController?
    private var renderProgress: Float = 0.0

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
    private var sessionRuntimeObserver: NSObjectProtocol?
    private var sessionInterruptedObserver: NSObjectProtocol?
    private var sessionInterruptionEndedObserver: NSObjectProtocol?
    private var cameraRecoveryWorkItem: DispatchWorkItem?
    private var isSessionConfigured = false
    private var hasBootedCameraAndSensors = false
    private var hasRequestedAudioOnce = false

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
    private let overlayPreviewView = UIImageView()
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
    private let lookQuickBtn = UIButton(type: .system)
    private let pendingBtn = UIButton(type: .system)

    // Settings Sheet
    private let settingsOverlay = UIView()
    private let settingsCard = UIView()
    private let settingsScroll = UIScrollView()
    private let modeSeg = UISegmentedControl(items: ["Standalone 360", "Laptop Desk"])
    private let standaloneSettingsStack = UIStackView()
    private let deskSettingsStack = UIStackView()
    private let motionMenuBtn = UIButton(type: .system)
    private let aspectSeg = UISegmentedControl(items: ["9:16", "1:1", "16:9"])
    private let lookMenuBtn = UIButton(type: .system)
    private let overlayThumbView = UIImageView()
    private let overlayStatusLabel = UILabel()
    private let saTitleField = UITextField()
    private let saSubField = UITextField()
    private let musicStatusLabel = UILabel()
    private let saTriggerSeg = UISegmentedControl(items: ["Auto Spin", "Manual"])
    private let saStopSeg = UISegmentedControl(items: ["Follow Arm", "Fixed 8s", "Fixed 12s"])
    private let saFpsSeg = UISegmentedControl(items: ["60 FPS", "120 FPS"])
    private let skipShareSwitch = UISwitch()
    private let threshSlider = UISlider()
    private let threshReadoutLabel = UILabel()
    private let liveGyroSettingsLabel = UILabel()
    private let savePhotosSwitch = UISwitch()
    private let deskCfgSummaryLabel = UILabel()
    private let settingsPendingBtn = UIButton(type: .system)

    // Sharing Station QR Modal
    private let stationOverlay = UIView()
    private let stationQrView = UIImageView()
    private let stationUrlLabel = UILabel()

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
        NotificationCenter.default.addObserver(self, selector: #selector(handleKeyboardNotification(_:)), name: UIResponder.keyboardWillShowNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleKeyboardNotification(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        orientationObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.syncOrientationIfIdle()
            self?.ensureCameraRunningIfNeeded()
        }
        sessionRuntimeObserver = NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main) { [weak self] _ in
            self?.scheduleCameraRecovery(reconfigure: true)
        }
        sessionInterruptedObserver = NotificationCenter.default.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: .main) { [weak self] _ in
            self?.cameraRecoveryWorkItem?.cancel()
        }
        sessionInterruptionEndedObserver = NotificationCenter.default.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: .main) { [weak self] _ in
            self?.scheduleCameraRecovery(reconfigure: false)
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

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer?.frame = previewContainer.bounds
        CATransaction.commit()
        syncOrientationIfIdle()
        ensureCameraRunningIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer?.frame = previewContainer.bounds
        CATransaction.commit()
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
        if let obs = sessionRuntimeObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = sessionInterruptedObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = sessionInterruptionEndedObserver { NotificationCenter.default.removeObserver(obs) }
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
        cameraRecoveryWorkItem?.cancel()
        cameraRecoveryWorkItem = nil
        if let obs = sessionRuntimeObserver {
            NotificationCenter.default.removeObserver(obs)
            sessionRuntimeObserver = nil
        }
        if let obs = sessionInterruptedObserver {
            NotificationCenter.default.removeObserver(obs)
            sessionInterruptedObserver = nil
        }
        if let obs = sessionInterruptionEndedObserver {
            NotificationCenter.default.removeObserver(obs)
            sessionInterruptionEndedObserver = nil
        }
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

        if !PBLocal.shared.spinContext.standaloneAllowed {
            isStandaloneMode = false
        } else if ud.object(forKey: Keys.standaloneMode) != nil {
            isStandaloneMode = ud.bool(forKey: Keys.standaloneMode)
        } else {
            isStandaloneMode = sendUrl.isEmpty
        }

        if let rawMot = ud.string(forKey: Keys.motionPreset), let m = SpinRenderer.MotionPreset(rawValue: rawMot) {
            saMotion = m
        }
        if let rawAsp = ud.string(forKey: Keys.outputAspect), let a = SpinRenderer.OutputAspect(rawValue: rawAsp) {
            saAspect = a
        }
        if let rawLk = ud.string(forKey: Keys.colorLook), let l = SpinRenderer.ColorLook(rawValue: rawLk) {
            saLook = l
        }
        saOverlayFilename = ud.string(forKey: Keys.overlayFile) ?? ""
        if !saOverlayFilename.isEmpty {
            let u = PBLocal.shared.overlaysDirectory().appendingPathComponent(saOverlayFilename)
            if let data = try? Data(contentsOf: u), let img = UIImage(data: data) {
                saOverlayImage = img
            } else {
                saOverlayFilename = ""
            }
        }
        saMusicFilename = ud.string(forKey: Keys.musicFile) ?? ""
        if !saMusicFilename.isEmpty {
            let mu = PBLocal.shared.overlaysDirectory().appendingPathComponent(saMusicFilename)
            if !FileManager.default.fileExists(atPath: mu.path) {
                saMusicFilename = ""
            }
        }
        saTitleText = ud.string(forKey: Keys.overlayTitle) ?? ""
        if saTitleText.isEmpty {
            saTitleText = PBLocal.shared.spinContext.eventName
        }
        saSubText = ud.string(forKey: Keys.overlaySub) ?? ""
        if let stTrig = ud.string(forKey: Keys.saTrigger), ["arm", "manual"].contains(stTrig) {
            saTrigger = stTrig
        }
        if let stStop = ud.string(forKey: Keys.saStopMode), ["follow", "fixed"].contains(stStop) {
            saStopMode = stStop
        }
        let fx = ud.double(forKey: Keys.saFixedSec)
        if fx >= 4 && fx <= 30 { saFixedSec = fx }
        skipQuickSharePopup = ud.bool(forKey: Keys.skipQuickShare)

        if isStandaloneMode {
            armConfig.trigger = saTrigger
            armConfig.stopMode = saStopMode
            armConfig.fixedSec = saFixedSec
        }
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
        let camStatus = AVCaptureDevice.authorizationStatus(for: .video)
        if camStatus == .authorized {
            bootCameraAndSensors()
        } else if camStatus == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self = self, !self.hasTornDown else { return }
                    if granted {
                        self.bootCameraAndSensors()
                    } else {
                        self.showCameraDeniedAlert()
                    }
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
        guard !hasBootedCameraAndSensors, !hasTornDown else { return }
        hasBootedCameraAndSensors = true
        isPairingScan = (!isStandaloneMode && sendUrl.isEmpty)
        // Start camera preview FIRST so live video appears immediately upon opening 360 Arm Cam.
        configureCameraSession()
        updateQRScanVisibility()
        refreshLiveOverlayPreview()
        updateUIState()
        _ = LocalShareServer.shared.start()
        LocalShareServer.shared.ensureListening(forceRestart: false)
        startMotionEngine()
        startHeartbeatTimer()
        if !isStandaloneMode && !sendUrl.isEmpty {
            verifyPairAndFetchConfig(url: sendUrl, silent: true)
            processNextUploadIfNeeded()
        }
        // Request microphone permission in parallel without blocking initial live camera preview.
        if !hasRequestedAudioOnce && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            hasRequestedAudioOnce = true
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                guard granted else { return }
                DispatchQueue.main.async {
                    guard let self = self, !self.hasTornDown, !self.isPairingScan, self.phase != .recording else { return }
                    self.attachAudioInputIfNeeded()
                }
            }
        }
    }

    private func attachAudioInputIfNeeded() {
        camQueue.async { [weak self] in
            guard let self = self, !self.hasTornDown, self.audioInput == nil, !self.movieOutput.isRecording else { return }
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
                  let mic = AVCaptureDevice.default(for: .audio),
                  let aIn = try? AVCaptureDeviceInput(device: mic) else { return }
            let avs = AVAudioSession.sharedInstance()
            try? avs.setCategory(.playAndRecord, mode: .videoRecording, options: [.defaultToSpeaker, .allowBluetooth])
            try? avs.setActive(true)
            self.session.beginConfiguration()
            if self.session.canAddInput(aIn) {
                self.session.addInput(aIn)
                self.audioInput = aIn
            }
            self.session.commitConfiguration()
        }
    }

    private func scheduleCameraRecovery(reconfigure: Bool) {
        guard !hasTornDown else { return }
        cameraRecoveryWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, !self.hasTornDown else { return }
            guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return }
            if reconfigure {
                self.configureCameraSession()
            } else {
                self.ensureCameraRunningIfNeeded()
            }
        }
        cameraRecoveryWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    private func ensureCameraRunningIfNeeded() {
        guard !hasTornDown, hasBootedCameraAndSensors else { return }
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return }
        camQueue.async { [weak self] in
            guard let self = self, !self.hasTornDown else { return }
            if !self.isSessionConfigured {
                DispatchQueue.main.async { [weak self] in
                    self?.configureCameraSession()
                }
                return
            }
            if !self.session.isRunning {
                self.session.startRunning()
                if !self.session.isRunning {
                    DispatchQueue.main.async { [weak self] in
                        self?.configureCameraSession()
                    }
                    return
                }
            }
            if let dev = self.currentDevice {
                self.setupRotation(for: dev)
            }
        }
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

    private func bestFormat(for device: AVCaptureDevice, desiredFps: Int) -> (AVCaptureDevice.Format, Int, CMTime)? {
        let candidates = desiredFps >= 120 ? [120, 60, 30] : (desiredFps >= 60 ? [60, 30] : [30])
        // Pass 1: strictly 8-bit 4:2:0 YUV (skips 10-bit HDR x420 / ProRes formats on iPhone 15 Pro Max that clash with H.264).
        // Pass 2: fallback to any format only if no 8-bit 4:2:0 format matches.
        for require8Bit420 in [true, false] {
            for fps in candidates {
                var best1080: (AVCaptureDevice.Format, CMTime, Int)?
                var best720: (AVCaptureDevice.Format, CMTime, Int)?
                var bestAny: (AVCaptureDevice.Format, CMTime, Int)?

                for fmt in device.formats {
                    let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
                    let w = Int(dims.width), h = Int(dims.height)
                    guard w >= 1280 && h >= 720 else { continue }

                    let sub = CMFormatDescriptionGetMediaSubType(fmt.formatDescription)
                    let is420 = (sub == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || sub == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
                    if require8Bit420 && !is420 { continue }

                    guard let range = fmt.videoSupportedFrameRateRanges.first(where: { r in
                        r.minFrameRate <= Double(fps) + 0.01 && r.maxFrameRate >= Double(fps) - 0.05
                    }) else { continue }

                    var dur = CMTime(value: 1, timescale: CMTimeScale(fps))
                    if CMTimeCompare(dur, range.minFrameDuration) < 0 { dur = range.minFrameDuration }
                    if CMTimeCompare(dur, range.maxFrameDuration) > 0 { dur = range.maxFrameDuration }

                    // Prefer SDR (!isVideoHDRSupported) + unbinned 8-bit 4:2:0 for crisp, fast H.264 capture.
                    let rank = (is420 ? 10 : 0) + (!fmt.isVideoHDRSupported ? 4 : 0) + (!fmt.isVideoBinned ? 2 : 0)

                    if w == 1920 && h == 1080 {
                        if best1080 == nil || rank > best1080!.2 {
                            best1080 = (fmt, dur, rank)
                        }
                    } else if w == 1280 && h == 720 {
                        if best720 == nil || rank > best720!.2 {
                            best720 = (fmt, dur, rank)
                        }
                    } else if w <= 1920 {
                        if bestAny == nil || rank > bestAny!.2 {
                            bestAny = (fmt, dur, rank)
                        }
                    }
                }
                if let chosen = best1080 ?? best720 ?? bestAny {
                    return (chosen.0, fps, chosen.1)
                }
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
            guard let self = self, !self.hasTornDown else { return }
            guard let device = self.pickCaptureDevice(for: choice, scanningQr: scanning) else {
                DispatchQueue.main.async { self.showToast("No camera available on this device.") }
                return
            }

            if self.session.isRunning {
                self.session.stopRunning()
            }

            self.session.beginConfiguration()

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

            var activeDevice = device
            do {
                let vIn = try AVCaptureDeviceInput(device: device)
                if self.session.canAddInput(vIn) {
                    self.session.addInput(vIn)
                    self.currentVideoInput = vIn
                    self.currentDevice = device
                } else {
                    throw NSError(domain: "SpinArmCamera", code: 1)
                }
            } catch {
                // Fallback to standard wide back camera if selected lens failed to attach
                if let fallbackDev = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                    ?? AVCaptureDevice.default(for: .video),
                   let vIn = try? AVCaptureDeviceInput(device: fallbackDev),
                   self.session.canAddInput(vIn) {
                    self.session.addInput(vIn)
                    self.currentVideoInput = vIn
                    self.currentDevice = fallbackDev
                    activeDevice = fallbackDev
                } else {
                    self.session.commitConfiguration()
                    DispatchQueue.main.async { self.showToast("Could not open camera.") }
                    return
                }
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

            var chosenFormat: (AVCaptureDevice.Format, Int, CMTime)? = nil
            if !scanning {
                if self.session.canSetSessionPreset(.inputPriority),
                   let match = self.bestFormat(for: activeDevice, desiredFps: wantedFps) {
                    self.session.sessionPreset = .inputPriority
                    do {
                        try activeDevice.lockForConfiguration()
                        activeDevice.activeFormat = match.0
                        activeDevice.activeVideoMinFrameDuration = match.2
                        activeDevice.activeVideoMaxFrameDuration = match.2
                        activeDevice.unlockForConfiguration()
                        chosenFormat = match
                    } catch {
                        self.session.sessionPreset = .high
                    }
                } else {
                    self.session.sessionPreset = .high
                }
            } else {
                self.session.sessionPreset = .high
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
            if let (_, fps, dur) = chosenFormat {
                finalFps = fps
                do {
                    try activeDevice.lockForConfiguration()
                    activeDevice.activeVideoMinFrameDuration = dur
                    activeDevice.activeVideoMaxFrameDuration = dur
                    if !lockAeAf {
                        if activeDevice.isFocusModeSupported(.continuousAutoFocus) { activeDevice.focusMode = .continuousAutoFocus }
                        if activeDevice.isExposureModeSupported(.continuousAutoExposure) { activeDevice.exposureMode = .continuousAutoExposure }
                    } else {
                        if activeDevice.isFocusModeSupported(.locked) { activeDevice.focusMode = .locked }
                        if activeDevice.isExposureModeSupported(.locked) { activeDevice.exposureMode = .locked }
                    }
                    activeDevice.unlockForConfiguration()
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

            // Safety net: if custom format / audio / ultra-wide failed to start running, fall back cleanly to safe .high video-only so live preview appears immediately.
            if !self.session.isRunning && !self.hasTornDown {
                self.session.beginConfiguration()
                if let oldAudio = self.audioInput {
                    self.session.removeInput(oldAudio)
                    self.audioInput = nil
                }
                if let fallbackDev = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                    ?? AVCaptureDevice.default(for: .video),
                   fallbackDev.uniqueID != activeDevice.uniqueID,
                   let vIn = try? AVCaptureDeviceInput(device: fallbackDev) {
                    if let oldIn = self.currentVideoInput {
                        self.session.removeInput(oldIn)
                        self.currentVideoInput = nil
                    }
                    if self.session.canAddInput(vIn) {
                        self.session.addInput(vIn)
                        self.currentVideoInput = vIn
                        self.currentDevice = fallbackDev
                        activeDevice = fallbackDev
                    }
                }
                self.session.sessionPreset = .high
                self.session.commitConfiguration()
                finalFps = 30
                self.session.startRunning()
            }

            self.setupRotation(for: activeDevice)

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
        case .rendering:
            break
        case .cooldown:
            handleCooldownMotionTick(now: now)
        }
    }

    private func handleIdleMotionTick(now: CFTimeInterval) {
        guard !isPairingScan, !isSettingsOpen, !isQuickSharePresented, stationOverlay.isHidden, armConfig.trigger == "arm", !movieOutput.isRecording else {
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
        view.endEditing(true)
        commitTextFields()
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
            if self.isStandaloneMode {
                self.renderAndSaveStandaloneClip(rawURL: outputFileURL)
                return
            }
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

    // MARK: - Standalone 360 On-Device Render + Sharing Station

    private func currentRenderOptions() -> SpinRenderer.Options {
        var musicURL: URL? = nil
        if !saMusicFilename.isEmpty {
            let u = PBLocal.shared.overlaysDirectory().appendingPathComponent(saMusicFilename)
            if FileManager.default.fileExists(atPath: u.path) { musicURL = u }
        }
        return SpinRenderer.Options(
            motion: saMotion,
            aspect: saAspect,
            colorLook: saLook,
            overlayImage: saOverlayImage,
            titleText: saTitleText,
            subtitleText: saSubText,
            musicURL: musicURL,
            trimStartSec: 0.25,
            maxSourceSec: 10.0
        )
    }

    private func renderAndSaveStandaloneClip(rawURL: URL) {
        phase = .rendering
        renderProgress = 0.0
        updateUIState()

        let opts = currentRenderOptions()
        let folderKey = PBLocal.shared.spinContext.folderKey
        let wantPhotos = saveToPhotos

        SpinRenderer.render(sourceURL: rawURL, options: opts, progress: { [weak self] p in
            guard let self = self, self.phase == .rendering else { return }
            self.renderProgress = p
            self.centerProg.progress = p
            self.centerTitleLabel.text = "Rendering \(Int((p * 100).rounded()))%"
        }) { [weak self] result in
            guard let self = self else {
                try? FileManager.default.removeItem(at: rawURL)
                return
            }

            let sourceToSave: URL
            var removeAfterSave: [URL] = []
            switch result {
            case .success(let renderedURL):
                sourceToSave = renderedURL
                removeAfterSave = [rawURL, renderedURL]
            case .failure(let err):
                sourceToSave = rawURL
                removeAfterSave = [rawURL]
                self.showToast("Render fallback (raw saved): \(err.localizedDescription)")
            }

            let saved = PBLocal.shared.saveVideoFile(
                from: sourceToSave,
                folderKey: folderKey.isEmpty ? nil : folderKey,
                subfolder: nil,
                filename: nil,
                saveToPhotos: wantPhotos
            )
            for u in removeAfterSave { try? FileManager.default.removeItem(at: u) }

            guard saved.ok, let destURL = saved.destURL else {
                self.phase = .idle
                self.updateUIState()
                self.showToast("Could not save 360 video: \(saved.error ?? "unknown error")")
                return
            }

            LocalShareServer.shared.ensureListening(forceRestart: false)
            self.sentCount += 1
            self.phase = .cooldown
            self.cooldownStartedAt = CACurrentMediaTime()
            self.stillSince = nil
            self.updateUIState()

            let lanBase = PBLocal.shared.lanBase()
            let localPageURL = lanBase.isEmpty ? "" : "\(lanBase)\(saved.pageUrl)"
            let stationURL = PBLocal.shared.stationUrl()

            if self.skipQuickSharePopup {
                self.activeQuickShareVC = nil
                self.showToast("✓ 360 video ready on Sharing Station (\(self.sentCount))")
                self.uploadRenderedVideoToDriveIfConfigured(fileURL: destURL, slug: saved.slug, filename: saved.filename)
                return
            }

            if self.isScreenLocked {
                self.isScreenLocked = false
                self.lockOverlay.isHidden = true
            }

            let vc = SpinQuickShareViewController(
                videoURL: destURL,
                localPageURL: localPageURL,
                stationURL: stationURL,
                eventTitle: saved.eventTitle,
                slug: saved.slug,
                filename: saved.filename,
                initialOnlineURL: PBLocal.shared.onlineShareUrl(slug: saved.slug, filename: saved.filename)
            )
            vc.onDone = { [weak self] in
                guard let self = self else { return }
                self.activeQuickShareVC = nil
                self.isQuickSharePresented = false
                self.phase = .idle
                self.updateUIState()
            }
            self.activeQuickShareVC = vc
            self.isQuickSharePresented = true
            self.present(vc, animated: true)
            self.uploadRenderedVideoToDriveIfConfigured(fileURL: destURL, slug: saved.slug, filename: saved.filename)
        }
    }

    private func uploadRenderedVideoToDriveIfConfigured(fileURL: URL, slug: String, filename: String) {
        let ctx = PBLocal.shared.spinContext
        let licStr = ctx.licence.isEmpty ? (AppLicence.shared.currentLicenceString() ?? "") : ctx.licence
        let midStr = ctx.mid.isEmpty ? AppLicence.shared.machineId() : ctx.mid
        guard PBLocal.shared.isOnline(),
              !ctx.driveFolderId.isEmpty,
              !ctx.folderKey.isEmpty,
              (!licStr.isEmpty || !ctx.token.isEmpty) else { return }

        let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0 && size <= 27 * 1024 * 1024 else {
            DispatchQueue.main.async { [weak self] in
                self?.activeQuickShareVC?.setCloudSyncStatus("Clip too large for web cloud (>27 MB) — use Local Wi-Fi QR or AirDrop")
            }
            return
        }

        DispatchQueue.main.async { [weak self] in
            self?.activeQuickShareVC?.setCloudSyncStatus("☁️ Syncing to cloud for WhatsApp & Email…")
        }

        var ticketPayload: [String: Any] = ["folderKey": ctx.folderKey]
        if !licStr.isEmpty {
            ticketPayload["licence"] = licStr
            ticketPayload["mid"] = midStr
        } else {
            ticketPayload["token"] = ctx.token
            ticketPayload["deviceId"] = ctx.deviceId
        }

        guard let ticketURL = URL(string: "\(AppLicence.serverUrl)/api/ticket"),
              let ticketBody = try? JSONSerialization.data(withJSONObject: ticketPayload) else { return }

        var tReq = URLRequest(url: ticketURL)
        tReq.httpMethod = "POST"
        tReq.timeoutInterval = 15
        tReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
        tReq.httpBody = ticketBody

        URLSession.shared.dataTask(with: tReq) { [weak self] data, resp, _ in
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
                  let data = data,
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let ticket = obj["ticket"] as? String, !ticket.isEmpty else {
                DispatchQueue.main.async { [weak self] in
                    self?.activeQuickShareVC?.setCloudSyncStatus("Offline/Local QR ready (could not reach cloud ticket)")
                }
                return
            }

            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let videoData = try? Data(contentsOf: fileURL),
                      let scriptURL = URL(string: "https://script.google.com/macros/s/AKfycbxv0WfF9rxFY9QlseCoSjrA7vePwHE-Uc8QTURZYyN6yIzcTj4SIlktEWT6Xnaw6Pv9OA/exec") else { return }
                let b64 = videoData.base64EncodedString()
                let upObj: [String: Any] = [
                    "filename": filename,
                    "mimeType": "video/mp4",
                    "imageBase64": b64,
                    "ticket": ticket
                ]
                guard let upBody = try? JSONSerialization.data(withJSONObject: upObj) else { return }
                var uReq = URLRequest(url: scriptURL)
                uReq.httpMethod = "POST"
                uReq.timeoutInterval = 90
                uReq.setValue("text/plain;charset=utf-8", forHTTPHeaderField: "Content-Type")
                uReq.httpBody = upBody

                URLSession.shared.dataTask(with: uReq) { [weak self] uData, uResp, _ in
                    guard let uHttp = uResp as? HTTPURLResponse, uHttp.statusCode == 200,
                          let uData = uData,
                          let uJson = (try? JSONSerialization.jsonObject(with: uData)) as? [String: Any],
                          (uJson["ok"] as? Bool) == true,
                          let fileId = uJson["id"] as? String, !fileId.isEmpty else {
                        DispatchQueue.main.async { [weak self] in
                            self?.activeQuickShareVC?.setCloudSyncStatus("Local QR & AirDrop ready (cloud upload busy)")
                        }
                        return
                    }
                    let cloudShare = "\(AppLicence.serverUrl)/g/\(ctx.driveFolderId)#\(fileId)"
                    PBLocal.shared.setOnlineShareUrl(slug: slug, filename: filename, url: cloudShare)
                    DispatchQueue.main.async { [weak self] in
                        self?.activeQuickShareVC?.setOnlineShareURL(cloudShare)
                    }
                }.resume()
            }
        }.resume()
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
        guard !isStandaloneMode, !sendUrl.isEmpty, let url = URL(string: sendUrl + "/arm-state") else { return }
        if !force && heartbeatInFlightCount > 0 { return }
        let reportedState: String
        switch phase {
        case .recording: reportedState = "recording"
        case .calibrating: reportedState = "calibrating"
        case .rendering: reportedState = isUploadingNow ? "uploading" : "idle"
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
        let done = onDismiss
        onDismiss = nil
        dismiss(animated: true) {
            done?()
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
        guard !isPairingScan, !isScreenLocked, !isSettingsOpen, stationOverlay.isHidden else { return }
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
        if phase == .rendering { return }
        if phase == .recording {
            stopRecording(reason: "manual")
        } else {
            if phase == .cooldown { phase = .idle }
            beginRecording(reason: "manual")
        }
    }

    @objc private func handleKeyboardNotification(_ note: Notification) {
        guard let info = note.userInfo,
              let endFrame = info[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let showing = note.name == UIResponder.keyboardWillShowNotification
        let inset = showing ? max(0, endFrame.height - view.safeAreaInsets.bottom + 12) : 0
        settingsScroll.contentInset.bottom = inset
        settingsScroll.verticalScrollIndicatorInsets.bottom = inset
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
        if isStandaloneMode {
            openStationModal()
            return
        }
        guard phase != .recording else {
            showToast("Stop recording before pairing.")
            return
        }
        isPairingScan = true
        updateQRScanVisibility()
        configureCameraSession()
    }

    @objc private func didTapConnPill() {
        didTapSettings()
    }

    @objc private func didTapQuickLook() {
        didTapSettings()
    }

    private func openStationModal() {
        _ = LocalShareServer.shared.start()
        LocalShareServer.shared.ensureListening(forceRestart: false)
        let url = PBLocal.shared.stationUrl()
        if url.isEmpty {
            stationUrlLabel.text = "Connect this iPhone/iPad to Wi-Fi or Personal Hotspot first, then open Sharing Station on any tablet or laptop."
            stationQrView.image = nil
        } else {
            stationUrlLabel.text = url
            stationQrView.image = SpinQuickShareViewController.generateQRCode(from: url)
        }
        stationOverlay.isHidden = false
    }

    @objc private func didTapCloseStationModal() {
        stationOverlay.isHidden = true
    }

    @objc private func didTapCopyStationUrl() {
        let url = PBLocal.shared.stationUrl()
        guard !url.isEmpty else {
            showToast("Connect to Wi-Fi or Hotspot first.")
            return
        }
        UIPasteboard.general.string = url
        showToast("✓ Sharing Station URL copied!")
    }

    @objc private func didTapOpenStationSafari() {
        let urlStr = PBLocal.shared.stationUrl()
        guard !urlStr.isEmpty, let u = URL(string: urlStr) else {
            showToast("Connect to Wi-Fi or Hotspot first.")
            return
        }
        UIApplication.shared.open(u, options: [:], completionHandler: nil)
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
        refreshSettingsUI()
        settingsOverlay.isHidden = false
        updatePendingUI()
    }

    @objc private func didTapCloseSettings() {
        view.endEditing(true)
        commitTextFields()
        isSettingsOpen = false
        settingsOverlay.isHidden = true
        updateUIState()
    }

    private func refreshSettingsUI() {
        modeSeg.selectedSegmentIndex = isStandaloneMode ? 0 : 1
        standaloneSettingsStack.isHidden = !isStandaloneMode
        deskSettingsStack.isHidden = isStandaloneMode

        threshSlider.value = Float(startThresholdDps)
        savePhotosSwitch.isOn = saveToPhotos
        threshReadoutLabel.text = String(format: "%.0f°/s (Stop: %.0f°/s)", startThresholdDps, stopThresholdDps)
        deskCfgSummaryLabel.text = "Desk sync: Start = \(armConfig.trigger), Stop = \(armConfig.stopMode == "fixed" ? "Fixed \(Int(armConfig.fixedSec))s" : "Follow arm + \(armConfig.tailSec)s tail"), \(targetFps) fps, Cooldown \(Int(armConfig.cooldownSec))s"

        motionMenuBtn.setTitle("Motion: \(saMotion.label) ▾", for: .normal)
        motionMenuBtn.menu = UIMenu(title: "Motion Effect", children: SpinRenderer.MotionPreset.allCases.map { preset in
            UIAction(title: preset.label, state: preset == saMotion ? .on : .off) { [weak self] _ in
                self?.selectMotionPreset(preset)
            }
        })

        switch saAspect {
        case .portrait9x16: aspectSeg.selectedSegmentIndex = 0
        case .square1x1: aspectSeg.selectedSegmentIndex = 1
        case .landscape16x9: aspectSeg.selectedSegmentIndex = 2
        }

        lookMenuBtn.setTitle("Color Look: \(saLook.label) ▾", for: .normal)
        lookMenuBtn.menu = UIMenu(title: "Color Look", children: SpinRenderer.ColorLook.allCases.map { lk in
            UIAction(title: lk.label, state: lk == saLook ? .on : .off) { [weak self] _ in
                self?.selectColorLook(lk)
            }
        })

        overlayThumbView.image = saOverlayImage
        overlayThumbView.isHidden = (saOverlayImage == nil)
        overlayStatusLabel.text = saOverlayImage == nil ? "No frame overlay (tap to add PNG)" : "Overlay active ✓"
        saTitleField.text = saTitleText
        saSubField.text = saSubText
        musicStatusLabel.text = saMusicFilename.isEmpty ? "No background music" : "🎵 \(saMusicFilename)"
        saTriggerSeg.selectedSegmentIndex = (saTrigger == "manual") ? 1 : 0
        if saStopMode == "fixed" {
            saStopSeg.selectedSegmentIndex = (saFixedSec >= 11.0) ? 2 : 1
        } else {
            saStopSeg.selectedSegmentIndex = 0
        }
        saFpsSeg.selectedSegmentIndex = (targetFps >= 120) ? 1 : 0
        skipShareSwitch.isOn = skipQuickSharePopup
    }

    private func selectMotionPreset(_ preset: SpinRenderer.MotionPreset) {
        saMotion = preset
        UserDefaults.standard.set(preset.rawValue, forKey: Keys.motionPreset)
        refreshSettingsUI()
        updateUIState()
    }

    private func selectColorLook(_ look: SpinRenderer.ColorLook) {
        saLook = look
        UserDefaults.standard.set(look.rawValue, forKey: Keys.colorLook)
        refreshSettingsUI()
    }

    @objc private func didChangeOperatingMode() {
        let wantStandalone = (modeSeg.selectedSegmentIndex == 0)
        if wantStandalone && !PBLocal.shared.spinContext.standaloneAllowed {
            modeSeg.selectedSegmentIndex = 1
            isStandaloneMode = false
            showToast("Standalone 360 is off by default — enable 360 on this code in Admin.")
            refreshSettingsUI()
            updateUIState()
            return
        }
        isStandaloneMode = wantStandalone
        UserDefaults.standard.set(isStandaloneMode, forKey: Keys.standaloneMode)
        if isStandaloneMode {
            armConfig.trigger = saTrigger
            armConfig.stopMode = saStopMode
            armConfig.fixedSec = saFixedSec
            if isPairingScan {
                isPairingScan = false
                updateQRScanVisibility()
                configureCameraSession()
            }
        } else {
            lastConfigSig = ""
            if sendUrl.isEmpty {
                isSettingsOpen = false
                settingsOverlay.isHidden = true
                isPairingScan = true
                updateQRScanVisibility()
                configureCameraSession()
            } else {
                verifyPairAndFetchConfig(url: sendUrl, silent: true)
            }
        }
        refreshLiveOverlayPreview()
        refreshSettingsUI()
        updateUIState()
    }

    @objc private func didChangeAspect() {
        switch aspectSeg.selectedSegmentIndex {
        case 1: saAspect = .square1x1
        case 2: saAspect = .landscape16x9
        default: saAspect = .portrait9x16
        }
        UserDefaults.standard.set(saAspect.rawValue, forKey: Keys.outputAspect)
        updateUIState()
    }

    @objc private func didChangeSaTrigger() {
        saTrigger = (saTriggerSeg.selectedSegmentIndex == 1) ? "manual" : "arm"
        UserDefaults.standard.set(saTrigger, forKey: Keys.saTrigger)
        if isStandaloneMode { armConfig.trigger = saTrigger }
        updateUIState()
    }

    @objc private func didChangeSaStopMode() {
        switch saStopSeg.selectedSegmentIndex {
        case 1:
            saStopMode = "fixed"
            saFixedSec = 8.0
        case 2:
            saStopMode = "fixed"
            saFixedSec = 12.0
        default:
            saStopMode = "follow"
        }
        UserDefaults.standard.set(saStopMode, forKey: Keys.saStopMode)
        UserDefaults.standard.set(saFixedSec, forKey: Keys.saFixedSec)
        if isStandaloneMode {
            armConfig.stopMode = saStopMode
            armConfig.fixedSec = saFixedSec
        }
        updateUIState()
    }

    @objc private func didChangeSaFps() {
        let nextFps = (saFpsSeg.selectedSegmentIndex == 1) ? 120 : 60
        guard nextFps != targetFps else { return }
        targetFps = nextFps
        UserDefaults.standard.set(targetFps, forKey: Keys.fps)
        if phase != .recording && !isPairingScan {
            configureCameraSession()
        }
    }

    @objc private func didToggleSkipShare() {
        skipQuickSharePopup = skipShareSwitch.isOn
        UserDefaults.standard.set(skipQuickSharePopup, forKey: Keys.skipQuickShare)
    }

    @objc private func commitTextFields() {
        saTitleText = (saTitleField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        saSubText = (saSubField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(saTitleText, forKey: Keys.overlayTitle)
        UserDefaults.standard.set(saSubText, forKey: Keys.overlaySub)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        commitTextFields()
        return true
    }

    @objc private func didTapPickOverlayPhotos() {
        var cfg = PHPickerConfiguration(photoLibrary: .shared())
        cfg.filter = .images
        cfg.selectionLimit = 1
        let picker = PHPickerViewController(configuration: cfg)
        picker.delegate = self
        present(picker, animated: true)
    }

    @objc private func didTapPickOverlayFiles() {
        activePickerKind = .overlayFile
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.png, .image], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }

    @objc private func didTapClearOverlay() {
        if !saOverlayFilename.isEmpty {
            try? FileManager.default.removeItem(at: PBLocal.shared.overlaysDirectory().appendingPathComponent(saOverlayFilename))
        }
        saOverlayFilename = ""
        saOverlayImage = nil
        UserDefaults.standard.set("", forKey: Keys.overlayFile)
        refreshLiveOverlayPreview()
        refreshSettingsUI()
        updateUIState()
    }

    @objc private func didTapPickMusic() {
        activePickerKind = .musicFile
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }

    @objc private func didTapClearMusic() {
        if !saMusicFilename.isEmpty {
            try? FileManager.default.removeItem(at: PBLocal.shared.overlaysDirectory().appendingPathComponent(saMusicFilename))
        }
        saMusicFilename = ""
        UserDefaults.standard.set("", forKey: Keys.musicFile)
        refreshSettingsUI()
    }

    private func refreshLiveOverlayPreview() {
        overlayPreviewView.image = saOverlayImage
        overlayPreviewView.isHidden = (!isStandaloneMode || isPairingScan || saOverlayImage == nil)
    }

    private func installOverlayImageData(_ data: Data) {
        guard let img = UIImage(data: data) else {
            showToast("Could not read selected image.")
            return
        }
        let dir = PBLocal.shared.overlaysDirectory()
        if !saOverlayFilename.isEmpty {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(saOverlayFilename))
        }
        let name = "overlay_\(Int64(Date().timeIntervalSince1970)).png"
        let dest = dir.appendingPathComponent(name)
        let pngData = (img.pngData()) ?? data
        try? pngData.write(to: dest)
        saOverlayFilename = name
        saOverlayImage = UIImage(data: pngData) ?? img
        UserDefaults.standard.set(name, forKey: Keys.overlayFile)
        refreshLiveOverlayPreview()
        refreshSettingsUI()
        updateUIState()
        showToast("✓ Overlay frame loaded")
    }

    // MARK: - PHPickerViewControllerDelegate & UIDocumentPickerDelegate

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let item = results.first?.itemProvider else { return }
        if item.hasItemConformingToTypeIdentifier(UTType.png.identifier) {
            item.loadDataRepresentation(forTypeIdentifier: UTType.png.identifier) { [weak self] data, _ in
                if let d = data {
                    DispatchQueue.main.async { self?.installOverlayImageData(d) }
                }
            }
            return
        }
        if item.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            item.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] data, _ in
                if let d = data, let img = UIImage(data: d), let png = img.pngData() {
                    DispatchQueue.main.async { self?.installOverlayImageData(png) }
                }
            }
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let src = urls.first else { return }
        let scoped = src.startAccessingSecurityScopedResource()
        defer { if scoped { src.stopAccessingSecurityScopedResource() } }
        let dir = PBLocal.shared.overlaysDirectory()
        switch activePickerKind {
        case .overlayFile:
            if let data = try? Data(contentsOf: src) {
                installOverlayImageData(data)
            }
        case .musicFile:
            if !saMusicFilename.isEmpty {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(saMusicFilename))
            }
            let rawName = src.lastPathComponent
            let clean = rawName.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
            let dest = dir.appendingPathComponent(clean.isEmpty ? "music.mp3" : clean)
            try? FileManager.default.removeItem(at: dest)
            if (try? FileManager.default.copyItem(at: src, to: dest)) != nil {
                saMusicFilename = dest.lastPathComponent
                UserDefaults.standard.set(saMusicFilename, forKey: Keys.musicFile)
                refreshSettingsUI()
                showToast("✓ Music loaded: \(saMusicFilename)")
            } else {
                showToast("Could not copy audio file.")
            }
        }
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

        overlayPreviewView.frame = previewContainer.bounds
        overlayPreviewView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlayPreviewView.contentMode = .scaleAspectFit
        overlayPreviewView.alpha = 0.85
        overlayPreviewView.isUserInteractionEnabled = false
        overlayPreviewView.isHidden = true
        previewContainer.addSubview(overlayPreviewView)

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
        buildStationOverlay()

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
        connPill.minimumScaleFactor = 0.72
        connPill.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        connPill.isUserInteractionEnabled = true
        connPill.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(didTapConnPill)))
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
            b.titleLabel?.font = .systemFont(ofSize: 12.5, weight: .bold)
            b.titleLabel?.numberOfLines = 1
            b.titleLabel?.adjustsFontSizeToFitWidth = true
            b.titleLabel?.minimumScaleFactor = 0.72
            b.titleLabel?.lineBreakMode = .byClipping
            b.backgroundColor = bg
            b.layer.cornerRadius = 12
            b.contentEdgeInsets = UIEdgeInsets(top: 10, left: 5, bottom: 10, right: 5)
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

        lookQuickBtn.setTitle("🎨 Look & Overlay", for: .normal)
        lookQuickBtn.setTitleColor(.white, for: .normal)
        lookQuickBtn.titleLabel?.font = .systemFont(ofSize: 12.5, weight: .bold)
        lookQuickBtn.titleLabel?.lineBreakMode = .byTruncatingTail
        lookQuickBtn.backgroundColor = UIColor(white: 1, alpha: 0.14)
        lookQuickBtn.layer.cornerRadius = 10
        lookQuickBtn.contentEdgeInsets = UIEdgeInsets(top: 7, left: 10, bottom: 7, right: 10)
        lookQuickBtn.addTarget(self, action: #selector(didTapQuickLook), for: .touchUpInside)

        pendingBtn.setTitleColor(UIColor(red: 1.0, green: 0.84, blue: 0.04, alpha: 1), for: .normal)
        pendingBtn.titleLabel?.font = .systemFont(ofSize: 12, weight: .bold)
        pendingBtn.isHidden = true
        pendingBtn.addTarget(self, action: #selector(didTapRetryPending), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [stateBanner, meterTrack, meterValueLabel, lookQuickBtn, btnRow, pendingBtn])
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

        let qrBoxSize = qrBoxView.widthAnchor.constraint(equalToConstant: 210)
        qrBoxSize.priority = .defaultHigh
        NSLayoutConstraint.activate([
            qrOverlay.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 6),
            qrOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            qrOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            qrOverlay.bottomAnchor.constraint(equalTo: bottomBar.topAnchor, constant: -6),

            qrBoxView.centerXAnchor.constraint(equalTo: qrOverlay.centerXAnchor),
            qrBoxView.centerYAnchor.constraint(equalTo: qrOverlay.centerYAnchor, constant: -16),
            qrBoxSize,
            qrBoxView.widthAnchor.constraint(lessThanOrEqualToConstant: 210),
            qrBoxView.widthAnchor.constraint(lessThanOrEqualTo: qrOverlay.heightAnchor, multiplier: 0.48),
            qrBoxView.heightAnchor.constraint(equalTo: qrBoxView.widthAnchor),

            qrTitleLabel.bottomAnchor.constraint(equalTo: qrBoxView.topAnchor, constant: -12),
            qrTitleLabel.topAnchor.constraint(greaterThanOrEqualTo: qrOverlay.topAnchor, constant: 8),
            qrTitleLabel.leadingAnchor.constraint(equalTo: qrOverlay.leadingAnchor, constant: 20),
            qrTitleLabel.trailingAnchor.constraint(equalTo: qrOverlay.trailingAnchor, constant: -20),

            qrManualBtn.topAnchor.constraint(equalTo: qrBoxView.bottomAnchor, constant: 14),
            qrManualBtn.centerXAnchor.constraint(equalTo: qrOverlay.centerXAnchor),

            qrCancelBtn.topAnchor.constraint(equalTo: qrManualBtn.bottomAnchor, constant: 8),
            qrCancelBtn.bottomAnchor.constraint(lessThanOrEqualTo: qrOverlay.bottomAnchor, constant: -8),
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

        settingsScroll.alwaysBounceVertical = true
        settingsScroll.keyboardDismissMode = .interactive
        settingsScroll.translatesAutoresizingMaskIntoConstraints = false
        settingsCard.addSubview(settingsScroll)

        let title = UILabel()
        title.text = "360 Studio & Arm Settings"
        title.font = .systemFont(ofSize: 18, weight: .bold)
        title.textColor = .white

        let note = UILabel()
        note.text = "Motion auto-start pauses while Settings is open."
        note.font = .systemFont(ofSize: 12, weight: .regular)
        note.textColor = UIColor(white: 0.72, alpha: 1)

        modeSeg.selectedSegmentTintColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        modeSeg.setTitleTextAttributes([.foregroundColor: UIColor.white, .font: UIFont.systemFont(ofSize: 13, weight: .bold)], for: .selected)
        modeSeg.setTitleTextAttributes([.foregroundColor: UIColor(white: 0.85, alpha: 1), .font: UIFont.systemFont(ofSize: 13, weight: .semibold)], for: .normal)
        modeSeg.backgroundColor = UIColor(white: 1, alpha: 0.10)
        modeSeg.addTarget(self, action: #selector(didChangeOperatingMode), for: .valueChanged)

        // Standalone 360 Studio Controls
        standaloneSettingsStack.axis = .vertical
        standaloneSettingsStack.spacing = 10

        let stylePickerBtn: (UIButton) -> Void = { b in
            b.setTitleColor(.white, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
            b.backgroundColor = UIColor(white: 1, alpha: 0.12)
            b.layer.cornerRadius = 10
            b.contentEdgeInsets = UIEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
            b.contentHorizontalAlignment = .left
            b.showsMenuAsPrimaryAction = true
        }
        stylePickerBtn(motionMenuBtn)
        stylePickerBtn(lookMenuBtn)

        aspectSeg.selectedSegmentTintColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        aspectSeg.setTitleTextAttributes([.foregroundColor: UIColor.white, .font: UIFont.systemFont(ofSize: 12.5, weight: .bold)], for: .selected)
        aspectSeg.setTitleTextAttributes([.foregroundColor: UIColor(white: 0.85, alpha: 1), .font: UIFont.systemFont(ofSize: 12.5, weight: .semibold)], for: .normal)
        aspectSeg.backgroundColor = UIColor(white: 1, alpha: 0.10)
        aspectSeg.addTarget(self, action: #selector(didChangeAspect), for: .valueChanged)

        // Overlay PNG section
        overlayThumbView.contentMode = .scaleAspectFit
        overlayThumbView.backgroundColor = UIColor(white: 1, alpha: 0.08)
        overlayThumbView.layer.cornerRadius = 8
        overlayThumbView.clipsToBounds = true
        overlayThumbView.translatesAutoresizingMaskIntoConstraints = false
        overlayThumbView.widthAnchor.constraint(equalToConstant: 44).isActive = true
        overlayThumbView.heightAnchor.constraint(equalToConstant: 44).isActive = true

        overlayStatusLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        overlayStatusLabel.textColor = .white
        overlayStatusLabel.numberOfLines = 2

        let ovInfoRow = UIStackView(arrangedSubviews: [overlayThumbView, overlayStatusLabel])
        ovInfoRow.axis = .horizontal
        ovInfoRow.alignment = .center
        ovInfoRow.spacing = 10

        let ovPhotosBtn = makeSettingsMiniButton("Photos PNG", action: #selector(didTapPickOverlayPhotos))
        let ovFilesBtn = makeSettingsMiniButton("Files PNG", action: #selector(didTapPickOverlayFiles))
        let ovClearBtn = makeSettingsMiniButton("Clear", action: #selector(didTapClearOverlay))
        let ovBtnRow = UIStackView(arrangedSubviews: [ovPhotosBtn, ovFilesBtn, ovClearBtn])
        ovBtnRow.axis = .horizontal
        ovBtnRow.spacing = 6
        ovBtnRow.distribution = .fillEqually

        configureSettingsTextField(saTitleField, placeholder: "Overlay Title (optional, e.g. Anna & Mark)")
        configureSettingsTextField(saSubField, placeholder: "Subtitle / Date (optional)")

        musicStatusLabel.font = .systemFont(ofSize: 12.5, weight: .medium)
        musicStatusLabel.textColor = UIColor(white: 0.85, alpha: 1)
        let musPickBtn = makeSettingsMiniButton("🎵 Choose Music", action: #selector(didTapPickMusic))
        let musClearBtn = makeSettingsMiniButton("Clear", action: #selector(didTapClearMusic))
        let musRow = UIStackView(arrangedSubviews: [musPickBtn, musClearBtn])
        musRow.axis = .horizontal
        musRow.spacing = 6
        musRow.distribution = .fillProportionally

        let trigLabel = UILabel()
        trigLabel.text = "Spin Trigger & Duration"
        trigLabel.font = .systemFont(ofSize: 12.5, weight: .bold)
        trigLabel.textColor = UIColor(white: 0.82, alpha: 1)

        [saTriggerSeg, saStopSeg, saFpsSeg].forEach { seg in
            seg.selectedSegmentTintColor = UIColor(red: 0.12, green: 0.23, blue: 0.32, alpha: 1)
            seg.setTitleTextAttributes([.foregroundColor: UIColor.white, .font: UIFont.systemFont(ofSize: 12, weight: .bold)], for: .selected)
            seg.setTitleTextAttributes([.foregroundColor: UIColor(white: 0.82, alpha: 1), .font: UIFont.systemFont(ofSize: 12, weight: .semibold)], for: .normal)
            seg.backgroundColor = UIColor(white: 1, alpha: 0.10)
        }
        saTriggerSeg.addTarget(self, action: #selector(didChangeSaTrigger), for: .valueChanged)
        saStopSeg.addTarget(self, action: #selector(didChangeSaStopMode), for: .valueChanged)
        saFpsSeg.addTarget(self, action: #selector(didChangeSaFps), for: .valueChanged)

        let skipLbl = UILabel()
        skipLbl.text = "Send straight to Sharing Station (skip phone QR)"
        skipLbl.font = .systemFont(ofSize: 12.5, weight: .medium)
        skipLbl.textColor = .white
        skipLbl.numberOfLines = 2
        skipShareSwitch.addTarget(self, action: #selector(didToggleSkipShare), for: .valueChanged)
        let skipRow = UIStackView(arrangedSubviews: [skipLbl, skipShareSwitch])
        skipRow.axis = .horizontal
        skipRow.alignment = .center
        skipRow.spacing = 8

        [motionMenuBtn, aspectSeg, lookMenuBtn, ovInfoRow, ovBtnRow, saTitleField, saSubField, musicStatusLabel, musRow, trigLabel, saTriggerSeg, saStopSeg, saFpsSeg, skipRow].forEach {
            standaloneSettingsStack.addArrangedSubview($0)
        }

        // Motion sensitivity controls (both modes)
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

        // Laptop Desk controls
        deskSettingsStack.axis = .vertical
        deskSettingsStack.spacing = 10

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

        [deskCfgSummaryLabel, urlBtn, settingsPendingBtn].forEach { deskSettingsStack.addArrangedSubview($0) }

        let doneBtn = UIButton(type: .system)
        doneBtn.setTitle("Done", for: .normal)
        doneBtn.setTitleColor(.white, for: .normal)
        doneBtn.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
        doneBtn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        doneBtn.layer.cornerRadius = 12
        doneBtn.contentEdgeInsets = UIEdgeInsets(top: 11, left: 14, bottom: 11, right: 14)
        doneBtn.addTarget(self, action: #selector(didTapCloseSettings), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [
            title, note, modeSeg, standaloneSettingsStack,
            threshReadoutLabel, threshSlider, liveGyroSettingsLabel,
            calInSettingsBtn, saveRow, deskSettingsStack, doneBtn
        ])
        stack.axis = .vertical
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        settingsScroll.addSubview(stack)

        NSLayoutConstraint.activate([
            settingsOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            settingsOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            settingsOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            settingsOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            settingsCard.centerXAnchor.constraint(equalTo: settingsOverlay.centerXAnchor),
            settingsCard.centerYAnchor.constraint(equalTo: settingsOverlay.centerYAnchor),
            settingsCard.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            settingsCard.leadingAnchor.constraint(greaterThanOrEqualTo: settingsOverlay.leadingAnchor, constant: 14),
            settingsCard.trailingAnchor.constraint(lessThanOrEqualTo: settingsOverlay.trailingAnchor, constant: -14),
            settingsCard.heightAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.heightAnchor, multiplier: 0.86),

            settingsScroll.topAnchor.constraint(equalTo: settingsCard.topAnchor),
            settingsScroll.bottomAnchor.constraint(equalTo: settingsCard.bottomAnchor),
            settingsScroll.leadingAnchor.constraint(equalTo: settingsCard.leadingAnchor),
            settingsScroll.trailingAnchor.constraint(equalTo: settingsCard.trailingAnchor),

            stack.topAnchor.constraint(equalTo: settingsScroll.contentLayoutGuide.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: settingsScroll.contentLayoutGuide.bottomAnchor, constant: -18),
            stack.leadingAnchor.constraint(equalTo: settingsScroll.contentLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: settingsScroll.contentLayoutGuide.trailingAnchor, constant: -16),
            stack.widthAnchor.constraint(equalTo: settingsScroll.frameLayoutGuide.widthAnchor, constant: -32)
        ])
    }

    private func makeSettingsMiniButton(_ label: String, action sel: Selector) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(label, for: .normal)
        b.setTitleColor(.white, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 12.5, weight: .bold)
        b.backgroundColor = UIColor(white: 1, alpha: 0.14)
        b.layer.cornerRadius = 9
        b.contentEdgeInsets = UIEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
        b.addTarget(self, action: sel, for: .touchUpInside)
        return b
    }

    private func configureSettingsTextField(_ tf: UITextField, placeholder ph: String) {
        tf.attributedPlaceholder = NSAttributedString(string: ph, attributes: [.foregroundColor: UIColor(white: 0.55, alpha: 1)])
        tf.textColor = .white
        tf.font = .systemFont(ofSize: 13.5, weight: .medium)
        tf.backgroundColor = UIColor(white: 1, alpha: 0.08)
        tf.layer.cornerRadius = 9
        tf.layer.borderWidth = 1
        tf.layer.borderColor = UIColor(white: 1, alpha: 0.14).cgColor
        tf.returnKeyType = .done
        tf.delegate = self
        tf.addTarget(self, action: #selector(commitTextFields), for: .editingDidEnd)
        tf.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
        tf.leftViewMode = .always
        tf.heightAnchor.constraint(equalToConstant: 38).isActive = true
    }

    private func buildStationOverlay() {
        stationOverlay.backgroundColor = UIColor(white: 0, alpha: 0.72)
        stationOverlay.isHidden = true
        stationOverlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stationOverlay)

        let card = UIView()
        card.backgroundColor = UIColor(red: 0.11, green: 0.10, blue: 0.12, alpha: 1)
        card.layer.cornerRadius = 20
        card.layer.borderWidth = 1
        card.layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
        card.translatesAutoresizingMaskIntoConstraints = false
        stationOverlay.addSubview(card)

        let title = UILabel()
        title.text = "📱 Sharing Station"
        title.font = .systemFont(ofSize: 20, weight: .heavy)
        title.textColor = .white
        title.textAlignment = .center

        let sub = UILabel()
        sub.text = "Connect an iPad, second iPhone, or laptop to the same Wi-Fi/Hotspot and scan this QR code to auto-display finished 360 videos."
        sub.font = .systemFont(ofSize: 13, weight: .medium)
        sub.textColor = UIColor(white: 0.78, alpha: 1)
        sub.textAlignment = .center
        sub.numberOfLines = 0

        let qrBg = UIView()
        qrBg.backgroundColor = .white
        qrBg.layer.cornerRadius = 16
        stationQrView.contentMode = .scaleAspectFit
        stationQrView.translatesAutoresizingMaskIntoConstraints = false
        qrBg.addSubview(stationQrView)
        NSLayoutConstraint.activate([
            stationQrView.topAnchor.constraint(equalTo: qrBg.topAnchor, constant: 10),
            stationQrView.bottomAnchor.constraint(equalTo: qrBg.bottomAnchor, constant: -10),
            stationQrView.leadingAnchor.constraint(equalTo: qrBg.leadingAnchor, constant: 10),
            stationQrView.trailingAnchor.constraint(equalTo: qrBg.trailingAnchor, constant: -10),
            stationQrView.widthAnchor.constraint(equalToConstant: 170),
            stationQrView.heightAnchor.constraint(equalToConstant: 170)
        ])

        stationUrlLabel.font = .monospacedSystemFont(ofSize: 12.5, weight: .semibold)
        stationUrlLabel.textColor = UIColor(red: 0.35, green: 0.78, blue: 0.98, alpha: 1)
        stationUrlLabel.textAlignment = .center
        stationUrlLabel.numberOfLines = 0

        let openBtn = UIButton(type: .system)
        openBtn.setTitle("Open in Safari", for: .normal)
        openBtn.setTitleColor(.white, for: .normal)
        openBtn.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        openBtn.backgroundColor = UIColor(red: 0.12, green: 0.23, blue: 0.32, alpha: 1)
        openBtn.layer.cornerRadius = 11
        openBtn.contentEdgeInsets = UIEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
        openBtn.addTarget(self, action: #selector(didTapOpenStationSafari), for: .touchUpInside)

        let copyBtn = UIButton(type: .system)
        copyBtn.setTitle("Copy URL", for: .normal)
        copyBtn.setTitleColor(.white, for: .normal)
        copyBtn.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        copyBtn.backgroundColor = UIColor(white: 1, alpha: 0.16)
        copyBtn.layer.cornerRadius = 11
        copyBtn.contentEdgeInsets = UIEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
        copyBtn.addTarget(self, action: #selector(didTapCopyStationUrl), for: .touchUpInside)

        let btnRow = UIStackView(arrangedSubviews: [openBtn, copyBtn])
        btnRow.axis = .horizontal
        btnRow.spacing = 8
        btnRow.distribution = .fillEqually

        let closeStBtn = UIButton(type: .system)
        closeStBtn.setTitle("Close", for: .normal)
        closeStBtn.setTitleColor(.white, for: .normal)
        closeStBtn.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
        closeStBtn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
        closeStBtn.layer.cornerRadius = 12
        closeStBtn.contentEdgeInsets = UIEdgeInsets(top: 11, left: 14, bottom: 11, right: 14)
        closeStBtn.addTarget(self, action: #selector(didTapCloseStationModal), for: .touchUpInside)

        let stStack = UIStackView(arrangedSubviews: [title, sub, qrBg, stationUrlLabel, btnRow, closeStBtn])
        stStack.axis = .vertical
        stStack.alignment = .center
        stStack.spacing = 12
        stStack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stStack)

        btnRow.widthAnchor.constraint(equalTo: stStack.widthAnchor).isActive = true
        closeStBtn.widthAnchor.constraint(equalTo: stStack.widthAnchor).isActive = true

        NSLayoutConstraint.activate([
            stationOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            stationOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stationOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stationOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            card.centerXAnchor.constraint(equalTo: stationOverlay.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: stationOverlay.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 370),
            card.leadingAnchor.constraint(greaterThanOrEqualTo: stationOverlay.leadingAnchor, constant: 18),
            card.trailingAnchor.constraint(lessThanOrEqualTo: stationOverlay.trailingAnchor, constant: -18),

            stStack.topAnchor.constraint(equalTo: card.topAnchor, constant: 18),
            stStack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -18),
            stStack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            stStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -18)
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
        qrCancelBtn.isHidden = !isStandaloneMode && sendUrl.isEmpty
        refreshLiveOverlayPreview()
        updateUIState()
    }

    private func updateAeAfButtonUI() {
        aeLockBtn.setTitle(aeAfLocked ? "🔒 AE/AF" : "🔓 AE", for: .normal)
        aeLockBtn.backgroundColor = aeAfLocked
            ? UIColor(red: 0.72, green: 0.45, blue: 0.08, alpha: 0.9)
            : UIColor(white: 1, alpha: 0.14)
    }

    private func updateConnPill() {
        if isStandaloneMode {
            connPill.text = " 📱 Standalone 360 "
            connPill.backgroundColor = UIColor(red: 0.18, green: 0.65, blue: 0.42, alpha: 0.9)
            return
        }
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
        if isStandaloneMode {
            pendingBtn.isHidden = true
            settingsPendingBtn.isHidden = true
            return
        }
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
        let countLbl = isStandaloneMode ? "Clips" : "Sent"
        meterValueLabel.text = String(format: "%.0f°/s  ·  Trigger: %.0f°/s  ·  %@: %d", smoothedDps, startThresholdDps, countLbl, sentCount)
    }

    private func updateUIState() {
        updateConnPill()
        updatePendingUI()
        updateMeterLayout()
        updateMeterUI()

        lookQuickBtn.isHidden = !isStandaloneMode
        if isStandaloneMode {
            let aspTag = saAspect == .portrait9x16 ? "9:16" : (saAspect == .square1x1 ? "1:1" : "16:9")
            let ovTag = saOverlayImage != nil ? " · Overlay ✓" : ""
            lookQuickBtn.setTitle("🎨 \(saMotion.shortLabel) · \(aspTag)\(ovTag) · Edit", for: .normal)
            pairBtn.setTitle("📱 Station", for: .normal)
        } else {
            pairBtn.setTitle("📷 Pair QR", for: .normal)
        }

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
        case .rendering:
            centerOverlay.isHidden = false
            centerCancelBtn.isHidden = true
            centerProg.isHidden = false
            centerProg.progress = renderProgress
            centerIconLabel.text = "✨"
            centerTitleLabel.text = "Rendering \(Int((renderProgress * 100).rounded()))%"
            centerSubLabel.text = "Applying \(saMotion.shortLabel) & overlay…"
            stateBanner.text = "Rendering 360 video…"
            recBtn.setTitle("● Record", for: .normal)
            recBtn.backgroundColor = UIColor(red: 0.79, green: 0.24, blue: 0.15, alpha: 1)
            recBtn.isEnabled = false
            calBtn.isEnabled = false
            if isScreenLocked { lockStatusLabel.text = "RENDERING 360…" }
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
            } else if isStandaloneMode {
                stateBanner.text = armConfig.trigger == "arm"
                    ? "● Standalone Armed — spin arm to auto-record"
                    : "Standalone Ready — tap Record (or switch to Auto Spin)"
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
