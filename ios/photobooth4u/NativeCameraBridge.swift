import UIKit
import AVFoundation
import CoreImage
import ImageIO
import Metal
import QuartzCore

/**
 * photobooth4u — Native AVFoundation Camera Bridge (window.__PBCam)
 *
 * Replaces WKWebView's buffered getUserMedia() pipeline on iPad/iPhone with a direct
 * AVCaptureSession:
 *   - Preview renders directly on AVCaptureVideoPreviewLayer behind a transparent WKWebView
 *     (near-zero live preview latency, or GPU Metal/CoreImage when a live filter is active).
 *   - Stills capture via AVCapturePhotoOutput (with instant CVPixelBuffer fallback for UVC/HDMI
 *     capture cards that do not support photo output) and are served as raw JPEG bytes over
 *     http://localhost:17321/avcam/shot/<id> with zero base64 IPC overhead.
 *   - Latest video frame is also available on demand at /avcam/frame for GIFs, Flipbooks,
 *     Green Screen, and Hands-free Smile/Wave detection.
 */
final class NativeCameraBridge: NSObject, AVCapturePhotoCaptureDelegate, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {

    static let shared = NativeCameraBridge()
    static let srgbColorSpace = CGColorSpaceCreateDeviceRGB()
    // 3.5 GiB threshold: catches 2 GB / 3 GB iPads (iPad 7th/8th/9th gen) without affecting 4 GB+ models.
    static let isLowRamDevice: Bool = ProcessInfo.processInfo.physicalMemory <= 3_758_096_384

    static func orientImage(_ ci: CIImage, rotationAngle: CGFloat) -> CIImage {
        let deg = ((Int(rotationAngle.rounded()) % 360) + 360) % 360
        switch deg {
        case 90:  return ci.oriented(.right)
        case 180: return ci.oriented(.down)
        case 270: return ci.oriented(.left)
        default:  return ci
        }
    }

    final class MetalFilterView: UIView {
        override class var layerClass: AnyClass { return CAMetalLayer.self }
        var metalLayer: CAMetalLayer { return layer as! CAMetalLayer }
    }

    final class PreviewHostView: UIView {
        let previewLayer = AVCaptureVideoPreviewLayer()

        let filterView: MetalFilterView?
        private let metalLayer: CAMetalLayer?
        private let ciContext: CIContext?
        private let cmdQueue: MTLCommandQueue?
        private let filterRenderQueue = DispatchQueue(label: "com.photobooth4u.avcam.filter", qos: .userInteractive)
        private let filterChain = NativeCameraBridge.LiveFilterChain()
        private let renderLock = NSLock()
        private var isRenderingFilter = false
        private var isBackgrounded = false
        private var cachedVisible = false
        private var cachedWantsFilter = false
        private var cachedDrawableSize: CGSize = .zero
        private var filterOverlayShown = false
        var wantsFilterOverlay: Bool = false

        override init(frame: CGRect) {
            if let dev = MTLCreateSystemDefaultDevice() {
                let mv = MetalFilterView(frame: frame)
                mv.contentScaleFactor = 1.0
                mv.isHidden = true
                mv.isOpaque = true
                mv.backgroundColor = .clear
                let ml = mv.metalLayer
                ml.device = dev
                ml.pixelFormat = .bgra8Unorm
                ml.framebufferOnly = false
                ml.presentsWithTransaction = false
                ml.contentsScale = 1.0
                ml.isOpaque = true
                self.filterView = mv
                self.metalLayer = ml
                self.ciContext = CIContext(mtlDevice: dev, options: [.useSoftwareRenderer: false, .cacheIntermediates: false])
                self.cmdQueue = dev.makeCommandQueue()
            } else {
                self.filterView = nil
                self.metalLayer = nil
                self.ciContext = nil
                self.cmdQueue = nil
            }
            super.init(frame: frame)
            isUserInteractionEnabled = false
            backgroundColor = .black
            clipsToBounds = true
            previewLayer.videoGravity = .resizeAspectFill
            previewLayer.frame = bounds
            layer.insertSublayer(previewLayer, at: 0)
            if let fv = filterView {
                fv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                addSubview(fv)
            }
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        func syncRenderState(visible: Bool, wantsFilter: Bool, bounds: CGRect) {
            let tw = max(0, bounds.width.rounded())
            let th = max(0, bounds.height.rounded())
            if let ml = metalLayer, tw > 1 && th > 1 {
                if ml.contentsScale != 1.0 {
                    ml.contentsScale = 1.0
                }
                let newSize = CGSize(width: tw, height: th)
                if ml.drawableSize != newSize {
                    ml.drawableSize = newSize
                }
            }
            renderLock.lock()
            cachedVisible = visible
            cachedWantsFilter = wantsFilter
            cachedDrawableSize = CGSize(width: tw, height: th)
            if !visible || !wantsFilter {
                filterOverlayShown = false
            }
            renderLock.unlock()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            previewLayer.bounds = bounds
            previewLayer.position = CGPoint(x: bounds.midX, y: bounds.midY)
            if let fv = filterView {
                fv.frame = bounds
            }
            CATransaction.commit()
            syncRenderState(visible: !isHidden, wantsFilter: wantsFilterOverlay, bounds: bounds)
        }

        func setBackgrounded(_ bg: Bool) {
            renderLock.lock()
            isBackgrounded = bg
            renderLock.unlock()
        }

        func clearCaches() {
            filterRenderQueue.async { [weak self] in
                self?.ciContext?.clearCaches()
            }
        }

        func setCustomLut(id: String, dimension: Int, cubeData: Data?) {
            filterChain.setCustomLut(id: id, dimension: dimension, cubeData: cubeData)
        }

        func renderFiltered(pixelBuffer: CVPixelBuffer, rotationAngle: CGFloat, mirrored: Bool, filter: String, softSkin: Bool) {
            guard let ml = metalLayer, let ctx = ciContext, let cq = cmdQueue else { return }
            renderLock.lock()
            if isBackgrounded || isRenderingFilter || !cachedVisible || !cachedWantsFilter || cachedDrawableSize.width < 2 || cachedDrawableSize.height < 2 {
                renderLock.unlock()
                return
            }
            isRenderingFilter = true
            renderLock.unlock()

            filterRenderQueue.async { [weak self] in
                guard let self = self else { return }
                var committed = false
                defer {
                    if !committed {
                        self.renderLock.lock()
                        self.isRenderingFilter = false
                        self.renderLock.unlock()
                    }
                }

                self.renderLock.lock()
                let stillActive = !self.isBackgrounded && self.cachedVisible && self.cachedWantsFilter
                self.renderLock.unlock()
                guard stillActive else { return }

                autoreleasepool {
                    guard let drawable = ml.nextDrawable(), let cmdBuf = cq.makeCommandBuffer() else { return }
                    let texW = CGFloat(drawable.texture.width)
                    let texH = CGFloat(drawable.texture.height)
                    guard texW > 1, texH > 1 else { return }
                    let targetBounds = CGRect(x: 0, y: 0, width: texW, height: texH)

                    // Orient unrotated sensor frame on GPU, crop/scale to display points first, then run filter shaders
                    var img = NativeCameraBridge.orientImage(CIImage(cvPixelBuffer: pixelBuffer), rotationAngle: rotationAngle)
                    let scale = max(targetBounds.width / max(1, img.extent.width), targetBounds.height / max(1, img.extent.height))
                    img = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                    let dx = (targetBounds.width - img.extent.width) / 2.0 - img.extent.origin.x
                    let dy = (targetBounds.height - img.extent.height) / 2.0 - img.extent.origin.y
                    img = img.transformed(by: CGAffineTransform(translationX: dx, y: dy)).cropped(to: targetBounds)

                    if mirrored {
                        img = img.oriented(.upMirrored)
                    }
                    img = self.filterChain.apply(to: img, filter: filter, softSkin: softSkin)

                    ctx.render(img, to: drawable.texture, commandBuffer: cmdBuf, bounds: targetBounds, colorSpace: NativeCameraBridge.srgbColorSpace)
                    self.renderLock.lock()
                    let canCommit = !self.isBackgrounded && self.cachedVisible && self.cachedWantsFilter
                    self.renderLock.unlock()
                    guard canCommit else { return }
                    cmdBuf.present(drawable)
                    cmdBuf.addCompletedHandler { [weak self] _ in
                        guard let self = self else { return }
                        self.renderLock.lock()
                        self.isRenderingFilter = false
                        self.renderLock.unlock()
                    }
                    cmdBuf.commit()
                    committed = true

                    var needsShow = false
                    self.renderLock.lock()
                    if self.cachedVisible && self.cachedWantsFilter && !self.filterOverlayShown {
                        self.filterOverlayShown = true
                        needsShow = true
                    }
                    self.renderLock.unlock()
                    if needsShow {
                        DispatchQueue.main.async { [weak self] in
                            guard let self = self, self.wantsFilterOverlay, !self.isHidden else { return }
                            self.filterView?.isHidden = false
                        }
                    }
                }
            }
        }
    }

    let previewView = PreviewHostView(frame: .zero)
    weak var hostContainerView: UIView?
    var onDeviceEvent: ((String, String, String, Bool) -> Void)?

    private let session = AVCaptureSession()
    private var discoverySession: AVCaptureDevice.DiscoverySession?
    private let sessionQueue = DispatchQueue(label: "com.photobooth4u.avcam.session", qos: .userInitiated)
    private let videoOutputQueue = DispatchQueue(label: "com.photobooth4u.avcam.video", qos: .userInitiated)
    private let audioOutputQueue = DispatchQueue(label: "com.photobooth4u.avcam.audio", qos: .userInitiated)

