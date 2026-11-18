import UIKit
import AVFoundation
import CoreImage
import Metal
import MetalKit

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

    final class PreviewHostView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { return layer as! AVCaptureVideoPreviewLayer }

        let filterView: MTKView?
        private let ciContext: CIContext?
        private let cmdQueue: MTLCommandQueue?
        var wantsFilterOverlay: Bool = false

        override init(frame: CGRect) {
            if let dev = MTLCreateSystemDefaultDevice() {
                let mv = MTKView(frame: frame, device: dev)
                mv.framebufferOnly = false
                mv.enableSetNeedsDisplay = false
                mv.isPaused = true
                mv.autoResizeDrawable = true
                mv.contentMode = .scaleAspectFill
                mv.isHidden = true
                mv.isOpaque = false
                mv.layer.isOpaque = false
                mv.clearColor = MTLClearColorMake(0, 0, 0, 0)
                mv.backgroundColor = .clear
                self.filterView = mv
                self.ciContext = CIContext(mtlDevice: dev, options: [.useSoftwareRenderer: false])
                self.cmdQueue = dev.makeCommandQueue()
            } else {
                self.filterView = nil
                self.ciContext = nil
                self.cmdQueue = nil
            }
            super.init(frame: frame)
            backgroundColor = .black
            clipsToBounds = true
            previewLayer.videoGravity = .resizeAspectFill
            if let fv = filterView {
                fv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                addSubview(fv)
            }
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            previewLayer.frame = bounds
            if let fv = filterView {
                fv.frame = bounds
            }
        }

        func renderFiltered(pixelBuffer: CVPixelBuffer, mirrored: Bool, filter: String, softSkin: Bool) {
            guard let fv = filterView, let ctx = ciContext, let cq = cmdQueue else { return }
            DispatchQueue.main.async {
                guard self.wantsFilterOverlay, !self.isHidden, self.bounds.width > 2, self.bounds.height > 2 else { return }
                if fv.frame != self.bounds {
                    fv.frame = self.bounds
                    fv.layoutIfNeeded()
                }
                guard let drawable = fv.currentDrawable, let cmdBuf = cq.makeCommandBuffer() else { return }
                let dSize = fv.drawableSize
                guard dSize.width > 1, dSize.height > 1 else { return }
                let targetBounds = CGRect(origin: .zero, size: dSize)

                var img = CIImage(cvPixelBuffer: pixelBuffer)
                if mirrored {
                    img = img.transformed(by: CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -img.extent.width, y: 0))
                }
                img = NativeCameraBridge.applyLiveFilter(to: img, filter: filter, softSkin: softSkin)

                let scale = max(targetBounds.width / max(1, img.extent.width), targetBounds.height / max(1, img.extent.height))
                img = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                let dx = (targetBounds.width - img.extent.width) / 2.0 - img.extent.origin.x
                let dy = (targetBounds.height - img.extent.height) / 2.0 - img.extent.origin.y
                img = img.transformed(by: CGAffineTransform(translationX: dx, y: dy)).cropped(to: targetBounds)

                ctx.render(img, to: drawable.texture, commandBuffer: cmdBuf, bounds: targetBounds, colorSpace: CGColorSpaceCreateDeviceRGB())
                cmdBuf.present(drawable)
                cmdBuf.commit()
                if self.wantsFilterOverlay && !self.isHidden && fv.isHidden {
                    fv.isHidden = false
                }
            }
        }
    }

    let previewView = PreviewHostView(frame: .zero)
    weak var hostContainerView: UIView?

    private let session = AVCaptureSession()
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

    private var rotationObserverPreview: NSKeyValueObservation?
    private var rotationObserverCapture: NSKeyValueObservation?
    private var rotationCoordinatorObj: AnyObject?
    private var orientationObserver: NSObjectProtocol?
    private var sessionRuntimeObserver: NSObjectProtocol?
    private var sessionInterruptionEndedObserver: NSObjectProtocol?
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
    private var currentInterfaceOrientation: UIInterfaceOrientation = .landscapeLeft

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

    private let frameCiContext = CIContext(options: [.useSoftwareRenderer: false])

    private override init() {
        super.init()
        previewView.isHidden = true
        previewView.previewLayer.session = session
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
                guard let dev = self.currentDevice, dev.isConnected, !self.session.isRunning else { return }
                if err?.code == AVError.mediaServicesWereReset.rawValue || err != nil {
                    self.session.startRunning()
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
                guard let dev = self.currentDevice, dev.isConnected, !self.session.isRunning else { return }
                self.session.startRunning()
            }
        }
        deviceDisconnectedObserver = NotificationCenter.default.addObserver(
            forName: .AVCaptureDeviceWasDisconnected,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let self = self, let lost = note.object as? AVCaptureDevice else { return }
            self.sessionQueue.async {
                if self.currentDevice?.uniqueID == lost.uniqueID {
                    self.cancelActiveRecording()
                    if self.session.isRunning { self.session.stopRunning() }
                    self.stateLock.lock()
                    self.latestBuffer = nil
                    self.stateLock.unlock()
                }
            }
        }
    }

    deinit {
        if let obs = orientationObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = sessionRuntimeObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = sessionInterruptionEndedObserver { NotificationCenter.default.removeObserver(obs) }
        if let obs = deviceDisconnectedObserver { NotificationCenter.default.removeObserver(obs) }
    }

    // MARK: - Device Discovery

    private func discoveredDevices() -> [AVCaptureDevice] {
        var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .builtInUltraWideCamera]
        if #available(iOS 17.0, *) {
            types.append(.external)
        }
        let raw = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified).devices
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

    func stop(completion: (() -> Void)? = nil) {
        DispatchQueue.main.async { [weak self] in
            self?.previewView.wantsFilterOverlay = false
            self?.previewView.filterView?.isHidden = true
            self?.previewView.isHidden = true
        }
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
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
            self.stateLock.unlock()
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

    private func configureAndStart(deviceId: String?, presetName: String) throws -> [String: Any] {
        guard let dev = pickDevice(deviceId: deviceId) else {
            throw NSError(domain: "NativeCameraBridge", code: 404, userInfo: [NSLocalizedDescriptionKey: "No built-in or external USB camera found."])
        }

        var ext = false
        if #available(iOS 17.0, *) {
            ext = (dev.deviceType == .external)
        }

        if session.isRunning {
            session.stopRunning()
        }
        clearRotationObservers()

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

        // Choose crisp native preset: .photo gives full 4:3 sensor FOV on built-in iPads with hardware GPU preview;
        // external UVC capture cards prefer 1080p/720p video presets.
        let desiredPresets: [AVCaptureSession.Preset]
        switch presetName {
        case "480":
            desiredPresets = [.vga640x480, .hd1280x720, .high]
        case "720":
            desiredPresets = [.hd1280x720, .high]
        case "1080":
            desiredPresets = [.hd1920x1080, .hd1280x720, .high]
        case "max", "yuyv":
            desiredPresets = ext ? [.hd1920x1080, .hd1280x720, .high] : [.photo, .hd1920x1080, .high]
        default: // "auto"
            desiredPresets = ext ? [.hd1280x720, .hd1920x1080, .high] : [.photo, .hd1280x720, .high]
        }
        for p in desiredPresets where session.canSetSessionPreset(p) {
            session.sessionPreset = p
            break
        }

        let vOut = AVCaptureVideoDataOutput()
        vOut.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)]
        vOut.alwaysDiscardsLateVideoFrames = true
        vOut.setSampleBufferDelegate(self, queue: videoOutputQueue)
        if session.canAddOutput(vOut) {
            session.addOutput(vOut)
            videoDataOutput = vOut
        } else {
            videoDataOutput = nil
        }

        // External UVC / HDMI capture cards grab still frames from the live CVPixelBuffer directly;
        // skip AVCapturePhotoOutput so capture cards never stall on unsupported still-photo paths.
        if !ext {
            let pOut = AVCapturePhotoOutput()
            if session.canAddOutput(pOut) {
                pOut.isHighResolutionCaptureEnabled = true
                session.addOutput(pOut)
                photoOutput = pOut
            } else {
                photoOutput = nil
            }
        } else {
            photoOutput = nil
        }

        // Low-light boost & smooth continuous focus/exposure on built-in lenses
        if !ext {
            do {
                try dev.lockForConfiguration()
                if dev.isLowLightBoostSupported {
                    dev.automaticallyEnablesLowLightBoostWhenAvailable = true
                }
                if dev.isFocusModeSupported(.continuousAutoFocus) {
                    dev.focusMode = .continuousAutoFocus
                }
                if dev.isExposureModeSupported(.continuousAutoExposure) {
                    dev.exposureMode = .continuousAutoExposure
                }
                dev.unlockForConfiguration()
            } catch { }
        }

        if wantsAudio {
            attachAudioIfNeeded(inConfigBlock: true)
        }
        session.commitConfiguration()
        committed = true
        session.startRunning()

        // Configure rotation coordinator only after session connections exist and are running.
        setupRotation(for: dev)

        let dims = CMVideoFormatDescriptionGetDimensions(dev.activeFormat.formatDescription)
        let rawW = Int(dims.width)
        let rawH = Int(dims.height)
        let effective = effectivePreviewDimensions(rawW: rawW, rawH: rawH)

        stateLock.lock()
        isFrontCamera = (dev.position == .front)
        isExternalCamera = ext
        latestBuffer = nil
        currentWidth = effective.w
        currentHeight = effective.h
        stateLock.unlock()

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

    private func effectivePreviewDimensions(rawW: Int, rawH: Int) -> (w: Int, h: Int) {
        let a = max(rawW, rawH)
        let b = min(rawW, rawH)
        if a == 0 || b == 0 { return (1280, 720) }
        let portrait = currentInterfaceOrientation.isPortrait
        return portrait ? (b, a) : (a, b)
    }

    // MARK: - Orientation / Rotation

    private func clearRotationObservers() {
        rotationObserverPreview?.invalidate()
        rotationObserverPreview = nil
        rotationObserverCapture?.invalidate()
        rotationObserverCapture = nil
        rotationCoordinatorObj = nil
    }

    @available(iOS 17.0, *)
    private func applyPreviewRotationAngle(_ angle: CGFloat) {
        if let conn = previewView.previewLayer.connection, conn.isVideoRotationAngleSupported(angle) {
            conn.videoRotationAngle = angle
        }
    }

    @available(iOS 17.0, *)
    private func applyCaptureRotationAngle(_ angle: CGFloat) {
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            if let pConn = self.photoOutput?.connection(with: .video), pConn.isVideoRotationAngleSupported(angle) {
                pConn.videoRotationAngle = angle
            }
            if let vConn = self.videoDataOutput?.connection(with: .video), vConn.isVideoRotationAngleSupported(angle) {
                vConn.videoRotationAngle = angle
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
        if let pConn = previewView.previewLayer.connection, pConn.isVideoOrientationSupported {
            pConn.videoOrientation = vo
        }
        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            if let c1 = self.photoOutput?.connection(with: .video), c1.isVideoOrientationSupported {
                c1.videoOrientation = vo
            }
            if let c2 = self.videoDataOutput?.connection(with: .video), c2.isVideoOrientationSupported {
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
            if let hex = bgHex, let c = Self.colorFromHex(hex) {
                self.hostContainerView?.backgroundColor = c
            }

            self.stateLock.lock()
            self.latestMirrored = mirror
            let hasFilter = (self.activeFilter != "none" || self.activeSoftSkin)
            self.stateLock.unlock()

            CATransaction.begin()
            CATransaction.setDisableActions(true)
            let validRect = visible && w > 2 && h > 2
            self.previewView.isHidden = !validRect
            self.previewView.wantsFilterOverlay = hasFilter && validRect
            if validRect {
                self.previewView.frame = CGRect(x: x, y: y, width: w, height: h)
                self.previewView.previewLayer.frame = self.previewView.bounds
                self.previewView.layer.cornerRadius = max(0, radius)
                if let fv = self.previewView.filterView {
                    fv.frame = self.previewView.bounds
                    if !hasFilter {
                        fv.isHidden = true
                    }
                }
                if let conn = self.previewView.previewLayer.connection, conn.isVideoMirroringSupported {
                    conn.automaticallyAdjustsVideoMirroring = false
                    conn.isVideoMirrored = mirror
                }
            } else {
                self.previewView.filterView?.isHidden = true
            }
            CATransaction.commit()
            if validRect {
                self.applyCurrentRotation()
            } else {
                self.syncLegacyOrientation()
            }
        }
    }

    func setFilter(filterKey: String, softSkin: Bool) {
        stateLock.lock()
        activeFilter = filterKey.isEmpty ? "none" : filterKey
        activeSoftSkin = softSkin
        let hasFilter = (activeFilter != "none" || activeSoftSkin)
        stateLock.unlock()

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let showOverlay = hasFilter && !self.previewView.isHidden
            self.previewView.wantsFilterOverlay = showOverlay
            if !showOverlay {
                self.previewView.filterView?.isHidden = true
            }
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
        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)

        stateLock.lock()
        latestBuffer = pb
        if w > 0 && h > 0 {
            currentWidth = w
            currentHeight = h
        }
        let filter = activeFilter
        let soft = activeSoftSkin
        let mir = latestMirrored
        stateLock.unlock()

        if filter != "none" || soft {
            previewView.renderFiltered(pixelBuffer: pb, mirrored: mir, filter: filter, softSkin: soft)
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
            var img = CIImage(cvPixelBuffer: pb)
            if rMir {
                img = img.transformed(by: CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -img.extent.width, y: 0))
            }
            img = NativeCameraBridge.applyLiveFilter(to: img, filter: rFilter, softSkin: rSoft)
            let sx = targetRect.width / max(1, img.extent.width)
            let sy = targetRect.height / max(1, img.extent.height)
            img = img
                .transformed(by: CGAffineTransform(translationX: -img.extent.origin.x, y: -img.extent.origin.y))
                .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
                .cropped(to: targetRect)
            frameCiContext.render(img, to: dstPb, bounds: targetRect, colorSpace: CGColorSpaceCreateDeviceRGB())
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

    func latestFrameJpeg(maxSide: CGFloat = 720, quality: CGFloat = 0.78) -> Data? {
        stateLock.lock()
        let pb = latestBuffer
        stateLock.unlock()
        guard let buffer = pb else { return nil }
        return jpegData(from: buffer, maxSide: maxSide, quality: quality)?.data
    }

    private func jpegData(from buffer: CVPixelBuffer, maxSide: CGFloat, quality: CGFloat) -> (data: Data, w: Int, h: Int)? {
        var ci = CIImage(cvPixelBuffer: buffer)
        let ow = ci.extent.width
        let oh = ci.extent.height
        guard ow > 0, oh > 0 else { return nil }
        if maxSide > 0 && max(ow, oh) > maxSide {
            let k = maxSide / max(ow, oh)
            ci = ci.transformed(by: CGAffineTransform(scaleX: k, y: k))
        }
        guard let cg = frameCiContext.createCGImage(ci, from: ci.extent) else { return nil }
        let img = UIImage(cgImage: cg)
        guard let jpg = img.jpegData(compressionQuality: quality) else { return nil }
        return (jpg, cg.width, cg.height)
    }

    private static func applyColorControls(to img: CIImage, brightness: Double = 0, contrast: Double = 1, saturation: Double = 1) -> CIImage {
        guard let f = CIFilter(name: "CIColorControls") else { return img }
        f.setValue(img, forKey: kCIInputImageKey)
        f.setValue(brightness, forKey: kCIInputBrightnessKey)
        f.setValue(contrast, forKey: kCIInputContrastKey)
        f.setValue(saturation, forKey: kCIInputSaturationKey)
        return f.outputImage ?? img
    }

    private static func applyTempTint(to img: CIImage, neutral: CIVector, target: CIVector) -> CIImage {
        guard let f = CIFilter(name: "CITemperatureAndTint") else { return img }
        f.setValue(img, forKey: kCIInputImageKey)
        f.setValue(neutral, forKey: "inputNeutral")
        f.setValue(target, forKey: "inputTargetNeutral")
        return f.outputImage ?? img
    }

    private static func applyHueAdjust(to img: CIImage, angle: Double) -> CIImage {
        guard let f = CIFilter(name: "CIHueAdjust") else { return img }
        f.setValue(img, forKey: kCIInputImageKey)
        f.setValue(angle, forKey: kCIInputAngleKey)
        return f.outputImage ?? img
    }

    private static func applySepia(to img: CIImage, intensity: Double) -> CIImage {
        guard let f = CIFilter(name: "CISepiaTone") else { return img }
        f.setValue(img, forKey: kCIInputImageKey)
        f.setValue(intensity, forKey: kCIInputIntensityKey)
        return f.outputImage ?? img
    }

    private static func applyVignette(to img: CIImage, intensity: Double, extent: CGRect) -> CIImage {
        guard let f = CIFilter(name: "CIVignette") else { return img }
        f.setValue(img, forKey: kCIInputImageKey)
        f.setValue(intensity, forKey: kCIInputIntensityKey)
        f.setValue(1.6, forKey: kCIInputRadiusKey)
        return f.outputImage?.cropped(to: extent) ?? img
    }

    private static func applyCinemaBars(to img: CIImage, fraction: CGFloat, extent: CGRect) -> CIImage {
        let barH = (extent.height * fraction).rounded()
        guard barH > 1 else { return img }
        let black = CIImage(color: .black)
        let topRect = CGRect(x: extent.minX, y: extent.maxY - barH, width: extent.width, height: barH)
        let botRect = CGRect(x: extent.minX, y: extent.minY, width: extent.width, height: barH)
        return black.cropped(to: topRect)
            .composited(over: black.cropped(to: botRect).composited(over: img))
            .cropped(to: extent)
    }

    static func applyLiveFilter(to input: CIImage, filter: String, softSkin: Bool) -> CIImage {
        let extent = input.extent
        var img = input
        if softSkin {
            img = applyColorControls(to: img, brightness: 0.03, contrast: 1.0, saturation: 1.03)
        }
        switch filter {
        case "bw":
            img = applyColorControls(to: img, brightness: 0, contrast: 1.12, saturation: 0.0)
        case "noir":
            if let f = CIFilter(name: "CIPhotoEffectNoir") {
                f.setValue(img, forKey: kCIInputImageKey)
                if let out = f.outputImage { img = out }
            }
            img = applyVignette(to: img, intensity: 0.85, extent: extent)
        case "sepia":
            img = applySepia(to: img, intensity: 0.75)
        case "warm", "retro":
            img = applyTempTint(to: img, neutral: CIVector(x: 5200, y: 0), target: CIVector(x: 6400, y: 0))
        case "cool":
            img = applyTempTint(to: img, neutral: CIVector(x: 6500, y: 0), target: CIVector(x: 5200, y: 0))
        case "korean":
            img = applyColorControls(to: img, brightness: 0.05, contrast: 1.06, saturation: 1.02)
        case "film":
            if let f = CIFilter(name: "CIPhotoEffectFade") {
                f.setValue(img, forKey: kCIInputImageKey)
                if let out = f.outputImage { img = out }
            }
            img = applyVignette(to: img, intensity: 0.6, extent: extent)
        case "faded", "instant":
            if let f = CIFilter(name: "CIPhotoEffectFade") {
                f.setValue(img, forKey: kCIInputImageKey)
                if let out = f.outputImage { img = out }
            }
        case "beauty":
            img = applyColorControls(to: img, brightness: 0.035, contrast: 0.94, saturation: 1.06)
            img = applyTempTint(to: img, neutral: CIVector(x: 5800, y: 0), target: CIVector(x: 6300, y: 0))
        case "glow":
            img = applyColorControls(to: img, brightness: 0.055, contrast: 0.92, saturation: 1.12)
            if let f = CIFilter(name: "CIBloom") {
                f.setValue(img, forKey: kCIInputImageKey)
                f.setValue(8.0, forKey: kCIInputRadiusKey)
                f.setValue(0.28, forKey: kCIInputIntensityKey)
                if let out = f.outputImage { img = out.cropped(to: extent) }
            }
        case "golden":
            img = applySepia(to: img, intensity: 0.25)
            img = applyColorControls(to: img, brightness: 0.03, contrast: 1.05, saturation: 1.32)
            img = applyTempTint(to: img, neutral: CIVector(x: 5000, y: 0), target: CIVector(x: 6500, y: 0))
            img = applyVignette(to: img, intensity: 0.55, extent: extent)
        case "pastel":
            img = applyColorControls(to: img, brightness: 0.07, contrast: 0.88, saturation: 0.78)
            img = applyTempTint(to: img, neutral: CIVector(x: 6200, y: -12), target: CIVector(x: 5900, y: 12))
        case "rose":
            img = applyColorControls(to: img, brightness: 0.035, contrast: 1.0, saturation: 1.15)
            img = applyHueAdjust(to: img, angle: 0.14)
            img = applyTempTint(to: img, neutral: CIVector(x: 6000, y: -15), target: CIVector(x: 6200, y: 10))
        case "mint":
            img = applyColorControls(to: img, brightness: 0.04, contrast: 1.0, saturation: 1.10)
            img = applyHueAdjust(to: img, angle: -0.31)
        case "cinema":
            img = applyColorControls(to: img, brightness: -0.02, contrast: 1.14, saturation: 1.08)
            img = applyTempTint(to: img, neutral: CIVector(x: 6300, y: 0), target: CIVector(x: 5600, y: 0))
            img = applyVignette(to: img, intensity: 0.7, extent: extent)
            img = applyCinemaBars(to: img, fraction: 0.09, extent: extent)
        case "neon":
            img = applyColorControls(to: img, brightness: -0.02, contrast: 1.16, saturation: 1.48)
            img = applyHueAdjust(to: img, angle: -0.21)
            img = applyVignette(to: img, intensity: 0.6, extent: extent)
        case "camcorder":
            img = applySepia(to: img, intensity: 0.15)
            img = applyColorControls(to: img, brightness: 0.015, contrast: 1.10, saturation: 1.28)
            img = applyVignette(to: img, intensity: 0.6, extent: extent)
        default:
            break
        }
        return img.cropped(to: extent)
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
                // Keep only the most recent 4 shots in temporary RAM
                if self.shotStore.count > 4 {
                    let drop = self.shotStore.keys.sorted().dropLast(4)
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
                if #available(iOS 13.0, *) {
                    if pOut.maxPhotoQualityPrioritization.rawValue >= AVCapturePhotoOutput.QualityPrioritization.speed.rawValue {
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
                        self.stateLock.unlock()
                        if let buf = pb, let j = self.jpegData(from: buf, maxSide: 2400, quality: 0.92) {
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
                return
            }

            // External UVC capture card path: grab latest video frame directly
            self.stateLock.lock()
            let pb = self.latestBuffer
            self.stateLock.unlock()
            if let buf = pb, let j = self.jpegData(from: buf, maxSide: 2400, quality: 0.92) {
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

        // Normalize orientation & downscale > 2400px on a background thread so canvas drawing is fast and upright
        DispatchQueue.global(qos: .userInitiated).async {
            if let img = UIImage(data: raw) {
                let maxSide: CGFloat = 2400
                let w = img.size.width
                let h = img.size.height
                let scale = max(w, h) > maxSide ? (maxSide / max(w, h)) : 1.0
                let tw = max(1, Int((w * scale).rounded()))
                let th = max(1, Int((h * scale).rounded()))

                if img.imageOrientation == .up && scale == 1.0 {
                    completion(.success((raw, Int(w), Int(h))))
                    return
                }
                let fmt = UIGraphicsImageRendererFormat()
                fmt.scale = 1.0
                let renderer = UIGraphicsImageRenderer(size: CGSize(width: tw, height: th), format: fmt)
                let rendered = renderer.image { _ in
                    img.draw(in: CGRect(x: 0, y: 0, width: tw, height: th))
                }
                if let normalized = rendered.jpegData(compressionQuality: 0.92) {
                    completion(.success((normalized, tw, th)))
                    return
                }
            }
            completion(.success((raw, 0, 0)))
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