    private var currentInput: AVCaptureDeviceInput?
    private var currentDevice: AVCaptureDevice?
    private var photoOutput: AVCapturePhotoOutput?
    private var videoDataOutput: AVCaptureVideoDataOutput?
    private var audioInput: AVCaptureDeviceInput?
    private var audioDataOutput: AVCaptureAudioDataOutput?
    private var wantsAudio = false
    private var sessionWantedRunning = false
    private var lastRequestedDeviceId: String?
    private var lastRequestedPreset: String = "auto"

    private var rotationObserverPreview: NSKeyValueObservation?
    private var rotationObserverCapture: NSKeyValueObservation?
    private var rotationCoordinatorObj: AnyObject?
    private var orientationObserver: NSObjectProtocol?
    private var sessionRuntimeObserver: NSObjectProtocol?
    private var sessionInterruptionEndedObserver: NSObjectProtocol?
    private var deviceConnectedObserver: NSObjectProtocol?
    private var deviceDisconnectedObserver: NSObjectProtocol?

    private let stateLock = NSLock()
    private var latestBuffer: CVPixelBuffer?
    private var latestMirrored = false
    private var activeFilter = "none"
    private var activeSoftSkin = false
    private var isFrontCamera = true
    private var isExternalCamera = false
    private var currentWidth = 0
    private var currentHeight = 0
    private var captureRotationAngle: CGFloat = 0
    private var currentInterfaceOrientation: UIInterfaceOrientation = .landscapeLeft
    private var lastLayoutSig: String = ""

    private let jpegEncodeLock = NSLock()

    private let recLock = NSLock()
    private var assetWriter: AVAssetWriter?
    private var writerVideoInput: AVAssetWriterInput?
    private var writerAdaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var writerAudioInput: AVAssetWriterInput?
    private var recFileURL: URL?
    private var recSessionStarted = false
    private var recFirstPts: CMTime = .invalid
    private var recLastVideoPts: CMTime = .invalid
    private var recWidth: Int = 0
    private var recHeight: Int = 0
    private var recMirror: Bool = false
    private var recFilter: String = "none"
    private var recSoftSkin: Bool = false
    private var isRecordingVideo: Bool = false

    private let shotsLock = NSLock()
    private var shotSeq = 0
    private var shotStore: [Int: Data] = [:]
    private var videoSeq = 0
    private var videoStore: [Int: URL] = [:]
    private var pendingPhotoCompletions: [Int64: (Result<(Data, Int, Int), Error>) -> Void] = [:]

    private let frameCiContext = CIContext(options: [.useSoftwareRenderer: false, .cacheIntermediates: false])
    private let recFilterChain = LiveFilterChain()

    private override init() {
        super.init()
        previewView.isHidden = true
        previewView.previewLayer.session = session
        var discoveryTypes: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .builtInUltraWideCamera]
        if #available(iOS 17.0, *) {
            discoveryTypes.append(.external)
        }
        // Keep a strong DiscoverySession alive so iPadOS delivers wasConnected/wasDisconnected for external USB-C cameras.
        discoverySession = AVCaptureDevice.DiscoverySession(deviceTypes: discoveryTypes, mediaType: .video, position: .unspecified)
        orientationObserver = NotificationCenter.default.addObserver(
            forName: UIDevice.orientationDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.syncLegacyOrientation()
        }
        sessionRuntimeObserver = NotificationCenter.default.addObserver(
            forName: .AVCaptureSessionRuntimeError,
            object: session,
            queue: nil
        ) { [weak self] note in
            guard let self = self else { return }
            let err = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
            self.sessionQueue.async {
                self.failAllPendingPhotos("Camera runtime interruption.")
                guard self.sessionWantedRunning else { return }
                if !self.session.isRunning, let dev = self.currentDevice, dev.isConnected {
                    self.session.startRunning()
                }
                if !self.session.isRunning && err?.code == AVError.mediaServicesWereReset.rawValue {
                    _ = try? self.configureAndStart(deviceId: self.lastRequestedDeviceId, presetName: self.lastRequestedPreset)
                }
            }
        }
        sessionInterruptionEndedObserver = NotificationCenter.default.addObserver(
            forName: .AVCaptureSessionInterruptionEnded,
            object: session,
            queue: nil
        ) { [weak self] _ in
            guard let self = self else { return }
            self.sessionQueue.async {
                guard self.sessionWantedRunning else { return }
                if !self.session.isRunning, let dev = self.currentDevice, dev.isConnected {
                    self.session.startRunning()
                }
                if !self.session.isRunning {
                    _ = try? self.configureAndStart(deviceId: self.lastRequestedDeviceId, presetName: self.lastRequestedPreset)
                }
            }
        }
        deviceConnectedObserver = NotificationCenter.default.addObserver(
            forName: .AVCaptureDeviceWasConnected,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let self = self, let dev = note.object as? AVCaptureDevice, dev.hasMediaType(.video) else { return }
            var ext = false
            if #available(iOS 17.0, *) {
                ext = (dev.deviceType == .external)
            }
            let devId = dev.uniqueID
            let label = dev.localizedName
            DispatchQueue.main.async {
                self.onDeviceEvent?("connected", devId, label, ext)
            }
        }
        deviceDisconnectedObserver = NotificationCenter.default.addObserver(
            forName: .AVCaptureDeviceWasDisconnected,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let self = self, let lost = note.object as? AVCaptureDevice, lost.hasMediaType(.video) else { return }
            var ext = false
            if #available(iOS 17.0, *) {
                ext = (lost.deviceType == .external)
            }
            let devId = lost.uniqueID
            let label = lost.localizedName
            self.sessionQueue.async {
                if self.currentDevice?.uniqueID == devId {
                    self.sessionWantedRunning = false
                    self.failAllPendingPhotos("Camera disconnected.")
                    self.cancelActiveRecording()
                    if self.session.isRunning { self.session.stopRunning() }
                    self.stateLock.lock()
                    self.latestBuffer = nil
                    self.stateLock.unlock()
                }
                DispatchQueue.main.async {
                    self.onDeviceEvent?("disconnected", devId, label, ext)
                }
            }
        }
    }

    deinit {
        if let obs = orientationObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = sessionRuntimeObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = sessionInterruptionEndedObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = deviceConnectedObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = deviceDisconnectedObserver { NotificationCenter.default.removeObserver(obs) }
    }

    // MARK: - Device Discovery

    private func discoveredDevices() -> [AVCaptureDevice] {
        let raw: [AVCaptureDevice]
        if let ds = discoverySession {
            raw = ds.devices
        } else {
            var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .builtInUltraWideCamera]
            if #available(iOS 17.0, *) {
                types.append(.external)
            }
            raw = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified).devices
        }
        let hasFrontWide = raw.contains { $0.position == .front && $0.deviceType == .builtInWideAngleCamera }
        let hasBackWide = raw.contains { $0.position == .back && $0.deviceType == .builtInWideAngleCamera }
        var seen = Set<String>()
        return raw.filter { dev in
            guard !seen.contains(dev.uniqueID) else { return false }
            if dev.position == .front && dev.deviceType == .builtInUltraWideCamera && hasFrontWide { return false }
            if dev.position == .back && dev.deviceType == .builtInUltraWideCamera && hasBackWide { return false }
            seen.insert(dev.uniqueID)
            return true
        }
    }

    func listDevices() -> [[String: Any]] {
        return discoveredDevices().map { dev in
            var ext = false
            if #available(iOS 17.0, *) {
                ext = (dev.deviceType == .external)
            }
            let pos: String
            switch dev.position {
            case .front: pos = "front"
            case .back: pos = "back"
            default: pos = ext ? "external" : "unspecified"
            }
            return [
                "id": dev.uniqueID,
                "label": dev.localizedName,
                "position": pos,
                "isExternal": ext
            ]
        }
    }

    // MARK: - Open / Stop

    private func captureInterfaceOrientationSync() {
        let grab = { [weak self] in
            if let ws = self?.hostContainerView?.window?.windowScene {
                self?.currentInterfaceOrientation = ws.interfaceOrientation
            }
        }
        if Thread.isMainThread {
            grab()
        } else {
            DispatchQueue.main.sync(execute: grab)
        }
    }

    func open(deviceId: String?, presetName: String, completion: @escaping ([String: Any]) -> Void) {
        captureInterfaceOrientationSync()
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            let status = AVCaptureDevice.authorizationStatus(for: .video)
            if status == .denied || status == .restricted {
                DispatchQueue.main.async {
                    completion(["ok": false, "name": "NotAllowedError", "error": "Camera access is blocked in iPad Settings."])
                }
                return
            }

            let finishOpen = {
                do {
                    let info = try self.configureAndStart(deviceId: deviceId, presetName: presetName)
                    DispatchQueue.main.async { completion(info) }
                } catch {
                    DispatchQueue.main.async {
                        completion(["ok": false, "name": "NotReadableError", "error": error.localizedDescription])
                    }
                }
            }

            if status == .notDetermined {
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    if granted {
                        self.sessionQueue.async { finishOpen() }
                    } else {
                        DispatchQueue.main.async {
                            completion(["ok": false, "name": "NotAllowedError", "error": "Camera permission denied."])
                        }
                    }
                }
            } else {
                finishOpen()
            }
        }
    }

    func setBackgrounded(_ bg: Bool) {
        previewView.setBackgrounded(bg)
        if !bg {
            sessionQueue.async { [weak self] in
                guard let self = self, self.sessionWantedRunning else { return }
                if !self.session.isRunning, let dev = self.currentDevice, dev.isConnected {
                    self.session.startRunning()
                }
                if !self.session.isRunning {
                    _ = try? self.configureAndStart(deviceId: self.lastRequestedDeviceId, presetName: self.lastRequestedPreset)
                }
            }
        }
    }

    func clearMemoryCaches() {
        previewView.clearCaches()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            self.jpegEncodeLock.lock()
            self.frameCiContext.clearCaches()
            self.jpegEncodeLock.unlock()
            self.shotsLock.lock()
            self.shotStore.removeAll()
            self.shotsLock.unlock()
        }
    }

    func resetForPageReload() {
        stateLock.lock()
        activeFilter = "none"
        activeSoftSkin = false
        stateLock.unlock()
        stop(completion: nil)
    }

    private func failAllPendingPhotos(_ message: String) {
        shotsLock.lock()
        let pending = Array(pendingPhotoCompletions.values)
        pendingPhotoCompletions.removeAll()
        shotsLock.unlock()
        guard !pending.isEmpty else { return }
        let err = NSError(domain: "NativeCameraBridge", code: 503, userInfo: [NSLocalizedDescriptionKey: message])
        for cb in pending {
            cb(.failure(err))
        }
    }

    func stop(completion: (() -> Void)? = nil) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.lastLayoutSig = ""
            self.previewView.wantsFilterOverlay = false
            self.previewView.filterView?.isHidden = true
            self.previewView.isHidden = true
            self.previewView.syncRenderState(visible: false, wantsFilter: false, bounds: self.previewView.bounds)
        }
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            self.sessionWantedRunning = false
            self.failAllPendingPhotos("Camera stopped.")
            self.cancelActiveRecording()
            self.wantsAudio = false
            self.clearRotationObservers()
            if self.session.isRunning {
                self.session.stopRunning()
            }
            if self.audioInput != nil || self.audioDataOutput != nil {
                self.session.beginConfiguration()
                if let aIn = self.audioInput { self.session.removeInput(aIn) }
                if let aOut = self.audioDataOutput { self.session.removeOutput(aOut) }
                self.audioInput = nil
                self.audioDataOutput = nil
                self.session.commitConfiguration()
            }
            self.stateLock.lock()
            self.latestBuffer = nil
            self.currentWidth = 0
            self.currentHeight = 0
            self.captureRotationAngle = 0
            self.stateLock.unlock()
            self.clearMemoryCaches()
            if let done = completion {
                DispatchQueue.main.async { done() }
            }
        }
    }

    // MARK: - On-Demand Microphone (Video Guestbook)

    func prepareAudio(completion: @escaping ([String: Any]) -> Void) {
        let attachAndReply = {
            self.sessionQueue.async { [weak self] in
                guard let self = self else { return }
                self.wantsAudio = true
                let avs = AVAudioSession.sharedInstance()
                try? avs.setCategory(.playAndRecord, mode: .videoRecording, options: [.defaultToSpeaker, .allowBluetooth])
                try? avs.setActive(true)
                self.attachAudioIfNeeded(inConfigBlock: false)
                let hasAudio = (self.audioDataOutput != nil && self.audioInput != nil)
                DispatchQueue.main.async {
                    completion(["ok": true, "hasAudio": hasAudio])
                }
            }
        }

        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            attachAndReply()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                if granted {
                    attachAndReply()
                } else {
                    self.sessionQueue.async { self.wantsAudio = false }
                    DispatchQueue.main.async { completion(["ok": true, "hasAudio": false]) }
                }
            }
        default:
            sessionQueue.async { self.wantsAudio = false }
            DispatchQueue.main.async { completion(["ok": true, "hasAudio": false]) }
        }
    }

    func releaseAudio(completion: (() -> Void)? = nil) {
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            self.wantsAudio = false
            if self.audioInput != nil || self.audioDataOutput != nil {
                self.session.beginConfiguration()
                if let aIn = self.audioInput { self.session.removeInput(aIn) }
                if let aOut = self.audioDataOutput { self.session.removeOutput(aOut) }
                self.audioInput = nil
                self.audioDataOutput = nil
                self.session.commitConfiguration()
            }
            if let done = completion {
                DispatchQueue.main.async { done() }
            }
        }
    }

    private func attachAudioIfNeeded(inConfigBlock: Bool) {
        if let aIn = audioInput, let aOut = audioDataOutput,
           session.inputs.contains(aIn), session.outputs.contains(aOut) {
            return
        }
        guard let mic = AVCaptureDevice.default(for: .audio),
              let aIn = try? AVCaptureDeviceInput(device: mic) else {
            return
        }
        if !inConfigBlock { session.beginConfiguration() }
        defer { if !inConfigBlock { session.commitConfiguration() } }

        if let oldIn = audioInput {
            session.removeInput(oldIn)
            audioInput = nil
        }
        if let oldOut = audioDataOutput {
            session.removeOutput(oldOut)
            audioDataOutput = nil
        }
        if session.canAddInput(aIn) {
            session.addInput(aIn)
            audioInput = aIn
        }
        let aOut = AVCaptureAudioDataOutput()
        aOut.setSampleBufferDelegate(self, queue: audioOutputQueue)
        if session.canAddOutput(aOut) {
            session.addOutput(aOut)
            audioDataOutput = aOut
        }
    }

    private func pickDevice(deviceId: String?) -> AVCaptureDevice? {
        let devices = discoveredDevices()
        if let wanted = deviceId, !wanted.isEmpty, let match = devices.first(where: { $0.uniqueID == wanted }) {
            return match
        }
        if #available(iOS 17.0, *) {
            if let ext = devices.first(where: { $0.deviceType == .external }) {
                return ext
            }
        }
        return devices.first(where: { $0.position == .front }) ?? devices.first
    }

    private func maxStillWidth(for format: AVCaptureDevice.Format) -> Int {
        if #available(iOS 16.0, *) {
            return format.supportedMaxPhotoDimensions.map { Int($0.width) }.max() ?? 0
        } else {
            return Int(format.highResolutionStillImageDimensions.width)
        }
    }

    /// Selects a smooth 30 fps 8-bit 4:2:0 YUV 4:3 video-binned format on built-in iPads (e.g. 1440×1080 or 1280×960)
    /// that keeps full 4:3 FOV and high-res still photo capability (4032×3024 on iPad A16) without forcing the heavy
    /// .photo session preset or 10-bit HDR pipelines.
    private func pickSmoothBuiltInFormat(for dev: AVCaptureDevice, presetName: String) -> AVCaptureDevice.Format? {
        let lowRam = NativeCameraBridge.isLowRamDevice
        let targetW: Int
        let minW: Int
        let maxW: Int
        switch presetName {
        case "480":
            targetW = 640; minW = 480; maxW = 800
        case "720":
            targetW = 1280; minW = 960; maxW = 1344
        case "1080":
            targetW = lowRam ? 1280 : 1440; minW = lowRam ? 960 : 1280; maxW = lowRam ? 1440 : 1920
        case "max", "yuyv":
            targetW = lowRam ? 1440 : 1920; minW = 1280; maxW = lowRam ? 1920 : 2160
        default: // "auto", "high", "photo"
            targetW = lowRam ? 1280 : 1440; minW = 960; maxW = lowRam ? 1440 : 1920
        }

        var centerStageWanted = false
        if #available(iOS 14.5, *) {
            centerStageWanted = AVCaptureDevice.isCenterStageEnabled
        }

        var bestFormat: AVCaptureDevice.Format?
        var bestScore = Int.min

        for fmt in dev.formats {
            let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
            let w = Int(dims.width)
            let h = Int(dims.height)
            guard w >= minW && w <= maxW && h >= 360 else { continue }

            // Strictly pick 8-bit 4:2:0 YUV formats (skip 10-bit HDR x420 which adds tone-mapping overhead)
            let sub = CMFormatDescriptionGetMediaSubType(fmt.formatDescription)
            let is420f = (sub == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
            let is420v = (sub == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            guard is420f || is420v else { continue }

            let supports30 = fmt.videoSupportedFrameRateRanges.contains {
                $0.minFrameRate <= 30.01 && $0.maxFrameRate >= 29.9
            }
            guard supports30 else { continue }

            let aspect = Double(w) / Double(h)
            let is4by3 = abs(aspect - (4.0 / 3.0)) < 0.06
            let stillW = maxStillWidth(for: fmt)

            var score = 0
            if is4by3 { score += 10_000 }
            if stillW >= 2400 { score += 5_000 }
            else if stillW >= 1920 { score += 2_500 }
            if #available(iOS 14.5, *), centerStageWanted && fmt.isCenterStageSupported {
                score += 2_000
            }
            if fmt.isVideoBinned { score += 600 }
            if is420f { score += 200 }
            if !fmt.isVideoHDRSupported { score += 150 }
            score -= abs(w - targetW)

            if score > bestScore {
                bestScore = score
                bestFormat = fmt
            }
        }
        return bestFormat
    }

    /// Picks a clean, high-frame-rate (24/25/30/60 fps) format for external USB-C UVC cameras (such as DJI Osmo Pocket 3
    /// or HDMI capture cards). Defaults to 1080p on "auto" so UVC still captures print sharp without 4K overheating, and
    /// supports both landscape (1920x1080) and native portrait (1080x1920) UVC descriptors.
    private func pickExternalFormat(for dev: AVCaptureDevice, presetName: String) -> AVCaptureDevice.Format? {
        let targetLong: Int
        let minLong: Int
        let maxLong: Int
        switch presetName {
        case "480":
            targetLong = 640; minLong = 480; maxLong = 854
        case "720":
            targetLong = 1280; minLong = 960; maxLong = 1344
        case "max", "yuyv":
            targetLong = 3840; minLong = 1280; maxLong = 4096
        default: // "auto", "1080", "high", "photo"
            targetLong = 1920; minLong = 1280; maxLong = 1920
        }

        let wantUncompressed = (presetName == "yuyv")
        var bestFormat: AVCaptureDevice.Format?
        var bestScore = Int.min

        for fmt in dev.formats {
            let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
            let w = Int(dims.width)
            let h = Int(dims.height)
            let longSide = max(w, h)
            let shortSide = min(w, h)
            guard longSide >= minLong && longSide <= maxLong && shortSide >= 360 else { continue }

            let maxFps = fmt.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
            guard maxFps >= 14.9 else { continue }

            let sub = CMFormatDescriptionGetMediaSubType(fmt.formatDescription)
            let is420 = (sub == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange || sub == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            let is422 = (sub == kCVPixelFormatType_422YpCbCr8 || sub == kCVPixelFormatType_422YpCbCr8_yuvs)
            let isMjpeg = (sub == kCMVideoCodecType_JPEG_OpenDML)
            let is10Bit = (sub == kCVPixelFormatType_420YpCbCr10BiPlanarFullRange || sub == kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange)

            var score = 0
            if maxFps >= 29.5 { score += 4_000 }
            else if maxFps >= 23.9 { score += 3_500 } // covers 24/25 fps PAL modes
            else { score += 500 }

            if wantUncompressed {
                if is422 || is420 { score += 2_000 }
                else if isMjpeg { score += 500 }
            } else {
                if is420 { score += 1_200 }
                else if is422 { score += 1_000 }
                else if isMjpeg { score += 900 }
                else if is10Bit { score -= 1_000 }
            }

            if !fmt.isVideoHDRSupported { score += 150 }
            score -= abs(longSide - targetLong)

            if score > bestScore {
                bestScore = score
                bestFormat = fmt
            }
        }
        return bestFormat
    }

    private func configureAndStart(deviceId: String?, presetName: String) throws -> [String: Any] {
        guard let dev = pickDevice(deviceId: deviceId) else {
            throw NSError(domain: "NativeCameraBridge", code: 404, userInfo: [NSLocalizedDescriptionKey: "No built-in or external USB camera found."])
        }

        lastRequestedDeviceId = deviceId
        lastRequestedPreset = presetName
        failAllPendingPhotos("Camera reconfigured.")

        var ext = false
        if #available(iOS 17.0, *) {
            ext = (dev.deviceType == .external)
        }

        if session.isRunning {
            session.stopRunning()
        }
        clearRotationObservers()
        DispatchQueue.main.async { [weak self] in
            self?.lastLayoutSig = ""
        }

        session.beginConfiguration()
        var committed = false
        defer { if !committed { session.commitConfiguration() } }

        for inp in session.inputs { session.removeInput(inp) }
        for out in session.outputs { session.removeOutput(out) }
        audioInput = nil
        audioDataOutput = nil

        let input = try AVCaptureDeviceInput(device: dev)
        guard session.canAddInput(input) else {
            throw NSError(domain: "NativeCameraBridge", code: 500, userInfo: [NSLocalizedDescriptionKey: "Could not open camera input."])
        }
        session.addInput(input)
        currentInput = input
        currentDevice = dev

        let vOut = AVCaptureVideoDataOutput()
        vOut.alwaysDiscardsLateVideoFrames = true
        vOut.setSampleBufferDelegate(self, queue: videoOutputQueue)
        if session.canAddOutput(vOut) {
            session.addOutput(vOut)
            // Keep native 4:2:0 YUV pixel format (Apple TN3121) to eliminate costly per-frame YUV->32BGRA conversion.
            // CoreImage reads native 420f/420v directly on Metal GPU at 2.67x less memory bandwidth.
            let avail = vOut.availableVideoPixelFormatTypes
            if avail.contains(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) {
                vOut.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)]
            } else if avail.contains(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) {
                vOut.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)]
            } else {
                vOut.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)]
            }
            videoDataOutput = vOut
        } else {
            videoDataOutput = nil
        }

        // External UVC / HDMI capture cards grab still frames from the live CVPixelBuffer directly;
        // skip AVCapturePhotoOutput so capture cards never stall on unsupported still-photo paths.
        if !ext {
            let pOut = AVCapturePhotoOutput()
            if session.canAddOutput(pOut) {
                session.addOutput(pOut)
                photoOutput = pOut
            } else {
                photoOutput = nil
            }
        } else {
            photoOutput = nil
        }

        // Configure session preset / custom format AFTER all inputs and outputs are attached
        // so AVCaptureSession validates the format cleanly against every output.
        var usedCustomFormat = false
        if session.canSetSessionPreset(.inputPriority) {
            let chosen = ext
                ? pickExternalFormat(for: dev, presetName: presetName)
                : pickSmoothBuiltInFormat(for: dev, presetName: presetName)
            if let chosen = chosen {
                do {
                    session.sessionPreset = .inputPriority
                    try dev.lockForConfiguration()
                    defer { dev.unlockForConfiguration() }
                    dev.activeFormat = chosen
                    usedCustomFormat = true
                } catch {
                    usedCustomFormat = false
                }
            }
        }
        if !usedCustomFormat {
            let desiredPresets: [AVCaptureSession.Preset]
            switch presetName {
            case "480":
                desiredPresets = [.vga640x480, .hd1280x720, .high]
            case "720":
                desiredPresets = [.hd1280x720, .high]
            case "1080":
                desiredPresets = [.hd1920x1080, .hd1280x720, .high]
            case "max", "yuyv":
                desiredPresets = ext ? [.hd4K3840x2160, .hd1920x1080, .high] : [.high, .hd1920x1080, .photo]
            default: // "auto", "high", "photo"
                desiredPresets = ext ? [.hd1920x1080, .high, .hd1280x720] : [.high, .hd1280x720, .photo]
            }
            for p in desiredPresets where session.canSetSessionPreset(p) {
                session.sessionPreset = p
                break
            }
        }

        if let pOut = photoOutput {
            if #available(iOS 16.0, *) {
                let supported = dev.activeFormat.supportedMaxPhotoDimensions
                let atLeast2400 = supported.filter { max(Int($0.width), Int($0.height)) >= 2400 }
                let chosenDim = atLeast2400.min(by: { Int64($0.width) * Int64($0.height) < Int64($1.width) * Int64($1.height) })
                    ?? supported.max(by: { Int64($0.width) * Int64($0.height) < Int64($1.width) * Int64($1.height) })
                if let dim = chosenDim, dim.width > 0 && dim.height > 0 {
                    pOut.maxPhotoDimensions = dim
                }
            } else {
                pOut.isHighResolutionCaptureEnabled = true
            }
            if #available(iOS 13.0, *) {
                pOut.maxPhotoQualityPrioritization = .balanced
            }
        }

        if wantsAudio {
            attachAudioIfNeeded(inConfigBlock: true)
        }
        session.commitConfiguration()
        committed = true

        // Apply post-commit frame rate floor (24-30 fps) and focus/exposure on built-in lenses so indoor lighting
        // cannot drop the live preview into 15 fps slideshow mode or engage heavy multi-exposure video HDR.
        if !ext {
            do {
                try dev.lockForConfiguration()
                if dev.isLowLightBoostSupported {
                    dev.automaticallyEnablesLowLightBoostWhenAvailable = false
                }
                if dev.activeFormat.isVideoHDRSupported {
                    dev.automaticallyAdjustsVideoHDREnabled = false
                    if dev.isVideoHDREnabled {
                        dev.isVideoHDREnabled = false
                    }
                }
                if let range = dev.activeFormat.videoSupportedFrameRateRanges.first(where: { $0.maxFrameRate >= 29.9 }) {
                    var minDur = CMTime(value: 1, timescale: 30)
                    var maxDur = CMTime(value: 1, timescale: 24)
                    if CMTimeCompare(minDur, range.minFrameDuration) < 0 { minDur = range.minFrameDuration }
                    if CMTimeCompare(maxDur, range.maxFrameDuration) > 0 { maxDur = range.maxFrameDuration }
                    if #available(iOS 14.5, *), dev.activeFormat.isCenterStageSupported,
                       let csRange = dev.activeFormat.videoFrameRateRangeForCenterStage {
                        if CMTimeCompare(minDur, csRange.minFrameDuration) < 0 { minDur = csRange.minFrameDuration }
                        if CMTimeCompare(maxDur, csRange.maxFrameDuration) > 0 { maxDur = csRange.maxFrameDuration }
                    }
                    if CMTimeCompare(minDur, maxDur) > 0 { maxDur = minDur }
                    dev.activeVideoMinFrameDuration = minDur
                    dev.activeVideoMaxFrameDuration = maxDur
                }
                if dev.isFocusModeSupported(.continuousAutoFocus) {
                    dev.focusMode = .continuousAutoFocus
                }
                if dev.isExposureModeSupported(.continuousAutoExposure) {
                    dev.exposureMode = .continuousAutoExposure
                }
                if dev.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                    dev.whiteBalanceMode = .continuousAutoWhiteBalance
                }
                dev.unlockForConfiguration()
            } catch { }
        }

        let dims = CMVideoFormatDescriptionGetDimensions(dev.activeFormat.formatDescription)
        let rawW = Int(dims.width)
        let rawH = Int(dims.height)
        let effective = effectivePreviewDimensions(rawW: rawW, rawH: rawH, isExternal: ext)

        stateLock.lock()
        isFrontCamera = (dev.position == .front)
        isExternalCamera = ext
        latestBuffer = nil
        captureRotationAngle = 0
        currentWidth = effective.w
        currentHeight = effective.h
        stateLock.unlock()

        sessionWantedRunning = true
        session.startRunning()

        // Configure rotation coordinator only after session connections exist and state is initialized.
        setupRotation(for: dev)

        return [
            "ok": true,
            "id": dev.uniqueID,
            "label": dev.localizedName,
            "width": effective.w,
            "height": effective.h,
            "isFront": (dev.position == .front),
            "isExternal": ext
        ]
    }

    private func effectivePreviewDimensions(rawW: Int, rawH: Int, isExternal: Bool) -> (w: Int, h: Int) {
        if isExternal {
            // External USB-C UVC cameras report captureRotationAngle = 0 regardless of iPad orientation;
            // keep their true sensor orientation instead of swapping width/height on a portrait iPad.
            if rawW > 0 && rawH > 0 { return (rawW, rawH) }
            return (1920, 1080)
        }
        let a = max(rawW, rawH)
        let b = min(rawW, rawH)
        if a == 0 || b == 0 { return (1280, 720) }
        let portrait = currentInterfaceOrientation.isPortrait
        return portrait ? (b, a) : (a, b)
    }

    // MARK: - Orientation / Rotation

    private func applyPreviewMirror(_ mirror: Bool) {
        if let conn = previewView.previewLayer.connection, conn.isVideoMirroringSupported {
            if conn.automaticallyAdjustsVideoMirroring {
                conn.automaticallyAdjustsVideoMirroring = false
            }
            if conn.isVideoMirrored != mirror {
                conn.isVideoMirrored = mirror
            }
            if !previewView.previewLayer.affineTransform().isIdentity {
                previewView.previewLayer.setAffineTransform(.identity)
            }
        } else {
            let target = mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity
            if previewView.previewLayer.affineTransform() != target {
                previewView.previewLayer.setAffineTransform(target)
            }
        }
    }

    private func clearRotationObservers() {
        rotationObserverPreview?.invalidate()
        rotationObserverPreview = nil
        rotationObserverCapture?.invalidate()
        rotationObserverCapture = nil
        rotationCoordinatorObj = nil
    }

    @available(iOS 17.0, *)
    private func applyPreviewRotationAngle(_ angle: CGFloat) {
        if let conn = previewView.previewLayer.connection {
            if conn.isVideoRotationAngleSupported(angle),
               abs(conn.videoRotationAngle - angle) > 0.01 {
                conn.videoRotationAngle = angle
            }
        }
        stateLock.lock()
        let mir = latestMirrored
        stateLock.unlock()
        applyPreviewMirror(mir)
    }

    @available(iOS 17.0, *)
    private func applyCaptureRotationAngle(_ angle: CGFloat) {
        stateLock.lock()
        captureRotationAngle = angle
        if let pb = latestBuffer {
            let rw = CVPixelBufferGetWidth(pb)
            let rh = CVPixelBufferGetHeight(pb)
            let deg = ((Int(angle.rounded()) % 360) + 360) % 360
            let swap = (deg == 90 || deg == 270)
            if rw > 0 && rh > 0 {
                currentWidth = swap ? rh : rw
                currentHeight = swap ? rw : rh
            }
        }
        stateLock.unlock()

        // Only rotate photoOutput connection (fires once per shot). Keep videoDataOutput unrotated at sensor
        // native orientation to eliminate costly per-frame physical buffer rotation on portrait iPads;
        // CoreImage orients individual frames on GPU only when actually rendered/encoded.
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            if let pConn = self.photoOutput?.connection(with: .video),
               pConn.isVideoRotationAngleSupported(angle),
               abs(pConn.videoRotationAngle - angle) > 0.01 {
                pConn.videoRotationAngle = angle
            }
        }
    }

    private func setupRotation(for dev: AVCaptureDevice) {
        if #available(iOS 17.0, *) {
            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.currentDevice?.uniqueID == dev.uniqueID else { return }
                self.clearRotationObservers()
                let coord = AVCaptureDevice.RotationCoordinator(device: dev, previewLayer: self.previewView.previewLayer)
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
            syncLegacyOrientation()
        }
    }

    private func applyCurrentRotation() {
        if #available(iOS 17.0, *) {
            guard let coord = rotationCoordinatorObj as? AVCaptureDevice.RotationCoordinator else { return }
            applyPreviewRotationAngle(coord.videoRotationAngleForHorizonLevelPreview)
            applyCaptureRotationAngle(coord.videoRotationAngleForHorizonLevelCapture)
        } else {
            syncLegacyOrientation()
        }
    }

    private func legacyVideoOrientation() -> AVCaptureVideoOrientation {
        switch currentInterfaceOrientation {
        case .portrait: return .portrait
        case .portraitUpsideDown: return .portraitUpsideDown
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        default: return .landscapeRight
        }
    }

    private func syncLegacyOrientation() {
        if #available(iOS 17.0, *) { return }
        if let ws = hostContainerView?.window?.windowScene {
            currentInterfaceOrientation = ws.interfaceOrientation
        }
        let vo = legacyVideoOrientation()
        if let pConn = previewView.previewLayer.connection, pConn.isVideoOrientationSupported, pConn.videoOrientation != vo {
            pConn.videoOrientation = vo
        }
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            if let c1 = self.photoOutput?.connection(with: .video), c1.isVideoOrientationSupported, c1.videoOrientation != vo {
                c1.videoOrientation = vo
            }
            if let c2 = self.videoDataOutput?.connection(with: .video), c2.isVideoOrientationSupported, c2.videoOrientation != vo {
                c2.videoOrientation = vo
            }
        }
    }

    // MARK: - Layout & Filter Sync

    func updateLayout(visible: Bool, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, mirror: Bool, radius: CGFloat, bgHex: String?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let ws = self.hostContainerView?.window?.windowScene {
                self.currentInterfaceOrientation = ws.interfaceOrientation
            }

            self.stateLock.lock()
            self.latestMirrored = mirror
            let hasFilter = (self.activeFilter != "none" || self.activeSoftSkin)
            self.stateLock.unlock()

            let validRect = visible && w > 2 && h > 2
            let rx = Int(x.rounded()), ry = Int(y.rounded()), rw = Int(w.rounded()), rh = Int(h.rounded()), rr = Int(max(0, radius).rounded())
            let sig = "\(validRect)|\(rx)|\(ry)|\(rw)|\(rh)|\(mirror)|\(rr)|\(bgHex ?? "")|\(hasFilter)"
            if sig == self.lastLayoutSig {
                return
            }
            self.lastLayoutSig = sig

            if let hex = bgHex, let c = Self.colorFromHex(hex) {
                self.hostContainerView?.backgroundColor = c
            }

            CATransaction.begin()
            CATransaction.setDisableActions(true)
            self.previewView.isHidden = !validRect
            self.previewView.wantsFilterOverlay = hasFilter && validRect
            if validRect {
                let targetFrame = CGRect(x: x, y: y, width: w, height: h)
                if self.previewView.frame != targetFrame {
                    self.previewView.frame = targetFrame
                }
                let b = self.previewView.bounds
                if self.previewView.previewLayer.bounds != b {
                    self.previewView.previewLayer.bounds = b
                }
                let center = CGPoint(x: b.midX, y: b.midY)
                if self.previewView.previewLayer.position != center {
                    self.previewView.previewLayer.position = center
                }
                let rVal = max(0, radius)
                if self.previewView.layer.cornerRadius != rVal {
                    self.previewView.layer.cornerRadius = rVal
                }
                if let fv = self.previewView.filterView {
                    if fv.frame != self.previewView.bounds {
                        fv.frame = self.previewView.bounds
                    }
                    if !hasFilter && !fv.isHidden {
                        fv.isHidden = true
                    }
                }
                self.applyPreviewMirror(mirror)
            } else {
                if self.previewView.filterView?.isHidden == false {
                    self.previewView.filterView?.isHidden = true
                }
            }
            CATransaction.commit()
            self.previewView.syncRenderState(visible: validRect, wantsFilter: hasFilter && validRect, bounds: self.previewView.bounds)
            if validRect {
                self.applyCurrentRotation()
            } else {
                self.syncLegacyOrientation()
            }
        }
    }

    func setCustomLut(id: String, dimension: Int, rgbaBase64: String) {
        var cubeData: Data? = nil
        if !id.isEmpty, dimension >= 2, dimension <= 64, !rgbaBase64.isEmpty,
           let raw = Data(base64Encoded: rgbaBase64) {
            let expected = dimension * dimension * dimension * 4
            if raw.count == expected {
                var floats = [Float](repeating: 0, count: expected)
                raw.withUnsafeBytes { (rawBuf: UnsafeRawBufferPointer) in
                    let inv: Float = 1.0 / 255.0
                    for i in 0..<expected {
                        floats[i] = Float(rawBuf[i]) * inv
                    }
                }
                cubeData = floats.withUnsafeBufferPointer { (buf: UnsafeBufferPointer<Float>) in Data(buffer: buf) }
            }
        }
        let validId = (cubeData != nil) ? id : ""
        let validDim = (cubeData != nil) ? dimension : 0
        previewView.setCustomLut(id: validId, dimension: validDim, cubeData: cubeData)
        recFilterChain.setCustomLut(id: validId, dimension: validDim, cubeData: cubeData)
    }

    func setFilter(filterKey: String, softSkin: Bool) {
        stateLock.lock()
        activeFilter = filterKey.isEmpty ? "none" : filterKey
        activeSoftSkin = softSkin
        let hasFilter = (activeFilter != "none" || activeSoftSkin)
        stateLock.unlock()

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.lastLayoutSig = ""
            let isVis = !self.previewView.isHidden
            let showOverlay = hasFilter && isVis
            self.previewView.wantsFilterOverlay = showOverlay
            if !showOverlay {
                self.previewView.filterView?.isHidden = true
            }
            self.previewView.syncRenderState(visible: isVis, wantsFilter: showOverlay, bounds: self.previewView.bounds)
        }
    }

    private static func colorFromHex(_ hex: String) -> UIColor? {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((v >> 16) & 0xFF) / 255.0,
            green: CGFloat((v >> 8) & 0xFF) / 255.0,
            blue: CGFloat(v & 0xFF) / 255.0,
            alpha: 1.0
        )
    }

    // MARK: - Live Frame Buffer & Filtering

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === audioDataOutput {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            recLock.lock()
            if isRecordingVideo && recSessionStarted,
               let writer = assetWriter,
               let aIn = writerAudioInput,
               writer.status == .writing,
               (!recFirstPts.isValid || pts >= recFirstPts),
               aIn.isReadyForMoreMediaData {
                aIn.append(sampleBuffer)
            }
            recLock.unlock()
            return
        }

        guard output === videoDataOutput, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let rawW = CVPixelBufferGetWidth(pb)
        let rawH = CVPixelBufferGetHeight(pb)

        stateLock.lock()
        latestBuffer = pb
        let rot = captureRotationAngle
        if rawW > 0 && rawH > 0 {
            let deg = ((Int(rot.rounded()) % 360) + 360) % 360
            let swap = (deg == 90 || deg == 270)
            currentWidth = swap ? rawH : rawW
            currentHeight = swap ? rawW : rawH
        }
        let filter = activeFilter
        let soft = activeSoftSkin
        let mir = latestMirrored
        stateLock.unlock()

        if filter != "none" || soft {
            previewView.renderFiltered(pixelBuffer: pb, rotationAngle: rot, mirrored: mir, filter: filter, softSkin: soft)
        }

        // Write filtered/mirrored video frames directly into AVAssetWriter when Video Guestbook is recording.
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        recLock.lock()
        let activeRec = isRecordingVideo
        let writer = assetWriter
        let vIn = writerVideoInput
        let adaptor = writerAdaptor
        let started = recSessionStarted
        let lastPts = recLastVideoPts
        let rw = recWidth
        let rh = recHeight
        let rMir = recMirror
        let rFilter = recFilter
        let rSoft = recSoftSkin
        recLock.unlock()

        guard activeRec, let aw = writer, let vidIn = vIn, let pixAdaptor = adaptor, rw > 1, rh > 1 else { return }
        if started && lastPts.isValid && CMTimeSubtract(pts, lastPts).seconds < 0.029 { return }
        guard aw.status == .writing, vidIn.isReadyForMoreMediaData, let pool = pixAdaptor.pixelBufferPool else { return }

        var outPb: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &outPb)
        guard status == kCVReturnSuccess, let dstPb = outPb else { return }

        autoreleasepool {
            let targetRect = CGRect(x: 0, y: 0, width: rw, height: rh)
            var img = Self.orientImage(CIImage(cvPixelBuffer: pb), rotationAngle: rot)
            let sx = targetRect.width / max(1, img.extent.width)
            let sy = targetRect.height / max(1, img.extent.height)
            img = img
                .transformed(by: CGAffineTransform(translationX: -img.extent.origin.x, y: -img.extent.origin.y))
                .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
                .cropped(to: targetRect)
            if rMir {
                img = img.oriented(.upMirrored)
            }
            img = recFilterChain.apply(to: img, filter: rFilter, softSkin: rSoft)
            jpegEncodeLock.lock()
            frameCiContext.render(img, to: dstPb, bounds: targetRect, colorSpace: Self.srgbColorSpace)
            jpegEncodeLock.unlock()
        }

        recLock.lock()
        if isRecordingVideo && assetWriter === aw && aw.status == .writing {
            if !recSessionStarted {
                aw.startSession(atSourceTime: pts)
                recSessionStarted = true
                recFirstPts = pts
            }
            if vidIn.isReadyForMoreMediaData {
                if pixAdaptor.append(dstPb, withPresentationTime: pts) {
                    recLastVideoPts = pts
                }
            }
        }
        recLock.unlock()
    }

    func latestFrameJpeg(maxSide: CGFloat = 640, quality: CGFloat = 0.74) -> Data? {
        stateLock.lock()
        let pb = latestBuffer
        let rot = captureRotationAngle
        stateLock.unlock()
        guard let buffer = pb else { return nil }
        return jpegData(from: buffer, rotationAngle: rot, maxSide: maxSide, quality: quality)?.data
    }

    private func jpegData(from buffer: CVPixelBuffer, rotationAngle: CGFloat, maxSide: CGFloat, quality: CGFloat) -> (data: Data, w: Int, h: Int)? {
        jpegEncodeLock.lock()
        defer { jpegEncodeLock.unlock() }
        return autoreleasepool {
            var ci = Self.orientImage(CIImage(cvPixelBuffer: buffer), rotationAngle: rotationAngle)
            let ow = ci.extent.width
            let oh = ci.extent.height
            guard ow > 0, oh > 0 else { return nil }
            if maxSide > 0 && max(ow, oh) > maxSide {
                let k = maxSide / max(ow, oh)
                ci = ci.transformed(by: CGAffineTransform(scaleX: k, y: k))
            }
            let w = max(1, Int(ci.extent.width.rounded()))
            let h = max(1, Int(ci.extent.height.rounded()))
            let q = max(0.3, min(0.96, quality))
            let jpgOpts: [CIImageRepresentationOption: Any] = [
                CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): q
            ]
            if let jpg = frameCiContext.jpegRepresentation(
                of: ci,
                colorSpace: Self.srgbColorSpace,
                options: jpgOpts
            ) {
                return (jpg, w, h)
            }
            guard let cg = frameCiContext.createCGImage(ci, from: ci.extent) else { return nil }
            guard let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: q) else { return nil }
            return (jpg, cg.width, cg.height)
        }
    }

    /// Serial-queue-confined reusable CoreImage filter chain. Eliminates per-frame CIFilter & CIVector
    /// allocations at 30 fps while clearing input image references immediately after building each graph.
    final class LiveFilterChain {
        private static let lutColorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? NativeCameraBridge.srgbColorSpace
        private static let blackImage = CIImage(color: .black)
        private static let vec5000 = CIVector(x: 5000, y: 0)
        private static let vec5200 = CIVector(x: 5200, y: 0)
        private static let vec5600 = CIVector(x: 5600, y: 0)
        private static let vec5800 = CIVector(x: 5800, y: 0)
        private static let vec6300 = CIVector(x: 6300, y: 0)
        private static let vec6400 = CIVector(x: 6400, y: 0)
        private static let vec6500 = CIVector(x: 6500, y: 0)
        private static let vecPastelN = CIVector(x: 6200, y: -12)
        private static let vecPastelT = CIVector(x: 5900, y: 12)
        private static let vecRoseN = CIVector(x: 6000, y: -15)
        private static let vecRoseT = CIVector(x: 6200, y: 10)

        private lazy var softSkinFilter = CIFilter(name: "CIColorControls")
        private lazy var colorControlsFilter = CIFilter(name: "CIColorControls")
        private lazy var tempTintFilter = CIFilter(name: "CITemperatureAndTint")
        private lazy var hueAdjustFilter = CIFilter(name: "CIHueAdjust")
        private lazy var sepiaFilter = CIFilter(name: "CISepiaTone")
        private lazy var vignetteFilter = CIFilter(name: "CIVignette")
        private lazy var noirFilter = CIFilter(name: "CIPhotoEffectNoir")
        private lazy var fadeFilter = CIFilter(name: "CIPhotoEffectFade")
        private lazy var bloomFilter = CIFilter(name: "CIBloom")
        private lazy var colorCubeFilter = CIFilter(name: "CIColorCubeWithColorSpace")
        private let lutLock = NSLock()
        private var customLutId: String = ""
        private var customLutDim: Int = 0
        private var customLutData: Data? = nil

        func setCustomLut(id: String, dimension: Int, cubeData: Data?) {
            lutLock.lock()
            customLutId = id
            customLutDim = dimension
            customLutData = cubeData
            lutLock.unlock()
        }

        private func runColorCube(to img: CIImage, dimension: Int, cubeData: Data) -> CIImage {
            guard let f = colorCubeFilter else { return img }
            f.setValue(img, forKey: kCIInputImageKey)
            f.setValue(dimension, forKey: "inputCubeDimension")
            f.setValue(cubeData, forKey: "inputCubeData")
            f.setValue(Self.lutColorSpace, forKey: "inputColorSpace")
            let out = f.outputImage ?? img
            f.setValue(nil, forKey: kCIInputImageKey)
            return out
        }

        private func runColorControls(_ f: CIFilter?, to img: CIImage, brightness: Double = 0, contrast: Double = 1, saturation: Double = 1) -> CIImage {
            guard let f = f else { return img }
            f.setValue(img, forKey: kCIInputImageKey)
            f.setValue(brightness, forKey: kCIInputBrightnessKey)
            f.setValue(contrast, forKey: kCIInputContrastKey)
            f.setValue(saturation, forKey: kCIInputSaturationKey)
            let out = f.outputImage ?? img
            f.setValue(nil, forKey: kCIInputImageKey)
            return out
        }

        private func runTempTint(to img: CIImage, neutral: CIVector, target: CIVector) -> CIImage {
            guard let f = tempTintFilter else { return img }
            f.setValue(img, forKey: kCIInputImageKey)
            f.setValue(neutral, forKey: "inputNeutral")
            f.setValue(target, forKey: "inputTargetNeutral")
            let out = f.outputImage ?? img
            f.setValue(nil, forKey: kCIInputImageKey)
            return out
        }

        private func runHueAdjust(to img: CIImage, angle: Double) -> CIImage {
            guard let f = hueAdjustFilter else { return img }
            f.setValue(img, forKey: kCIInputImageKey)
            f.setValue(angle, forKey: kCIInputAngleKey)
            let out = f.outputImage ?? img
            f.setValue(nil, forKey: kCIInputImageKey)
            return out
        }

        private func runSepia(to img: CIImage, intensity: Double) -> CIImage {
            guard let f = sepiaFilter else { return img }
            f.setValue(img, forKey: kCIInputImageKey)
            f.setValue(intensity, forKey: kCIInputIntensityKey)
            let out = f.outputImage ?? img
            f.setValue(nil, forKey: kCIInputImageKey)
            return out
        }

        private func runVignette(to img: CIImage, intensity: Double, extent: CGRect) -> CIImage {
            guard let f = vignetteFilter else { return img }
            f.setValue(img, forKey: kCIInputImageKey)
            f.setValue(intensity, forKey: kCIInputIntensityKey)
            f.setValue(1.6, forKey: kCIInputRadiusKey)
            let out = f.outputImage?.cropped(to: extent) ?? img
            f.setValue(nil, forKey: kCIInputImageKey)
            return out
        }

        private func runUnary(_ f: CIFilter?, to img: CIImage) -> CIImage {
            guard let f = f else { return img }
            f.setValue(img, forKey: kCIInputImageKey)
            let out = f.outputImage ?? img
            f.setValue(nil, forKey: kCIInputImageKey)
            return out
        }

        private func runCinemaBars(to img: CIImage, fraction: CGFloat, extent: CGRect) -> CIImage {
            let barH = (extent.height * fraction).rounded()
            guard barH > 1 else { return img }
            let topRect = CGRect(x: extent.minX, y: extent.maxY - barH, width: extent.width, height: barH)
            let botRect = CGRect(x: extent.minX, y: extent.minY, width: extent.width, height: barH)
            return Self.blackImage.cropped(to: topRect)
                .composited(over: Self.blackImage.cropped(to: botRect).composited(over: img))
                .cropped(to: extent)
        }

        func apply(to input: CIImage, filter: String, softSkin: Bool) -> CIImage {
            let extent = input.extent
            var img = input
            if softSkin {
                img = runColorControls(softSkinFilter, to: img, brightness: 0.03, contrast: 1.0, saturation: 1.03)
            }
            switch filter {
            case "bw":
                img = runColorControls(colorControlsFilter, to: img, brightness: 0, contrast: 1.12, saturation: 0.0)
            case "noir":
                img = runUnary(noirFilter, to: img)
                img = runVignette(to: img, intensity: 0.85, extent: extent)
            case "sepia":
                img = runSepia(to: img, intensity: 0.75)
            case "warm", "retro":
                img = runTempTint(to: img, neutral: Self.vec5200, target: Self.vec6400)
            case "cool":
                img = runTempTint(to: img, neutral: Self.vec6500, target: Self.vec5200)
            case "korean":
                img = runColorControls(colorControlsFilter, to: img, brightness: 0.05, contrast: 1.06, saturation: 1.02)
            case "film":
                img = runUnary(fadeFilter, to: img)
                img = runVignette(to: img, intensity: 0.6, extent: extent)
            case "faded", "instant":
                img = runUnary(fadeFilter, to: img)
            case "beauty":
                img = runColorControls(colorControlsFilter, to: img, brightness: 0.035, contrast: 0.94, saturation: 1.06)
                img = runTempTint(to: img, neutral: Self.vec5800, target: Self.vec6300)
            case "glow":
                img = runColorControls(colorControlsFilter, to: img, brightness: 0.055, contrast: 0.92, saturation: 1.12)
                if let f = bloomFilter {
                    f.setValue(img, forKey: kCIInputImageKey)
                    f.setValue(8.0, forKey: kCIInputRadiusKey)
                    f.setValue(0.28, forKey: kCIInputIntensityKey)
                    if let out = f.outputImage { img = out.cropped(to: extent) }
                    f.setValue(nil, forKey: kCIInputImageKey)
                }
            case "golden":
                img = runSepia(to: img, intensity: 0.25)
                img = runColorControls(colorControlsFilter, to: img, brightness: 0.03, contrast: 1.05, saturation: 1.32)
                img = runTempTint(to: img, neutral: Self.vec5000, target: Self.vec6500)
                img = runVignette(to: img, intensity: 0.55, extent: extent)
            case "pastel":
                img = runColorControls(colorControlsFilter, to: img, brightness: 0.07, contrast: 0.88, saturation: 0.78)
                img = runTempTint(to: img, neutral: Self.vecPastelN, target: Self.vecPastelT)
            case "rose":
                img = runColorControls(colorControlsFilter, to: img, brightness: 0.035, contrast: 1.0, saturation: 1.15)
                img = runHueAdjust(to: img, angle: 0.14)
                img = runTempTint(to: img, neutral: Self.vecRoseN, target: Self.vecRoseT)
            case "mint":
                img = runColorControls(colorControlsFilter, to: img, brightness: 0.04, contrast: 1.0, saturation: 1.10)
                img = runHueAdjust(to: img, angle: -0.31)
            case "cinema":
                img = runColorControls(colorControlsFilter, to: img, brightness: -0.02, contrast: 1.14, saturation: 1.08)
                img = runTempTint(to: img, neutral: Self.vec6300, target: Self.vec5600)
                img = runVignette(to: img, intensity: 0.7, extent: extent)
                img = runCinemaBars(to: img, fraction: 0.09, extent: extent)
            case "neon":
                img = runColorControls(colorControlsFilter, to: img, brightness: -0.02, contrast: 1.16, saturation: 1.48)
                img = runHueAdjust(to: img, angle: -0.21)
                img = runVignette(to: img, intensity: 0.6, extent: extent)
            case "camcorder":
                img = runSepia(to: img, intensity: 0.15)
                img = runColorControls(colorControlsFilter, to: img, brightness: 0.015, contrast: 1.10, saturation: 1.28)
                img = runVignette(to: img, intensity: 0.6, extent: extent)
            default:
                lutLock.lock()
                let lutId = customLutId
                let lutDim = customLutDim
                let lutData = customLutData
                lutLock.unlock()
                if !lutId.isEmpty && filter == lutId, lutDim >= 2, let cubeData = lutData {
                    img = runColorCube(to: img, dimension: lutDim, cubeData: cubeData)
                }
            }
            return img.cropped(to: extent)
        }
    }

    static func applyLiveFilter(to input: CIImage, filter: String, softSkin: Bool) -> CIImage {
        return LiveFilterChain().apply(to: input, filter: filter, softSkin: softSkin)
    }

    // MARK: - Instant Hardware Still Capture

    func capturePhoto(completion: @escaping ([String: Any]) -> Void) {
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            guard self.session.isRunning else {
                DispatchQueue.main.async {
                    completion(["ok": false, "error": "Camera is not running."])
                }
                return
            }

            let storeAndAnswer: (Data, Int, Int) -> Void = { data, w, h in
                self.shotsLock.lock()
                self.shotSeq += 1
                let sid = self.shotSeq
                self.shotStore[sid] = data
                // Keep only the most recent shots in temporary RAM (2 on 3 GB iPads, 4 otherwise)
                let maxKeep = NativeCameraBridge.isLowRamDevice ? 2 : 4
                if self.shotStore.count > maxKeep {
                    let drop = self.shotStore.keys.sorted().dropLast(maxKeep)
                    for k in drop { self.shotStore.removeValue(forKey: k) }
                }
                self.shotsLock.unlock()

                DispatchQueue.main.async {
                    completion(["ok": true, "url": "/avcam/shot/\(sid)", "width": w, "height": h])
                }
            }

            // Use AVCapturePhotoOutput on built-in cameras for crisp hardware ISP capture;
            // fall back immediately to CVPixelBuffer if unavailable (e.g. UVC capture card).
            if let pOut = self.photoOutput, self.session.outputs.contains(pOut) {
                let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                if pOut.supportedFlashModes.contains(.off) {
                    settings.flashMode = .off
                }
                if #available(iOS 16.0, *) {
                    let dim = pOut.maxPhotoDimensions
                    if dim.width > 0 && dim.height > 0 {
                        settings.maxPhotoDimensions = dim
                    }
                } else {
                    settings.isHighResolutionPhotoEnabled = pOut.isHighResolutionCaptureEnabled
                }
                if #available(iOS 13.0, *) {
                    if pOut.maxPhotoQualityPrioritization.rawValue >= AVCapturePhotoOutput.QualityPrioritization.balanced.rawValue {
                        settings.photoQualityPrioritization = .balanced
                    } else if pOut.maxPhotoQualityPrioritization.rawValue >= AVCapturePhotoOutput.QualityPrioritization.speed.rawValue {
                        settings.photoQualityPrioritization = .speed
                    }
                }
                let uid = settings.uniqueID
                self.shotsLock.lock()
                self.pendingPhotoCompletions[uid] = { result in
                    switch result {
                    case .success(let tuple):
                        storeAndAnswer(tuple.0, tuple.1, tuple.2)
                    case .failure:
                        // Instant pixel buffer fallback if hardware photo capture fails
                        self.stateLock.lock()
                        let pb = self.latestBuffer
                        let rot = self.captureRotationAngle
                        self.stateLock.unlock()
                        let stillMax: CGFloat = NativeCameraBridge.isLowRamDevice ? 1920 : 2400
                        if let buf = pb, let j = self.jpegData(from: buf, rotationAngle: rot, maxSide: stillMax, quality: 0.94) {
                            storeAndAnswer(j.data, j.w, j.h)
                        } else {
                            DispatchQueue.main.async {
                                completion(["ok": false, "error": "Failed to capture camera photo."])
                            }
                        }
                    }
                }
                self.shotsLock.unlock()
                pOut.capturePhoto(with: settings, delegate: self)
                self.sessionQueue.asyncAfter(deadline: .now() + 5.0) { [weak self] in
                    guard let self = self else { return }
                    self.shotsLock.lock()
                    let timedOutCb = self.pendingPhotoCompletions.removeValue(forKey: uid)
                    self.shotsLock.unlock()
                    if let cb = timedOutCb {
                        cb(.failure(NSError(domain: "NativeCameraBridge", code: 408, userInfo: [NSLocalizedDescriptionKey: "Photo capture timed out."])))
                    }
                }
                return
            }

            // External UVC capture card / webcam path: grab latest video frame directly (up to 3000px for 4K sources)
            self.stateLock.lock()
            let pb = self.latestBuffer
            let rot = self.captureRotationAngle
            self.stateLock.unlock()
            let uvcMax: CGFloat = NativeCameraBridge.isLowRamDevice ? 2048 : 3000
            if let buf = pb, let j = self.jpegData(from: buf, rotationAngle: rot, maxSide: uvcMax, quality: 0.94) {
                storeAndAnswer(j.data, j.w, j.h)
            } else {
                DispatchQueue.main.async {
                    completion(["ok": false, "error": "No camera frame available yet."])
                }
            }
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let uid = photo.resolvedSettings.uniqueID
        shotsLock.lock()
        let cb = pendingPhotoCompletions.removeValue(forKey: uid)
        shotsLock.unlock()
        guard let completion = cb else { return }

        if let err = error {
            completion(.failure(err))
            return
        }
        guard let raw = photo.fileDataRepresentation(), !raw.isEmpty else {
            completion(.failure(NSError(domain: "NativeCameraBridge", code: 500, userInfo: [NSLocalizedDescriptionKey: "Empty photo data."])))
            return
        }

        // Fast hardware ImageIO orient + downscale (<= 2400px) without allocating an uncompressed 48 MB 12MP RGBA bitmap
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
                let cfData = raw as CFData
                if let src = CGImageSourceCreateWithData(cfData, nil) {
                    let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
                    let pw = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
                    let ph = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
                    let orient = (props?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
                    let maxSide = NativeCameraBridge.isLowRamDevice ? 1920 : 2400

                    if orient == 1 && pw > 0 && ph > 0 && max(pw, ph) <= maxSide {
                        completion(.success((raw, pw, ph)))
                        return
                    }

                    let thumbOpts: [CFString: Any] = [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceShouldCacheImmediately: true,
                        kCGImageSourceThumbnailMaxPixelSize: maxSide
                    ]
                    if let cgImg = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts as CFDictionary) {
                        let destData = NSMutableData()
                        if let dest = CGImageDestinationCreateWithData(destData as CFMutableData, "public.jpeg" as CFString, 1, nil) {
                            let saveOpts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.94]
                            CGImageDestinationAddImage(dest, cgImg, saveOpts as CFDictionary)
                            if CGImageDestinationFinalize(dest) {
                                completion(.success((destData as Data, cgImg.width, cgImg.height)))
                                return
                            }
                        }
                    }
                }
                completion(.success((raw, 0, 0)))
            }
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        let uid = resolvedSettings.uniqueID
        shotsLock.lock()
        let cb = pendingPhotoCompletions.removeValue(forKey: uid)
        shotsLock.unlock()
        if let completion = cb {
            let err = error ?? NSError(domain: "NativeCameraBridge", code: 500, userInfo: [NSLocalizedDescriptionKey: "Photo capture did not produce an image."])
            completion(.failure(err))
        }
    }

    func takeShotData(id: Int) -> Data? {
        shotsLock.lock()
        let data = shotStore.removeValue(forKey: id)
        shotsLock.unlock()
        return data
    }

    // MARK: - Hardware H.264/AAC MP4 Recording (Video Guestbook)

    func startVideoRecording(maxWidth: Int, bitrate: Int, mirror: Bool, filter: String, softSkin: Bool, completion: @escaping ([String: Any]) -> Void) {
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            guard self.session.isRunning else {
                DispatchQueue.main.async {
                    completion(["ok": false, "error": "Camera is not running."])
                }
                return
            }

            self.cancelActiveRecording()

            self.stateLock.lock()
            let curW = self.currentWidth
            let curH = self.currentHeight
            self.stateLock.unlock()

            let sw = curW > 0 ? curW : 1280
            let sh = curH > 0 ? curH : 720
            let cap = max(480, maxWidth)
            let longest = max(sw, sh)
            let scale = longest > cap ? Double(cap) / Double(longest) : 1.0
            let rw = max(2, (Int((Double(sw) * scale).rounded()) / 2) * 2)
            let rh = max(2, (Int((Double(sh) * scale).rounded()) / 2) * 2)

            let url = FileManager.default.temporaryDirectory.appendingPathComponent("pb4u-vg-\(UUID().uuidString).mp4")
            try? FileManager.default.removeItem(at: url)

            do {
                let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
                let vSettings: [String: Any] = [
                    AVVideoCodecKey: AVVideoCodecType.h264,
                    AVVideoWidthKey: rw,
                    AVVideoHeightKey: rh,
                    AVVideoCompressionPropertiesKey: [
                        AVVideoAverageBitRateKey: max(600_000, bitrate),
                        AVVideoExpectedSourceFrameRateKey: 30,
                        AVVideoMaxKeyFrameIntervalKey: 30
                    ]
                ]
                let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: vSettings)
                vIn.expectsMediaDataInRealTime = true

                let adaptorAttrs: [String: Any] = [
                    kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
                    kCVPixelBufferWidthKey as String: rw,
                    kCVPixelBufferHeightKey as String: rh,
                    kCVPixelBufferMetalCompatibilityKey as String: true
                ]
                let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: adaptorAttrs)

                guard writer.canAdd(vIn) else {
                    throw NSError(domain: "NativeCameraBridge", code: 500, userInfo: [NSLocalizedDescriptionKey: "Cannot configure video encoder."])
                }
                writer.add(vIn)

                var aIn: AVAssetWriterInput?
                if self.audioDataOutput != nil && self.audioInput != nil {
                    let aSettings: [String: Any] = [
                        AVFormatIDKey: kAudioFormatMPEG4AAC,
                        AVSampleRateKey: 44100,
                        AVNumberOfChannelsKey: 1,
                        AVEncoderBitRateKey: 64000
                    ]
                    let audioInputWriter = AVAssetWriterInput(mediaType: .audio, outputSettings: aSettings)
                    audioInputWriter.expectsMediaDataInRealTime = true
                    if writer.canAdd(audioInputWriter) {
                        writer.add(audioInputWriter)
                        aIn = audioInputWriter
                    }
                }

                guard writer.startWriting() else {
                    let msg = writer.error?.localizedDescription ?? "Could not start video recording."
                    throw NSError(domain: "NativeCameraBridge", code: 500, userInfo: [NSLocalizedDescriptionKey: msg])
                }

                self.recLock.lock()
                self.assetWriter = writer
                self.writerVideoInput = vIn
                self.writerAdaptor = adaptor
                self.writerAudioInput = aIn
                self.recFileURL = url
                self.recSessionStarted = false
                self.recFirstPts = .invalid
                self.recLastVideoPts = .invalid
                self.recWidth = rw
                self.recHeight = rh
                self.recMirror = mirror
                self.recFilter = filter.isEmpty ? "none" : filter
                self.recSoftSkin = softSkin
                self.isRecordingVideo = true
                self.recLock.unlock()

                DispatchQueue.main.async {
                    completion(["ok": true, "width": rw, "height": rh])
                }
            } catch {
                try? FileManager.default.removeItem(at: url)
                DispatchQueue.main.async {
                    completion(["ok": false, "error": error.localizedDescription])
                }
            }
        }
    }

    func stopVideoRecording(completion: @escaping ([String: Any]) -> Void) {
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            self.recLock.lock()
            let writer = self.assetWriter
            let vIn = self.writerVideoInput
            let aIn = self.writerAudioInput
            let url = self.recFileURL
            let started = self.recSessionStarted

            self.isRecordingVideo = false
            self.assetWriter = nil
            self.writerVideoInput = nil
            self.writerAdaptor = nil
            self.writerAudioInput = nil
            self.recFileURL = nil
            self.recSessionStarted = false
            self.recFirstPts = .invalid
            self.recLastVideoPts = .invalid
            self.recLock.unlock()

            guard let aw = writer, let outUrl = url else {
                DispatchQueue.main.async {
                    completion(["ok": false, "error": "Nothing was recorded."])
                }
                return
            }

            if !started || aw.status != .writing {
                aw.cancelWriting()
                try? FileManager.default.removeItem(at: outUrl)
                DispatchQueue.main.async {
                    completion(["ok": false, "error": aw.error?.localizedDescription ?? "Nothing was recorded."])
                }
                return
            }

            vIn?.markAsFinished()
            aIn?.markAsFinished()
            aw.finishWriting {
                if aw.status == .completed {
                    let size = (try? FileManager.default.attributesOfItem(atPath: outUrl.path)[.size] as? Int) ?? 0
                    self.shotsLock.lock()
                    self.videoSeq += 1
                    let vid = self.videoSeq
                    self.videoStore[vid] = outUrl
                    if self.videoStore.count > 2 {
                        let drop = self.videoStore.keys.sorted().dropLast(2)
                        for k in drop {
                            if let oldUrl = self.videoStore.removeValue(forKey: k) {
                                try? FileManager.default.removeItem(at: oldUrl)
                            }
                        }
                    }
                    self.shotsLock.unlock()
                    DispatchQueue.main.async {
                        completion(["ok": true, "url": "/avcam/video/\(vid)", "mime": "video/mp4", "size": size])
                    }
                } else {
                    let msg = aw.error?.localizedDescription ?? "Could not finish video."
                    try? FileManager.default.removeItem(at: outUrl)
                    DispatchQueue.main.async {
                        completion(["ok": false, "error": msg])
                    }
                }
            }
        }
    }

    private func cancelActiveRecording() {
        recLock.lock()
        let writer = assetWriter
        let url = recFileURL
        isRecordingVideo = false
        assetWriter = nil
        writerVideoInput = nil
        writerAdaptor = nil
        writerAudioInput = nil
        recFileURL = nil
        recSessionStarted = false
        recFirstPts = .invalid
        recLastVideoPts = .invalid
        recLock.unlock()

        if let aw = writer {
            aw.cancelWriting()
        }
        if let u = url {
            try? FileManager.default.removeItem(at: u)
        }
    }

    func takeVideoData(id: Int) -> Data? {
        shotsLock.lock()
        let url = videoStore.removeValue(forKey: id)
        shotsLock.unlock()
        guard let fileUrl = url else { return nil }
        let data = try? Data(contentsOf: fileUrl)
        try? FileManager.default.removeItem(at: fileUrl)
        return data
    }
}
