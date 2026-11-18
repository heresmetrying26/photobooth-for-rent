import Foundation
import ImageCaptureCore
import UIKit

/**
 * photobooth4u — iOS / iPadOS ImageCaptureCore DSLR USB Bridge + Local Booth Server
 *
 * Implements the camera bridge on 127.0.0.1:17321 & [::1]:17321 (http://localhost:17321),
 * matching Android's UsbCameraHelper.kt, desktop/lib/camera-mac.mjs, and camera-worker.ps1.
 *
 * Supported USB PTP camera families:
 *   - Canon EOS (DSLRs, M-series, R-series: 0x9114/0x9115/0x9116/0x9153/0x910F/0x9128)
 *   - Nikon (D-series & Z-series: 0x9201/0x9202/0x9203/0x90C0/0x90C1/0x90C7/0x90C8/0x9207)
 *   - Sony Alpha (A7/A7R/A7S/A7C/A9/A1/A6xxx/ZV in PC Remote: 0x9201/0x9202/0x9205/0x9207/0x9209)
 *   - Olympus / OM System (when OMD PTP ops 0x9481/0x9484/0x9485 are exposed)
 *   - Standard PTP fallback (Fujifilm / Pentax / Ricoh / Panasonic / Generic PTP 0x100E + didAdd)
 *
 * Also serves the bundled booth HTML at /booth and caches /bg/ & /img/ static assets so the
 * WKWebView runs inside a secure http://localhost:17321 origin with zero Mixed Content issues.
 */
class IccCameraHelper: NSObject, ICDeviceBrowserDelegate, ICCameraDeviceDelegate, ICCameraDeviceDownloadDelegate {

    static let shared = IccCameraHelper()
    static let port: UInt16 = 17321
    static let remoteOrigin = "https://photobooth4u.netlify.app"

    private let browser = ICDeviceBrowser()
    private let devicesLock = NSLock()
    private var availableCameras: [ICCameraDevice] = []

    // Serial queue for ALL PTP operations so USB commands never race or deadlock main thread
    private let camQueue = DispatchQueue(label: "com.photobooth4u.camera.ptp", qos: .userInitiated)

    // HTTP server sockets (IPv4 127.0.0.1 + IPv6 ::1 so both localhost and 127.0.0.1 connect immediately)
    private var serverSock4: Int32 = -1
    private var serverSock6: Int32 = -1
    private var isRunning = false
    private let acceptQueue4 = DispatchQueue(label: "com.photobooth4u.http4", qos: .userInitiated)
    private let acceptQueue6 = DispatchQueue(label: "com.photobooth4u.http6", qos: .userInitiated)

    // Booth HTML served at /booth (set by ViewController)
    private let boothLock = NSLock()
    private var boothHtmlData: Data = Data()

    // Camera log ring buffer (for /camera/diag)
    private let logLock = NSLock()
    private var logBuf: [String] = []

    // Non-blocking status/capture guard so live-view frame polls skip cleanly while shooting
    private let stateLock = NSLock()
    private var capturingNow = false
    private var cachedOpen = false
    private var cachedName = ""
    private var lastBrowserKickAt: UInt64 = 0

    private func setCapturing(_ on: Bool) {
        stateLock.lock()
        capturingNow = on
        stateLock.unlock()
    }

    private func isCapturing() -> Bool {
        stateLock.lock()
        let v = capturingNow
        stateLock.unlock()
        return v
    }

    private func setCachedCamera(open: Bool, name: String) {
        stateLock.lock()
        cachedOpen = open
        cachedName = name
        stateLock.unlock()
    }

    private func getCachedCamera() -> (open: Bool, name: String) {
        stateLock.lock()
        let v = (cachedOpen, cachedName)
        stateLock.unlock()
        return v
    }

    // ---- Open camera state (accessed only on camQueue) ----
    private enum Brand: String {
        case none = ""
        case nikon = "nikon"
        case canon = "canon"
        case sony = "sony"
        case olympus = "olympus"
        case generic = "generic"
    }

    private var activeCamera: ICCameraDevice?
    private var brand: Brand = .none
    private var vendorExt: UInt32 = 0
    private var camMaker: String = ""
    private var camModel: String = ""
    private var camName: String = ""
    private var ops = Set<UInt16>()
    private var props = Set<UInt16>()
    private var live = false
    private var setupNote = ""
    private var diag = ""
    private var lastShutterMs = 0
    private var classicNikon = false
    private var shotFocus = ""

    // Canon state
    private var eosVals: [UInt16: UInt32] = [:]
    private var canonNew: [(handle: UInt32, event: UInt32, format: UInt16, size: UInt32)] = []
    private var liveAt: UInt64 = 0
    private var keepAt: UInt64 = 0
    private var recoverNext = false
    private var pollAt: UInt64 = 0
    private var gotFrame = false

    // Nikon state
    private var nikonEventAt: UInt64 = 0
    private var afRefusedLogged = false

    // Sony state
    private var sonyAt: UInt64 = 0
    private var sonyVer = 2
    private var sonyDestBlocked = false

    // Generic PTP / didAdd capture waiter
    private let genericLock = NSLock()
    private var genericWaiters: [((Result<Data, Error>) -> Void)] = []
    private var genericPendingFile: ICCameraFile?

    // PTP Transaction ID
    private var ptpTid: UInt32 = 1

    // PTP Constants
    private let PTP_OK: UInt16 = 0x2001
    private let PTP_BUSY: UInt16 = 0x2019
    private let PTP_INVALID_HANDLE: UInt16 = 0x2009
    private let PTP_ACCESS_DENIED: UInt16 = 0x200F
    private let PTP_SESSION_OPEN: UInt16 = 0x201E
    private let PTP_NOTREADY: UInt16 = 0xA102
    private let NIKON_AF_FAILED: UInt16 = 0xA002
    private let NIKON_NOT_IN_LV: UInt16 = 0xA00B
    private let NIKON_OPS: Set<UInt16> = [0x90C0, 0x90C1, 0x90C7, 0x90C8, 0x9201, 0x9202, 0x9203, 0x9207]
    private let SONY_LV: UInt32 = 0xFFFFC002
    private let SONY_PHOTO: UInt32 = 0xFFFFC001
    private let SDRAM_HANDLE: UInt32 = 0xFFFF0001
    private let SONY_HINT = "On the camera set PC Remote: On (MENU > Network > PC Remote Function) and USB Connection to PC Remote (MENU > Setup > USB), switch the camera off and on, unplug and replug the USB cable, then try again."

    private struct CamErr: Error {
        let code: String
        let message: String
        let transient: Bool
        init(_ code: String, _ message: String, transient: Bool = false) {
            self.code = code
            self.message = message
            self.transient = transient
        }
        var httpStatus: Int {
            switch code {
            case "GONE": return 410
            case "NOCAMERA": return 404
            default: return 409
            }
        }
    }

    private struct PtpResp {
        let code: UInt16
        let params: [UInt32]
        let data: Data
    }

    override init() {
        super.init()
        browser.delegate = self
        if #available(iOS 15.2, *),
           let combined = ICDeviceTypeMask(rawValue: ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue) {
            browser.browsedDeviceTypeMask = combined
        }
    }

    // MARK: - Logging & Time

    private func nowMs() -> UInt64 {
        return UInt64(Date().timeIntervalSince1970 * 1000.0)
    }

    private func hex(_ v: UInt16) -> String {
        return String(format: "0x%04X", v)
    }

    private func hex32(_ v: UInt32) -> String {
        return String(format: "0x%X", v)
    }

    private func log(_ msg: String) {
        let df = DateFormatter()
        df.dateFormat = "HH:mm:ss"
        let line = "\(df.string(from: Date())) \(msg)"
        logLock.lock()
        logBuf.append(line)
        if logBuf.count > 80 { logBuf.removeFirst(logBuf.count - 80) }
        logLock.unlock()
        print("[PBCam] \(msg)")
    }

    private func recentLogs() -> [String] {
        logLock.lock()
        let copy = Array(logBuf.suffix(40))
        logLock.unlock()
        return copy
    }

    // MARK: - Booth HTML Injection

    func setBoothHtml(_ html: String) {
        boothLock.lock()
        boothHtmlData = Data(html.utf8)
        boothLock.unlock()
    }

    // MARK: - Lifecycle

    private func kickBrowser(force: Bool = false) {
        let now = nowMs()
        stateLock.lock()
        let elapsed = now >= lastBrowserKickAt ? (now - lastBrowserKickAt) : 10000
        if !force && elapsed < 6000 {
            stateLock.unlock()
            return
        }
        lastBrowserKickAt = now
        stateLock.unlock()

        DispatchQueue.main.async {
            self.browser.requestContentsAuthorization { _ in }
            self.browser.requestControlAuthorization { _ in }
            if force {
                self.browser.stop()
                self.browser.start()
                self.log("Restarted USB camera browser scan")
            } else if !self.browser.isBrowsing {
                self.browser.start()
            }
        }
    }

    private func rescanCamerasIfEmpty(waitMs: Int = 1100) -> [ICCameraDevice] {
        devicesLock.lock()
        var cams = availableCameras
        devicesLock.unlock()
        guard cams.isEmpty else { return cams }

        kickBrowser(force: true)
        let deadline = nowMs() + UInt64(max(200, waitMs))
        while nowMs() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
            devicesLock.lock()
            cams = availableCameras
            devicesLock.unlock()
            if !cams.isEmpty { break }
        }
        return cams
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true

        DispatchQueue.main.async {
            self.browser.requestContentsAuthorization { _ in }
            self.browser.requestControlAuthorization { _ in }
            self.browser.start()
        }

        startHttpServers()
        log("Camera helper & local booth server listening on port \(IccCameraHelper.port)")
    }

    func stop() {
        isRunning = false
        DispatchQueue.main.async {
            self.browser.stop()
        }
        if serverSock4 >= 0 { close(serverSock4); serverSock4 = -1 }
        if serverSock6 >= 0 { close(serverSock6); serverSock6 = -1 }
        camQueue.async { [weak self] in
            self?.closeCamera()
        }
    }

    func ensureListening() {
        guard isRunning else {
            start()
            return
        }
        var restartNeeded = false
        for s in [serverSock4, serverSock6] where s >= 0 {
            var err: Int32 = 0
            var len = socklen_t(MemoryLayout<Int32>.size)
            if getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0 {
                restartNeeded = true
            }
        }
        if serverSock4 < 0 && serverSock6 < 0 { restartNeeded = true }
        if restartNeeded {
            if serverSock4 >= 0 { close(serverSock4); serverSock4 = -1 }
            if serverSock6 >= 0 { close(serverSock6); serverSock6 = -1 }
            startHttpServers()
            log("Restarted local booth HTTP listeners after background suspend")
        }
    }

    // MARK: - ICDeviceBrowserDelegate

    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        guard let camera = device as? ICCameraDevice else { return }
        devicesLock.lock()
        if !availableCameras.contains(where: { $0.uuidString == camera.uuidString }) {
            availableCameras.append(camera)
            log("Discovered USB camera: \(camera.name ?? "Unknown") (\(camera.productKind ?? ""))")
        }
        devicesLock.unlock()
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        guard let camera = device as? ICCameraDevice else { return }
        devicesLock.lock()
        availableCameras.removeAll(where: { $0.uuidString == camera.uuidString })
        devicesLock.unlock()

        camQueue.async { [weak self] in
            guard let self = self else { return }
            if self.activeCamera?.uuidString == camera.uuidString {
                self.log("Active camera disconnected")
                self.resetCameraState()
            }
        }
    }

    // MARK: - ICDeviceDelegate

    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {}
    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}
    func didRemove(_ device: ICDevice) {
        devicesLock.lock()
        availableCameras.removeAll(where: { $0.uuidString == device.uuidString })
        devicesLock.unlock()
        camQueue.async { [weak self] in
            if self?.activeCamera?.uuidString == device.uuidString {
                self?.resetCameraState()
            }
        }
    }
    func deviceDidBecomeReady(_ device: ICDevice) {
        log("Camera ready: \(device.name ?? "")")
    }
    func device(_ device: ICDevice, didEncounterError error: Error?) {
        log("Camera error: \(error?.localizedDescription ?? "unknown")")
    }

    // MARK: - ICCameraDeviceDelegate & ICCameraDeviceDownloadDelegate

    func cameraDevice(_ camera: ICCameraDevice, didRemove items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveThumbnail thumbnail: CGImage?, for item: ICCameraItem, error: Error?) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveMetadata metadata: [AnyHashable: Any]?, for item: ICCameraItem, error: Error?) {}
    func cameraDevice(_ camera: ICCameraDevice, didRenameItems items: [ICCameraItem]) {}
    func cameraDeviceDidChangeCapability(_ camera: ICCameraDevice) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceivePTPEvent eventData: Data) {}
    func deviceDidBecomeReady(withCompleteContentCatalog device: ICCameraDevice) {}
    func cameraDeviceDidRemoveAccessRestriction(_ device: ICDevice) {}
    func cameraDeviceDidEnableAccessRestriction(_ device: ICDevice) {}

    func cameraDevice(_ camera: ICCameraDevice, didAdd items: [ICCameraItem]) {
        genericLock.lock()
        let hasWaiter = !genericWaiters.isEmpty
        genericLock.unlock()
        guard hasWaiter else { return }

        // Pick JPEG over RAW if multiple files arrive (e.g. Fujifilm / Olympus / Pentax RAW+JPEG)
        let files = items.compactMap { $0 as? ICCameraFile }
        guard !files.isEmpty else { return }
        let picked = files.first(where: {
            let n = ($0.name ?? "").lowercased()
            return n.hasSuffix(".jpg") || n.hasSuffix(".jpeg")
        }) ?? files[0]

        let tempDir = FileManager.default.temporaryDirectory
        let filename = picked.name ?? "capture-\(nowMs()).jpg"
        let options: [ICDownloadOption: Any] = [
            .downloadsDirectoryURL: tempDir,
            .saveAsFilename: filename,
            .overwrite: true
        ]
        genericLock.lock()
        genericPendingFile = picked
        genericLock.unlock()

        camera.requestDownloadFile(
            picked,
            options: options,
            downloadDelegate: self,
            didDownloadSelector: #selector(didDownloadFile(_:error:options:contextInfo:)),
            contextInfo: nil
        )
    }

    @objc func didDownloadFile(
        _ file: ICCameraFile,
        error: Error?,
        options: [String: Any],
        contextInfo: UnsafeMutableRawPointer?
    ) {
        genericLock.lock()
        let waiters = genericWaiters
        genericWaiters.removeAll()
        genericPendingFile = nil
        genericLock.unlock()
        guard !waiters.isEmpty else { return }

        if let err = error {
            for w in waiters { w(.failure(CamErr("CAPTURE", err.localizedDescription))) }
            return
        }

        let tempDir = FileManager.default.temporaryDirectory
        let downloadedUrl = tempDir.appendingPathComponent(file.name ?? "capture.jpg")
        if let data = try? Data(contentsOf: downloadedUrl), !data.isEmpty {
            try? FileManager.default.removeItem(at: downloadedUrl)
            for w in waiters { w(.success(data)) }
        } else {
            for w in waiters { w(.failure(CamErr("CAPTURE", "Downloaded file is empty or missing."))) }
        }
    }

    // MARK: - Low-Level PTP Transport over ImageCaptureCore

    private func ptpContainer(code: UInt16, params: [UInt32] = []) -> Data {
        let tid = ptpTid
        ptpTid &+= 1

        var data = Data()
        func putU32(_ v: UInt32) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        func putU16(_ v: UInt16) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        putU32(UInt32(12 + params.count * 4))
        putU16(1) // PTP_USB_CONTAINER_COMMAND
        putU16(code)
        putU32(tid)
        for p in params { putU32(p) }
        return data
    }

    private func le16(_ d: Data, _ o: Int) -> UInt16 {
        guard o >= 0, o + 2 <= d.count else { return 0 }
        return UInt16(d[o]) | (UInt16(d[o + 1]) << 8)
    }

    private func le32(_ d: Data, _ o: Int) -> UInt32 {
        guard o >= 0, o + 4 <= d.count else { return 0 }
        return UInt32(d[o])
            | (UInt32(d[o + 1]) << 8)
            | (UInt32(d[o + 2]) << 16)
            | (UInt32(d[o + 3]) << 24)
    }

    private func isCameraStillPresent(_ cam: ICCameraDevice) -> Bool {
        devicesLock.lock()
        let ok = availableCameras.contains(where: { $0.uuidString == cam.uuidString })
        devicesLock.unlock()
        return ok
    }

    private func parsePtpCompletion(_ d1: Data, _ d2: Data) -> (resp: Data, data: Data) {
        // Apple's closure is documented as (responseData, ptpResponseData, error) where ptpResponseData
        // is the 12+ byte Type-3 Response Container, though some callers treat d1 as response.
        // Detect the Type-3 Response Container explicitly by container length + type == 3.
        let d2IsResp = d2.count >= 12 && le32(d2, 0) == UInt32(d2.count) && le16(d2, 4) == 3
        let d1IsResp = d1.count >= 12 && le32(d1, 0) == UInt32(d1.count) && le16(d1, 4) == 3
        if d2IsResp { return (d2, d1) }
        if d1IsResp { return (d1, d2) }
        if !d2.isEmpty { return (d2, d1) }
        return (d1, d2)
    }

    private func transact(_ code: UInt16, params: [UInt32] = [], outData: Data? = nil, timeout: TimeInterval = 15.0) throws -> PtpResp {
        guard let cam = activeCamera else {
            throw CamErr("GONE", "The camera isn't connected.")
        }

        let cmd = ptpContainer(code: code, params: params)
        let sema = DispatchSemaphore(value: 0)
        var outResp = Data()
        var outPayload = Data()
        var outErr: Error?

        cam.requestSendPTPCommand(cmd, outData: outData) { [weak self] d1, d2, err in
            if let err = err {
                outErr = err
            } else if let self = self {
                let parsed = self.parsePtpCompletion(d1, d2)
                outResp = parsed.resp
                outPayload = parsed.data
            }
            sema.signal()
        }

        if sema.wait(timeout: .now() + timeout) == .timedOut {
            if !isCameraStillPresent(cam) {
                resetCameraState()
                throw CamErr("GONE", "The camera was unplugged.")
            }
            throw CamErr("ERROR", "Camera timed out on \(hex(code)).", transient: true)
        }

        if let err = outErr {
            if !isCameraStillPresent(cam) {
                resetCameraState()
                throw CamErr("GONE", "The camera was unplugged.")
            }
            throw CamErr("ERROR", err.localizedDescription, transient: true)
        }

        var respCode: UInt16 = 0
        var respParams: [UInt32] = []
        if outResp.count >= 12 && le16(outResp, 4) == 3 {
            respCode = le16(outResp, 6)
            var off = 12
            while off + 4 <= outResp.count {
                respParams.append(le32(outResp, off))
                off += 4
            }
        } else if outResp.count >= 2 {
            respCode = le16(outResp, 0)
        } else {
            respCode = PTP_OK
        }

        return PtpResp(code: respCode, params: respParams, data: outPayload)
    }

    @discardableResult
    private func op(_ code: UInt16, _ params: UInt32...) throws -> UInt16 {
        return try transact(code, params: params).code
    }

    private func opP(_ code: UInt16, _ params: UInt32...) throws -> PtpResp {
        return try transact(code, params: params)
    }

    private func opRead(_ code: UInt16, _ params: UInt32..., timeout: TimeInterval = 30.0) throws -> PtpResp {
        return try transact(code, params: params, outData: nil, timeout: timeout)
    }

    @discardableResult
    private func opWrite(_ code: UInt16, data: Data, _ params: UInt32...) throws -> UInt16 {
        return try transact(code, params: params, outData: data).code
    }

    private func has(_ opCode: UInt16) -> Bool {
        return ops.contains(opCode) || (brand == .nikon && NIKON_OPS.contains(opCode))
    }

    // MARK: - PTP Dataset Reader

    private class Rd {
        let b: Data
        var p = 0
        init(_ b: Data) { self.b = b }

        func u8() -> UInt8 {
            guard p < b.count else { p += 1; return 0 }
            let v = b[p]
            p += 1
            return v
        }

        func u16() -> UInt16 {
            guard p + 2 <= b.count else { p += 2; return 0 }
            let v = UInt16(b[p]) | (UInt16(b[p + 1]) << 8)
            p += 2
            return v
        }

        func u32() -> UInt32 {
            guard p + 4 <= b.count else { p += 4; return 0 }
            let v = UInt32(b[p]) | (UInt32(b[p + 1]) << 8) | (UInt32(b[p + 2]) << 16) | (UInt32(b[p + 3]) << 24)
            p += 4
            return v
        }

        func str() -> String {
            let n = Int(u8())
            guard n > 0 else { return "" }
            var chars: [UInt16] = []
            for _ in 0..<n {
                let c = u16()
                if c != 0 { chars.append(c) }
            }
            return String(utf16CodeUnits: chars, count: chars.count)
        }

        func u16Set() -> Set<UInt16> {
            let n = Int(u32())
            guard n >= 0 && n <= 8192 else { return [] }
            var s = Set<UInt16>()
            for _ in 0..<n { s.insert(u16()) }
            return s
        }

        func value(type: UInt16) -> String? {
            switch type {
            case 1: return String(Int8(bitPattern: u8()))
            case 2: return String(u8())
            case 3: return String(Int16(bitPattern: u16()))
            case 4: return String(u16())
            case 5: return String(Int32(bitPattern: u32()))
            case 6: return String(u32())
            case 0xFFFF: return str()
            default: return nil
            }
        }
    }

    // MARK: - Device Info & Brand Detection

    private func readInfo() throws -> Bool {
        let r = try opRead(0x1001)
        if r.code != PTP_OK && r.code != 0 { return false }
        let rd = Rd(r.data)
        _ = rd.u16()               // StandardVersion
        vendorExt = rd.u32()       // VendorExtensionID
        _ = rd.u16()               // VendorExtensionVersion
        _ = rd.str()               // VendorExtensionDesc
        _ = rd.u16()               // FunctionalMode
        ops = rd.u16Set()          // OperationsSupported
        _ = rd.u16Set()            // EventsSupported
        props = rd.u16Set()        // DevicePropertiesSupported
        _ = rd.u16Set()            // CaptureFormats
        _ = rd.u16Set()            // ImageFormats
        camMaker = rd.str()
        camModel = rd.str()

        let makerLow = (camMaker + " " + (activeCamera?.name ?? "")).lowercased()
        if vendorExt == 0x0A || makerLow.contains("nikon") {
            brand = .nikon
        } else if vendorExt == 0x0B || makerLow.contains("canon") {
            brand = .canon
        } else if vendorExt == 0x11 || makerLow.contains("sony") {
            brand = .sony
        } else if makerLow.contains("olympus") || makerLow.contains("om digital") || makerLow.contains("om system") || ops.contains(0x9481) {
            brand = .olympus
        } else {
            brand = .generic
        }

        let sampleOps: [UInt16] = brand == .canon ? [0x9114, 0x9115, 0x9116, 0x9153, 0x9110, 0x910F, 0x9128] :
                                  brand == .sony ? [0x9201, 0x9202, 0x9205, 0x9207, 0x9209] :
                                  brand == .olympus ? [0x9481, 0x9484, 0x9485] :
                                  [0x9201, 0x9203, 0x90C0, 0x90C7, 0x90C8, 0x100E]
        let listed = sampleOps.filter { ops.contains($0) }.map { String(format: "%04X", $0) }.joined(separator: " ")
        diag = "vendor \(vendorExt), \(ops.count) ops, lists: \(listed.isEmpty ? "none" : listed)"
        log("DeviceInfo \(camMaker) \(camModel) [\(brand.rawValue)]: \(diag)")
        return true
    }

    // MARK: - Open / Close

    private func resetCameraState() {
        activeCamera = nil
        brand = .none
        vendorExt = 0
        camMaker = ""
        camModel = ""
        camName = ""
        ops = []
        props = []
        live = false
        setupNote = ""
        diag = ""
        eosVals.removeAll()
        canonNew.removeAll()
        gotFrame = false
        sonyAt = 0
        sonyVer = 2
        sonyDestBlocked = false
        shotFocus = ""
        setCachedCamera(open: false, name: "")
    }

    private func closeCamera() {
        if let cam = activeCamera {
            do {
                if brand == .nikon && live {
                    _ = try? op(0x9202)
                } else if brand == .canon {
                    if live { _ = try? setEos(0xD1B0, 0) }
                    _ = try? op(0x9115, 0)
                    _ = try? op(0x9114, 0)
                } else if brand == .sony {
                    try? sonyReleaseButtons()
                }
            }
            let sema = DispatchSemaphore(value: 0)
            cam.requestCloseSession(options: nil) { _ in sema.signal() }
            _ = sema.wait(timeout: .now() + 2.0)
        }
        resetCameraState()
    }

    private func listCamerasJson() -> [String: Any] {
        devicesLock.lock()
        let cams = availableCameras
        devicesLock.unlock()
        if cams.isEmpty {
            kickBrowser(force: false)
        }

        var list: [[String: Any]] = []
        for cam in cams {
            let n = cam.name ?? "USB camera"
            let low = n.lowercased()
            let isCam = !low.contains("card reader") && !low.contains("storage")
            list.append([
                "name": n,
                "maker": "",
                "model": cam.productKind ?? "",
                "camera": isCam
            ])
        }

        var openFlag = false
        var openName = ""
        var lag = 0
        if isCapturing() {
            let cached = getCachedCamera()
            openFlag = cached.open
            openName = cached.name
        } else {
            camQueue.sync {
                if let ac = activeCamera, isCameraStillPresent(ac) {
                    openFlag = true
                    openName = camName
                    lag = lastShutterMs
                } else if activeCamera != nil {
                    resetCameraState()
                }
            }
        }

        return [
            "ok": true,
            "devices": list,
            "open": openFlag,
            "name": openName,
            "shutterMs": lag
        ]
    }

    private func openCamera(fresh: Bool, classic: Bool) throws -> [String: Any] {
        classicNikon = classic
        if fresh { recoverNext = true }

        if let ac = activeCamera {
            if !fresh && isCameraStillPresent(ac) {
                do {
                    try alive()
                    return infoJson()
                } catch {
                    closeCamera()
                }
            } else {
                closeCamera()
            }
        }

        var cams = rescanCamerasIfEmpty(waitMs: 1100)
        if cams.isEmpty {
            devicesLock.lock()
            cams = availableCameras
            devicesLock.unlock()
        }

        guard !cams.isEmpty else {
            throw CamErr("NOCAMERA", "No camera found. Plug your camera into the iPad using a USB data cable and powered USB-C hub, switch it on (Wi-Fi OFF on Canon M50), and allow camera access if iPadOS asks.")
        }

        var lastErr: CamErr?
        for cam in cams {
            do {
                return try openOne(cam)
            } catch let e as CamErr {
                log("Skipped \(cam.name ?? "camera"): \(e.message)")
                if lastErr == nil || (lastErr?.code == "NOCAMERA" && e.code != "NOCAMERA") {
                    lastErr = e
                }
                closeCamera()
            } catch {
                closeCamera()
            }
        }

        if let e = lastErr { throw e }
        throw CamErr("NOCAMERA", "No supported camera found on USB.")
    }

    private func openOne(_ cam: ICCameraDevice) throws -> [String: Any] {
        activeCamera = cam
        cam.delegate = self

        func ensureSessionOpen(retryOnFail: Bool) throws {
            if !cam.hasOpenSession {
                let sema = DispatchSemaphore(value: 0)
                var openErr: Error?
                cam.requestOpenSession(options: nil) { err in
                    openErr = err
                    sema.signal()
                }
                let timedOut = sema.wait(timeout: .now() + 8.0) == .timedOut
                if timedOut || openErr != nil {
                    if retryOnFail {
                        log("Session open failed/timed out, closing stale session and retrying")
                        let cs = DispatchSemaphore(value: 0)
                        cam.requestCloseSession(options: nil) { _ in cs.signal() }
                        _ = cs.wait(timeout: .now() + 2.0)
                        Thread.sleep(forTimeInterval: 0.4)
                        try ensureSessionOpen(retryOnFail: false)
                        return
                    }
                    if timedOut {
                        throw CamErr("ERROR", "The camera took too long to open. Unplug and replug the USB cable, then try again.")
                    }
                    if let err = openErr {
                        throw CamErr("ERROR", "Failed to open camera: \(err.localizedDescription)")
                    }
                }
            }
        }

        try ensureSessionOpen(retryOnFail: true)

        var gotInfo = (try? readInfo()) ?? false
        if !gotInfo {
            let cs = DispatchSemaphore(value: 0)
            cam.requestCloseSession(options: nil) { _ in cs.signal() }
            _ = cs.wait(timeout: .now() + 2.0)
            Thread.sleep(forTimeInterval: 0.4)
            try ensureSessionOpen(retryOnFail: false)
            gotInfo = try readInfo()
        }
        guard gotInfo else {
            throw CamErr("UNSUPPORTED", "The camera did not return USB device info.")
        }

        setupNote = ""
        live = false
        switch brand {
        case .nikon:
            let cleanModel = camModel.replacingOccurrences(of: "NIKON", with: "").replacingOccurrences(of: "Nikon", with: "").trimmingCharacters(in: .whitespaces)
            camName = (camMaker.lowercased().hasPrefix("nikon") ? "Nikon " : "\(camMaker) ") + cleanModel
            log("Opened \(camName)")
            try prepareNikon()
        case .canon:
            let cleanModel = camModel.replacingOccurrences(of: "Canon", with: "", options: .caseInsensitive).trimmingCharacters(in: .whitespaces)
            camName = "Canon \(cleanModel)".trimmingCharacters(in: .whitespaces)
            log("Opened \(camName)")
            try prepareCanon()
        case .sony:
            camName = sonyName(camModel)
            log("Opened \(camName)")
            try prepareSony()
        case .olympus:
            camName = "\(camMaker) \(camModel)".trimmingCharacters(in: .whitespaces)
            if camName.isEmpty { camName = cam.name ?? "Olympus camera" }
            log("Opened \(camName)")
            try prepareOlympus()
        case .generic, .none:
            let rawName = "\(camMaker) \(camModel)".trimmingCharacters(in: .whitespaces)
            camName = rawName.isEmpty ? (cam.name ?? "USB Camera") : rawName
            log("Opened \(camName) (generic PTP)")
            try prepareGeneric()
        }
        setCachedCamera(open: true, name: camName)
        return infoJson()
    }

    private func infoJson() -> [String: Any] {
        return [
            "ok": true,
            "name": camName,
            "model": camModel,
            "maker": camMaker,
            "brand": brand.rawValue,
            "vendor": vendorExt,
            "liveview": live,
            "battery": batteryNow(),
            "note": setupNote,
            "diag": diag
        ]
    }

    private func alive() throws {
        if brand == .nikon {
            _ = try op(0x90C8)
            return
        }
        if brand == .canon && has(0x911D) {
            _ = try op(0x911D)
            return
        }
        _ = try opRead(0x1001)
    }

    private func needCamera() throws {
        guard let cam = activeCamera, isCameraStillPresent(cam) else {
            resetCameraState()
            throw CamErr("GONE", "The camera isn't connected.")
        }
    }

    private func batteryNow() -> Int {
        if brand == .canon {
            if pollAt == 0 || nowMs() - pollAt > 2000 {
                try? canonPoll()
            }
            if let v = eosVals[0xD111] {
                switch v {
                case 1: return 10
                case 6: return 25
                case 2: return 50
                case 5: return 75
                case 3: return 100
                case 7...100: return Int(v)
                default: return -1
                }
            }
            return -1
        }
        if brand == .sony || !props.contains(0x5001) { return -1 }
        if let r = try? opRead(0x1015, 0x5001), r.code == PTP_OK, let b = r.data.first {
            return b <= 100 ? Int(b) : -1
        }
        return -1
    }

    // MARK: - Booth Dispatch Methods (called on camQueue)

    private func setLive(on: Bool) throws {
        try needCamera()
        if !on {
            switch brand {
            case .canon: try canonLiveOff()
            case .sony: live = false
            case .nikon: try nikonLiveOff()
            case .olympus, .generic, .none: live = false
            }
        } else if !live {
            switch brand {
            case .canon: try canonLiveOn()
            case .sony: live = true
            case .nikon: try nikonLiveOn()
            case .olympus: live = true
            case .generic, .none:
                if ops.contains(0x902C) || ops.contains(0x900C) { live = true }
                else { throw CamErr("LIVEVIEW", "\(camName) does not stream live view over USB PTP. For live view + photos on this camera model, use an HDMI capture card or USB Webcam mode.") }
            }
        }
    }

    private var frameFails = 0

    private func fetchFrame() throws -> Data? {
        try needCamera()
        do {
            let f: Data?
            switch brand {
            case .canon: f = try canonFrame()
            case .sony: f = try sonyFrame()
            case .nikon: f = try nikonFrame()
            case .olympus: f = try olympusFrame()
            case .generic, .none: f = try genericFrame()
            }
            frameFails = 0
            return f
        } catch let e as CamErr {
            if e.transient && frameFails < 5 {
                frameFails += 1
                return nil
            }
            throw e
        }
    }

    private func capturePhoto(classic: Bool) throws -> Data {
        classicNikon = classic
        shotFocus = ""
        try needCamera()
        switch brand {
        case .canon:
            defer { live = false }
            return try canonCapture()
        case .sony:
            return try sonyCapture()
        case .nikon:
            return try nikonCapture()
        case .olympus:
            return try olympusCapture()
        case .generic, .none:
            return try genericCapture()
        }
    }

    private func autoFocus(classic: Bool) throws -> Bool {
        classicNikon = classic
        try needCamera()
        switch brand {
        case .nikon:
            if !live { try nikonLiveOn() }
            if has(0x90C1) && classic {
                let afR = try op(0x90C1)
                let t0 = nowMs()
                while nowMs() - t0 < 1400 {
                    Thread.sleep(forTimeInterval: 0.08)
                    _ = try? nikonEvents()
                }
                return afR == PTP_OK
            }
            if has(0x90C1) { return try nikonAf() }
            return true
        case .canon:
            let afR = try opRetry(0x9128, 1, 0)
            Thread.sleep(forTimeInterval: 0.8)
            _ = try? opRetry(0x9129, 1)
            return afR == PTP_OK
        default:
            return true
        }
    }

    // MARK: - Shared JPEG & Download Helpers

    private func jpegStart(_ d: Data) -> Int {
        let limit = min(d.count - 1, 4096)
        guard limit > 0 else { return -1 }
        for k in 0..<limit {
            if d[k] == 0xFF && d[k + 1] == 0xD8 { return k }
        }
        return -1
    }

    private func cutJpeg(_ d: Data, from start: Int) -> Data {
        var end = d.count
        if d.count >= start + 4 {
            var k = d.count - 2
            while k > start {
                if d[k] == 0xFF && d[k + 1] == 0xD9 {
                    end = k + 2
                    break
                }
                k -= 1
            }
        }
        return d.subdata(in: start..<end)
    }

    private func downloadObject(handle: UInt32, sizeIn: UInt32, notes: inout [String], pieceOp: UInt16 = 0x101B) throws -> Data {
        var size = sizeIn
        if size == 0 {
            do {
                let oi = try opRead(0x1008, handle)
                if oi.code == PTP_OK && oi.data.count >= 12 {
                    size = le32(oi.data, 8)
                }
                notes.append("info \(hex(oi.code)) \(size) B")
            } catch let e as CamErr {
                if e.code == "GONE" { throw e }
                notes.append("info failed \(e.message)")
            }
        }

        var img = Data()
        var r: UInt16 = 0
        do {
            let g = try opRead(0x1009, handle, timeout: 35.0)
            r = g.code
            img = g.data
            notes.append("get \(hex(r)) \(img.count) B")
        } catch let e as CamErr {
            if e.code == "GONE" { throw e }
            notes.append("get failed \(e.message)")
        }

        if (r != PTP_OK || img.count < 4 || (size > 0 && img.count < Int(size))) && size > 0 {
            var collected = Data()
            collected.reserveCapacity(Int(size))
            var off: UInt32 = 0
            var pr: UInt16 = 0
            while off < size {
                let chunkLen = min(UInt32(1_048_576), size - off)
                let g = try opRead(pieceOp, handle, off, chunkLen, timeout: 25.0)
                pr = g.code
                if pr != PTP_OK || g.data.isEmpty { break }
                collected.append(g.data)
                off += UInt32(g.data.count)
            }
            notes.append("pieces \(hex(pieceOp)) \(hex(pr)) \(off) B")
            if off >= size {
                img = collected
                r = PTP_OK
            }
        }
        return r == PTP_OK ? img : Data()
    }

    // MARK: - Nikon (D-series & Z-series)

    private struct PropDesc {
        let type: UInt16
        let current: String
        let choices: [String]
    }

    private func waitNikonReady(ms: UInt64) throws -> Bool {
        let t0 = nowMs()
        while nowMs() - t0 < ms {
            let r = try op(0x90C8)
            if r == PTP_OK { return true }
            if r != PTP_BUSY { return false }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return false
    }

    private func propDesc(_ code: UInt16) throws -> PropDesc? {
        let r = try opRead(0x1014, UInt32(code))
        guard r.code == PTP_OK && r.data.count >= 6 else { return nil }
        let rd = Rd(r.data)
        _ = rd.u16()
        let type = rd.u16()
        _ = rd.u8()
        _ = rd.value(type: type) // factory default
        guard let cur = rd.value(type: type) else { return nil }
        let form = rd.u8()
        var choices: [String] = []
        if form == 2 {
            let n = Int(rd.u16())
            for _ in 0..<n {
                if let v = rd.value(type: type) { choices.append(v) }
            }
        }
        return PropDesc(type: type, current: cur, choices: choices)
    }

    private func setProp(_ code: UInt16, type: UInt16, value: String) throws -> Bool {
        var data = Data()
        if type == 0xFFFF {
            let u16s = Array(value.utf16) + [0]
            data.append(UInt8(clamping: u16s.count))
            for ch in u16s {
                var le = ch.littleEndian
                withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
            }
        } else {
            let v = Int64(value) ?? 0
            let size = (type == 1 || type == 2) ? 1 : (type == 3 || type == 4) ? 2 : 4
            for k in 0..<size {
                data.append(UInt8((v >> (8 * k)) & 0xFF))
            }
        }
        let r = try opWrite(0x1016, data: data, UInt32(code))
        _ = try? waitNikonReady(ms: 2000)
        return r == PTP_OK
    }

    private func widthOf(_ s: String) -> Int {
        guard let x = s.firstIndex(of: "x") else { return 0 }
        return Int(s[..<x]) ?? 0
    }

    private func prepareNikon() throws {
        do {
            if let rm = try propDesc(0xD10B), rm.current != "1" {
                if try setProp(0xD10B, type: rm.type, value: "1") {
                    setupNote += "Records to camera memory. "
                    log("Recording media -> camera memory (SDRAM)")
                }
            }
        } catch let e as CamErr {
            if e.code == "GONE" { throw e }
        }

        if !classicNikon {
            do {
                if props.contains(0x5004), let q = try propDesc(0x5004) {
                    let cur = Int(q.current) ?? 0
                    if cur != 2 && q.choices.contains("2") {
                        if try setProp(0x5004, type: q.type, value: "2") {
                            setupNote += "Set to JPEG Fine. "
                            log("Image quality \(q.current) -> JPEG Fine")
                        }
                    }
                }
                if props.contains(0x5003), let s = try propDesc(0x5003), s.type == 0xFFFF && s.choices.count > 1 {
                    var best: String?
                    var bestW = Int.max
                    for c in s.choices {
                        let w = widthOf(c)
                        if w >= 2900 && w < bestW { best = c; bestW = w }
                    }
                    if let best = best, best != s.current {
                        if try setProp(0x5003, type: s.type, value: best) {
                            setupNote += "Photo size \(best). "
                            log("Image size \(s.current) -> \(best)")
                        }
                    }
                }
            } catch let e as CamErr {
                if e.code == "GONE" { throw e }
            }
        }
        live = false
        afRefusedLogged = false
    }

    private func nikonLiveOn() throws {
        if live { return }
        let r = try op(0x9201)
        log("StartLiveView: \(hex(r))")
        if r != PTP_OK && r != NIKON_NOT_IN_LV && r != PTP_BUSY {
            throw CamErr("LIVEVIEW", "The camera refused live view (\(hex(r))). Put an SD card in the camera, close its menu, turn the mode dial to P and extend the kit lens, then try again.")
        }
        _ = try? waitNikonReady(ms: 6000)
        live = true
    }

    private func nikonLiveOff() throws {
        if !live { return }
        var r: UInt16 = 0
        for _ in 0..<14 {
            do { r = try op(0x9202) }
            catch let e as CamErr {
                if e.code == "GONE" { throw e }
                r = 0xFFFF
            }
            if r == PTP_OK || r == NIKON_NOT_IN_LV {
                live = false
                break
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        if !live { _ = try? waitNikonReady(ms: 3000) }
    }

    private func nikonEvents() throws -> [UInt32] {
        var handles: [UInt32] = []
        guard has(0x90C7) else { return handles }
        let r = try opRead(0x90C7)
        guard r.code == PTP_OK && r.data.count >= 2 else { return handles }
        let cnt = Int(le16(r.data, 0))
        var o = 2
        for _ in 0..<cnt {
            if o + 6 > r.data.count { break }
            let code = le16(r.data, o)
            let p = le32(r.data, o + 2)
            if code == 0x4002 || code == 0xC101 {
                handles.append(p != 0 ? p : SDRAM_HANDLE)
            }
            o += 6
        }
        return handles
    }

    private func nikonFrame() throws -> Data? {
        if !live { try nikonLiveOn() }
        if nowMs() - nikonEventAt > 3000 && has(0x90C7) {
            nikonEventAt = nowMs()
            _ = try? nikonEvents()
        }
        let t0 = nowMs()
        var restarts = 0
        var last: UInt16 = 0
        while nowMs() - t0 < 2500 {
            let r = try opRead(0x9203)
            last = r.code
            if r.code == PTP_OK {
                let s = jpegStart(r.data)
                if s >= 0 { return cutJpeg(r.data, from: s) }
            } else if r.code == NIKON_NOT_IN_LV && restarts < 2 {
                restarts += 1
                live = false
                try nikonLiveOn()
                continue
            }
            Thread.sleep(forTimeInterval: 0.04)
        }
        if last != PTP_OK && last != PTP_BUSY && last != 0 {
            throw CamErr("LIVEVIEW", "The camera sends no live view (\(hex(last))). Put an SD card in the camera, close its menu and turn the mode dial to P.")
        }
        return nil
    }

    private func nikonAf() throws -> Bool {
        let t0 = nowMs()
        for attempt in 0..<2 {
            let one = nowMs()
            let r = try op(0x90C1)
            if r == PTP_OK {
                Thread.sleep(forTimeInterval: 0.25)
                let rem = max(UInt64(300), 2000 &- min(2000, nowMs() - t0))
                _ = try? waitNikonReady(ms: rem)
                _ = try? nikonEvents()
                log("Autofocus\(attempt > 0 ? " (second try)" : ""): done in \(nowMs() - t0) ms")
                return true
            }
            log("Autofocus: \(hex(r)) after \(nowMs() - one) ms")
            if r != NIKON_AF_FAILED && r != PTP_BUSY { return true }
            if attempt == 0 && nowMs() - one < 200 {
                if !afRefusedLogged {
                    afRefusedLogged = true
                    log("Autofocus refused at once (lens on MF?)")
                }
                return true
            }
            if nowMs() - t0 > 900 { break }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    private func nikonCapture() throws -> Data {
        let t0 = nowMs()
        if live && has(0x90C1) {
            if classicNikon {
                if let afR = try? op(0x90C1), afR == PTP_OK {
                    Thread.sleep(forTimeInterval: 1.2)
                    _ = try? waitNikonReady(ms: 2000)
                }
            } else {
                _ = try? nikonAf()
            }
        }
        _ = try? nikonEvents()

        var r: UInt16
        if has(0x90C0) {
            r = try op(0x90C0, 0xFFFFFFFF)
        } else {
            r = try op(0x100E, 0, 0)
        }
        if r == NIKON_AF_FAILED && has(0x9207) {
            log("Out of focus; shooting without autofocus")
            shotFocus = "miss"
            r = try op(0x9207, 0xFFFFFFFF, 1)
            if r != PTP_OK { r = try op(0x9207, 0xFFFFFFFF, 0) }
        }
        if r == PTP_BUSY {
            _ = try? waitNikonReady(ms: 3000)
            r = try op(0x90C0, 0xFFFFFFFF)
        }
        if r != PTP_OK {
            if r == NIKON_AF_FAILED {
                throw CamErr("FOCUS", "The camera couldn't focus, so it didn't take the photo. Point it at something with detail, or set the lens to MF (manual focus).")
            }
            if r == 0xA00A || r == 0xA009 {
                throw CamErr("CAPTURE", "The camera can't take a photo right now (\(hex(r))). Check the memory card isn't full or locked.")
            }
            throw CamErr("CAPTURE", "The camera refused the photo (\(hex(r))). Check the mode dial isn't on video and the camera's menu is closed.")
        }

        _ = try? waitNikonReady(ms: 10000)
        var handles: [UInt32] = []
        let e0 = nowMs()
        while nowMs() - e0 < 8000 {
            for h in try nikonEvents() where !handles.contains(h) { handles.append(h) }
            if !handles.isEmpty {
                lastShutterMs = Int(min(nowMs() - t0, 10000))
                log("Shutter lag \(lastShutterMs) ms")
                Thread.sleep(forTimeInterval: 0.15)
                for h in try nikonEvents() where !handles.contains(h) { handles.append(h) }
                break
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        if handles.isEmpty { handles.append(SDRAM_HANDLE) }

        var pick = handles[0]
        if handles.count > 1 {
            for h in handles {
                if let oi = try? opRead(0x1008, h), oi.code == PTP_OK && oi.data.count > 6 && le16(oi.data, 4) == 0x3801 {
                    pick = h
                    break
                }
            }
        }
        var notes = ["handles " + handles.map { hex32($0) }.joined(separator: ",")]
        let img = try downloadObject(handle: pick, sizeIn: 0, notes: &notes)
        log("Photo download: \(notes.joined(separator: "; "))")
        if img.count < 4 {
            throw CamErr("CAPTURE", "The photo didn't come through from the camera (\(notes.joined(separator: "; "))).")
        }
        if !(img[0] == 0xFF && img[1] == 0xD8) {
            throw CamErr("CAPTURE", "The camera saved a RAW photo. Set Image quality to JPEG on the camera.")
        }
        log("Photo \(img.count / 1024) KB in \(nowMs() - t0) ms")
        return img
    }

    // MARK: - Canon EOS (DSLRs, M-series, R-series)

    private func opRetry(_ code: UInt16, _ params: UInt32...) throws -> UInt16 {
        let t0 = nowMs()
        while true {
            let r = try transact(code, params: params).code
            if (r != PTP_BUSY && r != PTP_NOTREADY) || nowMs() - t0 > 3000 { return r }
            Thread.sleep(forTimeInterval: 0.06)
        }
    }

    @discardableResult
    private func setEos(_ prop: UInt32, _ val: UInt32) throws -> UInt16 {
        var b = Data()
        for num in [UInt32(12), prop, val] {
            var le = num.littleEndian
            withUnsafeBytes(of: &le) { b.append(contentsOf: $0) }
        }
        let t0 = nowMs()
        var r: UInt16 = 0
        while true {
            r = try opWrite(0x9110, data: b)
            if (r != PTP_BUSY && r != PTP_NOTREADY) || nowMs() - t0 > 3000 { break }
            Thread.sleep(forTimeInterval: 0.06)
        }
        log("Set \(hex32(prop)) = \(val): \(hex(r))")
        if r == PTP_OK { eosVals[UInt16(prop & 0xFFFF)] = val }
        return r
    }

    private func canonPoll() throws {
        pollAt = nowMs()
        let r = try opRead(0x9116)
        guard r.code == PTP_OK && !r.data.isEmpty else { return }
        let d = r.data
        var off = 0
        while off + 8 <= d.count {
            let size = Int(le32(d, off))
            let type = le32(d, off + 4)
            if size < 8 || off + size > d.count || type == 0 { break }
            let end = off + size
            if type == 0xC189 && size >= 16 {
                eosVals[UInt16(le32(d, off + 8) & 0xFFFF)] = le32(d, off + 12)
            } else if (type == 0xC181 || type == 0xC1A7) && size >= 12 {
                let fmt = off + 0x12 <= end ? le16(d, off + 0x10) : 0
                let sz = off + 0x20 <= end ? le32(d, off + 0x1C) : 0
                canonNew.append((le32(d, off + 8), type, fmt, sz))
            } else if type == 0xC186 && size >= 12 {
                let fmt = off + 0x0E <= end ? le16(d, off + 0x0C) : 0
                let sz = off + 0x18 <= end ? le32(d, off + 0x14) : 0
                canonNew.append((le32(d, off + 8), type, fmt, sz))
            }
            off = end
        }
    }

    private func canonSingleShot() throws {
        guard let dm = eosVals[0xD106] else { return }
        let isTimer = dm == 0x07 || (dm >= 0x10 && dm <= 0x1F)
        guard isTimer else { return }
        do {
            let r = try setEos(0xD106, 0)
            setupNote += (r == PTP_OK) ? "Camera was on self-timer; set to single shot. " : "Camera is on self-timer: switch its drive mode to single shot. "
        } catch let e as CamErr {
            if e.code == "GONE" { throw e }
        }
    }

    private func prepareCanon() throws {
        eosVals.removeAll()
        canonNew.removeAll()
        gotFrame = false
        pollAt = 0

        if recoverNext {
            recoverNext = false
            _ = try? op(0x9115, 0)
            _ = try? op(0x9114, 0)
            log("Reset Canon remote mode before connecting")
            Thread.sleep(forTimeInterval: 0.6)
        }

        var r = try opRetry(0x9114, 1)
        log("SetRemoteMode: \(hex(r))")
        var r2 = try opRetry(0x9115, 1)
        log("SetEventMode: \(hex(r2))")
        if r != PTP_OK && r2 != PTP_OK {
            // EOS M/R cameras sometimes refuse SetRemoteMode until a stale event/remote session is cleared
            _ = try? op(0x9115, 0)
            _ = try? op(0x9114, 0)
            Thread.sleep(forTimeInterval: 0.45)
            r = try opRetry(0x9114, 1)
            r2 = try opRetry(0x9115, 1)
            log("SetRemoteMode retry: \(hex(r)) / \(hex(r2))")
        }
        if r != PTP_OK && r2 != PTP_OK {
            throw CamErr("UNSUPPORTED", "The \(camName) didn't accept remote control (\(hex(r))). Turn Wi-Fi/Bluetooth OFF on the camera, set mode dial to P, Tv, Av or M, and use a USB data cable.")
        }

        try canonPoll()
        _ = try readInfo()
        try canonPoll()

        if !has(0x9153) {
            throw CamErr("UNSUPPORTED", "The \(camName) doesn't send live view over USB.")
        }
        if !has(0x910F) && !has(0x9128) {
            throw CamErr("UNSUPPORTED", "The \(camName) doesn't take photos over USB.")
        }

        lastShutterMs = 0
        try canonSingleShot()
        keepAt = nowMs()
    }

    // pollEveryMs: the live view loop passes a longer gap, because each news read is an extra USB round
    // trip made between frames (a visible hitch). Photo calls keep the quick 2 s default.
    private func canonKeep(pollEveryMs: UInt64 = 2000) throws {
        if pollAt == 0 || nowMs() - pollAt > pollEveryMs { try canonPoll() }
        if nowMs() - keepAt > 10000 {
            _ = try? op(0x911D)
            keepAt = nowMs()
        }
    }

    private func canonLiveOn() throws {
        var started = false
        if has(0x9151) {
            let ri = try opRetry(0x9151)
            log("InitiateViewfinder: \(hex(ri))")
            started = (ri == PTP_OK)
        }
        if let mode = eosVals[0xD1B1], mode != 1 {
            _ = try setEos(0xD1B1, 1)
        }
        var r = try setEos(0xD1B0, 2)
        if r == PTP_BUSY || r == PTP_NOTREADY {
            Thread.sleep(forTimeInterval: 0.25)
            r = try setEos(0xD1B0, 2)
        }
        if r != PTP_OK && !started && (r == PTP_BUSY || r == PTP_NOTREADY) {
            live = false
            return
        }
        if r != PTP_OK && !started {
            throw CamErr("LIVEVIEW", "The camera refused live view (\(hex(r))). On the camera: Menu, Live View shoot: Enable; close the menu; mode dial on P, Tv, Av or M. Then try again.")
        }
        live = true
        gotFrame = false
        liveAt = nowMs()
    }

    private func canonLiveOff() throws {
        if !live { return }
        do {
            _ = try setEos(0xD1B0, 0)
            if has(0x9152) { _ = try op(0x9152) }
        } catch let e as CamErr {
            if e.code == "GONE" { throw e }
        }
        live = false
    }

    private func eosJpeg(_ d: Data) -> Data? {
        guard d.count >= 12 else { return nil }
        var off = 0
        while off + 8 <= d.count {
            let len = Int(le32(d, off))
            if len < 8 || off + len > d.count { break }
            if len > 12 && d[off + 8] == 0xFF && d[off + 9] == 0xD8 {
                return d.subdata(in: (off + 8)..<(off + len))
            }
            off += len
        }
        let st = jpegStart(d)
        return st < 0 ? nil : cutJpeg(d, from: st)
    }

    // Live view speed, written to the log about every 5 s so lag can be measured instead of guessed.
    private var fpsFrames: UInt64 = 0
    private var fpsBytes: UInt64 = 0
    private var fpsSince: UInt64 = 0
    private func canonFpsTick(_ bytes: Int) {
        let t = nowMs()
        if fpsSince == 0 || t < fpsSince || t - fpsSince > 60000 { fpsSince = t; fpsFrames = 0; fpsBytes = 0 }
        fpsFrames += 1
        fpsBytes += UInt64(bytes)
        let ms = t - fpsSince
        if ms >= 5000 {
            let fps = Double(fpsFrames) * 1000.0 / Double(ms)
            log("Canon live view: \(String(format: "%.1f", fps)) fps, \(fpsBytes / fpsFrames / 1024) KB/frame")
            fpsSince = t; fpsFrames = 0; fpsBytes = 0
        }
    }

    private func canonFrame() throws -> Data? {
        if !live {
            try canonLiveOn()
            if !live { Thread.sleep(forTimeInterval: 0.4); return nil }
        }
        let t0 = nowMs()
        var last: UInt16 = 0
        var kicked = false
        var rearmed = false

        while nowMs() - t0 < 3000 {
            try canonKeep(pollEveryMs: 6000)
            let r = try opRead(0x9153, 0x00100000)
            last = r.code
            if r.code == PTP_OK {
                if let j = eosJpeg(r.data) {
                    gotFrame = true
                    canonFpsTick(j.count)
                    return j
                }
            } else if r.code != PTP_BUSY && r.code != PTP_NOTREADY {
                if gotFrame && !rearmed {
                    rearmed = true
                    log("Canon live view stopped (\(hex(r.code))): restarting")
                    try? canonLiveOn()
                    Thread.sleep(forTimeInterval: 0.15)
                    continue
                }
                break
            }
            if !kicked && nowMs() - t0 > 1200 && nowMs() - liveAt > 4000 {
                kicked = true
                _ = try? setEos(0xD1B0, 2)
            }
            Thread.sleep(forTimeInterval: 0.015)   // camera not ready with the next picture: look again soon (was 50 ms)
        }
        if last != PTP_OK && last != PTP_BUSY && last != PTP_NOTREADY && last != 0 {
            throw CamErr("LIVEVIEW", "The camera sends no live view (\(hex(last))). On the camera: Menu, Live View shoot: Enable; close the menu; mode dial on P, Tv, Av or M.")
        }
        if !gotFrame && nowMs() - liveAt > 9000 {
            throw CamErr("LIVEVIEW", "The camera isn't sending live view. On the camera: Menu, Live View shoot: Enable (on the 60D / 70D it's in the red camera menu); close the menu; mode dial on P, Tv, Av or M. Then try again.")
        }
        return nil
    }

    private func canonShotError(_ r: UInt16, _ res: UInt32) -> CamErr {
        if res == 1 {
            return CamErr("FOCUS", "The camera couldn't focus, so it didn't take the photo. Point it at something with detail, or set the lens to MF (manual focus).")
        }
        if res == 7 || res == 3 {
            return CamErr("CAPTURE", "The camera can't save the photo (result \(res)). Check there's an SD card in the camera and it isn't full or locked.")
        }
        if r == PTP_BUSY || r == PTP_NOTREADY {
            return CamErr("CAPTURE", "The camera is busy (still saving the last photo?). Try again in a moment.")
        }
        let resNote = res != 0 ? ", result \(res)" : ""
        return CamErr("CAPTURE", "The camera refused the photo (\(hex(r))\(resNote)). Close the camera's menu, set the mode dial to P, Tv, Av or M (not video), and check the SD card.")
    }

    private func canonCapture() throws -> Data {
        let t0 = nowMs()
        try canonPoll()
        try canonSingleShot()
        canonNew.removeAll()

        let shutter = nowMs()
        if has(0x9128) {
            var r = try opRetry(0x9128, 3, 0)
            log("RemoteReleaseOn: \(hex(r))")
            if r == PTP_OK {
                _ = try? opRetry(0x9129, 3)
            } else {
                let h = try opRetry(0x9128, 1, 0)
                let f = (h == PTP_OK) ? try opRetry(0x9128, 2, 0) : h
                _ = try? opRetry(0x9129, 2)
                _ = try? opRetry(0x9129, 1)
                log("Half / full press: \(hex(h)) / \(hex(f))")
                r = f
            }
            if r != PTP_OK { throw canonShotError(r, 0) }
        } else {
            var a = try opP(0x910F)
            if a.code == PTP_BUSY || a.code == PTP_NOTREADY {
                Thread.sleep(forTimeInterval: 0.4)
                a = try opP(0x910F)
            }
            let res = a.params.first ?? 0
            log("RemoteRelease: \(hex(a.code)), result \(res)")
            if a.code != PTP_OK || res != 0 { throw canonShotError(a.code, res) }
        }

        var files: [(handle: UInt32, event: UInt32, format: UInt16, size: UInt32)] = []
        let ew = nowMs()
        var firstAt: Int64 = -1
        while nowMs() - ew < 15000 {
            try canonPoll()
            for o in canonNew where o.format != 0x3001 { files.append(o) }
            canonNew.removeAll()
            if !files.isEmpty && firstAt < 0 {
                firstAt = Int64(nowMs() - ew)
                lastShutterMs = Int(min(nowMs() - shutter, 10000))
                log("Shutter lag \(lastShutterMs) ms")
            }
            if firstAt >= 0 && Int64(nowMs() - ew) - firstAt > 350 { break }
            Thread.sleep(forTimeInterval: 0.08)
        }

        if files.isEmpty {
            throw CamErr("FOCUS", "The camera didn't take a photo. It may not have focused: point it at something with detail, or set the lens to MF (manual focus). Also check there's an SD card in the camera and it isn't full or locked.")
        }

        var notes = ["files " + files.map { "\(hex32($0.handle))/\(hex($0.format))" }.joined(separator: ",")]
        let jpegs = files.filter { $0.format == 0x3801 }
        let others = files.filter { $0.format != 0x3801 && $0.format != 0xB101 && $0.format != 0xB103 && $0.format != 0xB108 }
        let order = jpegs + others

        var img: Data?
        let pieceOp: UInt16 = has(0x9107) ? 0x9107 : 0x101B
        defer {
            for o in files where o.event == 0xC186 {
                _ = try? op(0x9117, o.handle)
            }
        }
        for o in order {
            let b = try downloadObject(handle: o.handle, sizeIn: o.size, notes: &notes, pieceOp: pieceOp)
            if b.count > 4 && b[0] == 0xFF && b[1] == 0xD8 {
                img = b
                break
            }
        }

        log("Photo download: \(notes.joined(separator: "; "))")
        guard let photo = img else {
            if order.isEmpty {
                throw CamErr("CAPTURE", "The camera saved a RAW photo. Set Image quality to JPEG on the camera (L, M or S; RAW + JPEG also works).")
            }
            throw CamErr("CAPTURE", "The photo didn't come through from the camera (\(notes.joined(separator: "; "))).")
        }
        log("Photo \(photo.count / 1024) KB in \(nowMs() - t0) ms")
        return photo
    }

    // MARK: - Sony Alpha (PC Remote)

    private func sonyName(_ model: String) -> String {
        let key = model.uppercased().replacingOccurrences(of: "SONY", with: "").trimmingCharacters(in: .whitespaces)
        let map: [String: String] = [
            "ILCE-7M2": "A7 II", "ILCE-7M3": "A7 III", "ILCE-7M4": "A7 IV", "ILCE-7M5": "A7 V",
            "ILCE-7RM2": "A7R II", "ILCE-7RM3": "A7R III", "ILCE-7RM3A": "A7R IIIA", "ILCE-7RM4": "A7R IV", "ILCE-7RM4A": "A7R IVA", "ILCE-7RM5": "A7R V",
            "ILCE-7SM2": "A7S II", "ILCE-7SM3": "A7S III", "ILCE-7C": "A7C", "ILCE-7CM2": "A7C II", "ILCE-7CR": "A7CR",
            "ILCE-9": "A9", "ILCE-9M2": "A9 II", "ILCE-9M3": "A9 III", "ILCE-1": "A1",
            "ILCE-6100": "A6100", "ILCE-6400": "A6400", "ILCE-6600": "A6600", "ILCE-6700": "A6700"
        ]
        return "Sony " + (map[key] ?? (key.isEmpty ? "camera" : key))
    }

    private func sonyProps() throws -> Data {
        let r = try opRead(0x9209)
        return r.code == PTP_OK ? r.data : Data()
    }

    private func sonyScalarSize(_ dtype: UInt16) -> Int {
        switch dtype {
        case 1, 2: return 1
        case 3, 4: return 2
        case 5, 6: return 4
        case 7, 8: return 8
        default: return 0
        }
    }

    private func sonyReadInt(_ d: Data, _ off: inout Int, _ dtype: UInt16) -> Int64? {
        let sz = sonyScalarSize(dtype)
        guard sz > 0, off + sz <= d.count else { return nil }
        let val: Int64
        switch dtype {
        case 1: val = Int64(Int8(bitPattern: d[off]))
        case 2: val = Int64(d[off])
        case 3: val = Int64(Int16(bitPattern: le16(d, off)))
        case 4: val = Int64(le16(d, off))
        case 5: val = Int64(Int32(bitPattern: le32(d, off)))
        case 6: val = Int64(le32(d, off))
        default:
            var u: UInt64 = 0
            for k in 0..<8 { u |= UInt64(d[off + k]) << (8 * k) }
            val = Int64(bitPattern: u)
        }
        off += sz
        return val
    }

    private func sonySkipValue(_ d: Data, _ off: inout Int, _ dtype: UInt16) -> Bool {
        if dtype == 0xFFFF {
            guard off < d.count else { return false }
            let n = Int(d[off]); off += 1
            guard off + n * 2 <= d.count else { return false }
            off += n * 2
            return true
        }
        if dtype >= 0x4001 && dtype <= 0x4008 {
            guard off + 4 <= d.count else { return false }
            let n = Int(le32(d, off)); off += 4
            let esz = sonyScalarSize(dtype & 0x0FFF)
            guard esz > 0, n >= 0, n <= 4096, off + n * esz <= d.count else { return false }
            off += n * esz
            return true
        }
        let sz = sonyScalarSize(dtype)
        guard sz > 0, off + sz <= d.count else { return false }
        off += sz
        return true
    }

    private func sonyPropInfo(_ d: Data, code: UInt16) -> (val: Int64, type: UInt16) {
        guard d.count >= 8 else { return (-1, 0) }
        let count = le32(d, 0)
        let reserved = le32(d, 4)
        guard reserved == 0, count <= 8192 else { return (-1, 0) }
        var off = 8
        var idx: UInt32 = 0
        while idx < count && off + 6 <= d.count {
            idx += 1
            let pcode = le16(d, off)
            let dtype = le16(d, off + 2)
            let getSet = d[off + 4]
            let enabled = d[off + 5]
            off += 6
            if getSet > 0x84 || enabled > 2 { break }
            if !sonySkipValue(d, &off, dtype) { break }
            var curVal: Int64? = nil
            if dtype >= 1 && dtype <= 8 {
                curVal = sonyReadInt(d, &off, dtype)
            } else if !sonySkipValue(d, &off, dtype) {
                break
            }
            if pcode == code { return (curVal ?? -1, dtype) }
            guard off < d.count else { break }
            let form = d[off]; off += 1
            if form == 1 {
                if !sonySkipValue(d, &off, dtype) || !sonySkipValue(d, &off, dtype) || !sonySkipValue(d, &off, dtype) { break }
            } else if form == 2 {
                guard off + 2 <= d.count else { break }
                let n1 = Int(le16(d, off)); off += 2
                for _ in 0..<n1 { if !sonySkipValue(d, &off, dtype) { return (-1, 0) } }
                if sonyVer >= 3 && off + 2 <= d.count {
                    let n2 = Int(le16(d, off)); off += 2
                    for _ in 0..<n2 { if !sonySkipValue(d, &off, dtype) { return (-1, 0) } }
                }
            } else if form != 0 {
                break
            }
        }
        return (-1, 0)
    }

    private func sonyVal(_ d: Data, code: UInt16) -> Int64 {
        return sonyPropInfo(d, code: code).val
    }

    private func sonyScalarData(_ value: UInt32, type: UInt16) -> Data {
        if type == 5 || type == 6 {
            return Data([
                UInt8(value & 0xFF),
                UInt8((value >> 8) & 0xFF),
                UInt8((value >> 16) & 0xFF),
                UInt8((value >> 24) & 0xFF)
            ])
        }
        if type == 1 || type == 2 {
            return Data([UInt8(value & 0xFF)])
        }
        return Data([UInt8(value & 0xFF), UInt8((value >> 8) & 0xFF)])
    }

    @discardableResult
    private func sonyButton(_ prop: UInt32, _ value: UInt16) throws -> UInt16 {
        let b = Data([UInt8(value & 0xFF), UInt8((value >> 8) & 0xFF)])
        return try opWrite(0x9207, data: b, prop)
    }

    private func sonyReleaseButtons() throws {
        do {
            _ = try sonyButton(0xD2C2, 1)
            _ = try sonyButton(0xD2C1, 1)
        } catch let e as CamErr {
            if e.code == "GONE" { throw e }
        } catch { }
    }

    private func sonyConnectPhase(_ phase: UInt32) throws -> UInt16 {
        var r: UInt16 = 0
        for _ in 0..<12 {
            r = try opRead(0x9201, phase, 0, 0).code
            if r == PTP_OK || r != PTP_BUSY { return r }
            Thread.sleep(forTimeInterval: 0.15)
        }
        return r
    }

    private func ensureSonySaveDest(_ p: Data) {
        let info = sonyPropInfo(p, code: 0xD222)
        let dest = info.val
        if dest == 0x01 { sonyDestBlocked = false; return }
        if sonyDestBlocked && dest != 0x10 { return }
        if dest >= 0 && dest != 0x01 {
            var ok = false
            for want in [UInt16(0x01), UInt16(0x11)] {
                let d = sonyScalarData(UInt32(want), type: info.type == 0 ? 4 : info.type)
                if let wr = try? opWrite(0x9205, data: d, 0xD222), wr == PTP_OK,
                   let checkProps = try? sonyProps(), sonyVal(checkProps, code: 0xD222) == Int64(want) {
                    ok = true
                    sonyDestBlocked = (want != 0x01)
                    setupNote += (want == 0x01) ? "Photos go to the iPad only (no memory card needed). " : "Photos go to the iPad and the card. "
                    log("Save destination -> \(hex(want))")
                    break
                }
            }
            if !ok {
                sonyDestBlocked = true
                log("Could not change save destination (it is \(dest)); photos may need a memory card")
            }
        }
    }

    private func prepareSony() throws {
        sonyAt = 0
        sonyDestBlocked = false
        let isA7M3 = camModel.uppercased().contains("ILCE-7M3")
        sonyVer = isA7M3 ? 3 : 2
        guard ops.contains(0x9201) && ops.contains(0x9202) else {
            throw CamErr("MODE", "The \(camName) is connected as a file-transfer drive, not for remote control. \(SONY_HINT) [\(diag)]")
        }

        let fail = { (what: String, r: UInt16) -> CamErr in
            return CamErr("MODE", "The \(self.camName) didn't accept remote control (\(what), \(self.hex(r))). \(self.SONY_HINT) [\(self.diag)]")
        }

        var r = try sonyConnectPhase(1)
        if r != PTP_OK { throw fail("connect 1", r) }
        r = try sonyConnectPhase(2)
        if r != PTP_OK { throw fail("connect 2", r) }

        var ver = sonyVer
        let preferV2 = !isA7M3 && camModel.uppercased().contains("6400")
        let vFirst: UInt32 = preferV2 ? 0xC8 : 0x12C
        let vSecond: UInt32 = preferV2 ? 0x12C : 0xC8
        for _ in 0..<20 {
            let x = try opRead(0x9202, vFirst, 1)
            if x.code == PTP_OK && x.data.count >= 2 {
                ver = (le16(x.data, 0) >= 0x12C) ? 3 : 2
                break
            }
            if x.code != PTP_BUSY {
                let x2 = try opRead(0x9202, vSecond, 1)
                if x2.code == PTP_OK && x2.data.count >= 2 {
                    ver = (le16(x2.data, 0) >= 0x12C) ? 3 : 2
                    break
                }
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        sonyVer = ver
        r = try sonyConnectPhase(3)
        if r != PTP_OK { throw fail("connect 3", r) }

        sonyAt = nowMs()
        diag += "; sony protocol \(ver)\(isA7M3 ? " (ILCE-7M3)" : "")"
        log("Sony connected, protocol \(ver)")

        // Clear any shutter button held down by an interrupted earlier session, then set remote priority.
        try sonyReleaseButtons()
        _ = try? opWrite(0x9205, data: Data([1]), 0xD25A)

        var p = Data()
        while nowMs() - sonyAt < 3000 {
            let np = try sonyProps()
            if !np.isEmpty { p = np }
            Thread.sleep(forTimeInterval: 0.15)
        }
        if p.isEmpty { p = try sonyProps() }

        let scm = sonyPropInfo(p, code: 0x5013)
        if scm.val >= 0 && scm.val != 1 {
            let d = sonyScalarData(1, type: scm.type == 0 ? 4 : scm.type)
            if let sr = try? opWrite(0x9205, data: d, 0x5013), sr == PTP_OK {
                log("Still capture mode \(scm.val) -> 1")
            }
        }

        ensureSonySaveDest(p)
        live = true
    }

    private func sonyJpeg(_ d: Data) -> Data? {
        guard d.count > 8 else { return nil }
        let off = le32(d, 0)
        let fsize = le32(d, 4)
        if off == 0 && fsize == 0 { return nil }
        var s = -1
        if off >= 8 && Int(off) + 1 < d.count && d[Int(off)] == 0xFF && d[Int(off) + 1] == 0xD8 {
            s = Int(off)
        }
        if s < 0 { s = jpegStart(d) }
        guard s >= 0 else { return nil }
        let limit = (fsize > 0 && UInt64(s) + UInt64(fsize) <= UInt64(d.count)) ? s + Int(fsize) : d.count
        guard limit >= s + 4 else { return nil }
        var e = -1
        var k = limit - 2
        while k > s {
            if d[k] == 0xFF && d[k + 1] == 0xD9 { e = k + 2; break }
            k -= 1
        }
        guard e > s, (e - s) <= 524_288 else { return nil }
        return d.subdata(in: s..<e)
    }

    private func sonyFrame() throws -> Data? {
        live = true
        let t0 = nowMs()
        var last: UInt16 = 0
        while nowMs() - t0 < 2500 {
            let lv = try opRead(0x1009, SONY_LV)
            last = lv.code
            if lv.code == PTP_OK {
                if lv.data.count > 8, let j = sonyJpeg(lv.data) { return j }
                Thread.sleep(forTimeInterval: 0.025)
                continue
            }
            if lv.code == PTP_INVALID_HANDLE {
                Thread.sleep(forTimeInterval: 0.05)
                continue
            }
            Thread.sleep(forTimeInterval: lv.code == PTP_ACCESS_DENIED ? 0.02 : 0.04)
        }
        if last != PTP_OK && last != PTP_BUSY && last != 0 && last != PTP_INVALID_HANDLE {
            throw CamErr("LIVEVIEW", "The camera sends no live view (\(hex(last))). Check it is in PC Remote mode, the lens cap is off and the camera's menu is closed.")
        }
        return nil
    }

    private func sonyInfo() throws -> (code: UInt16, fmt: UInt16, size: UInt32) {
        do {
            let oi = try opRead(0x1008, SONY_PHOTO)
            if oi.code == PTP_OK && oi.data.count >= 12 {
                return (oi.code, le16(oi.data, 4), le32(oi.data, 8))
            }
            return (oi.code, 0, 0)
        } catch let e as CamErr {
            if e.code == "GONE" { throw e }
            return (0, 0, 0)
        }
    }

    private func sonyCapture() throws -> Data {
        let t0 = nowMs()
        while sonyAt > 0 && nowMs() - sonyAt < 3000 {
            _ = try sonyProps()
            Thread.sleep(forTimeInterval: 0.15)
        }
        ensureSonySaveDest(try sonyProps())

        for _ in 0..<4 {
            if sonyVal(try sonyProps(), code: 0xD215) < 0x8000 { break }
            var junk: [String] = []
            _ = try? downloadObject(handle: SONY_PHOTO, sizeIn: 0, notes: &junk)
        }

        let shutter = nowMs()
        var r = try sonyButton(0xD2C1, 2)
        if r == PTP_OK { r = try sonyButton(0xD2C2, 2) }
        if r != PTP_OK {
            _ = try? sonyButton(0xD2C2, 1)
            _ = try? sonyButton(0xD2C1, 1)
            throw CamErr("CAPTURE", "The camera refused the shutter (\(hex(r))). Check the mode dial isn't on video, the camera's menu is closed and it is in PC Remote mode.")
        }

        defer {
            _ = try? sonyButton(0xD2C2, 1)
            _ = try? sonyButton(0xD2C1, 1)
        }

        if sonyVal(try sonyProps(), code: 0x500A) != 1 {
            let h0 = nowMs()
            while nowMs() - h0 < 1000 {
                let p = try sonyProps()
                let ff = sonyVal(p, code: 0xD213)
                let om = sonyVal(p, code: 0xD215)
                if ff == 2 || ff == 3 || om >= 0x8000 { break }
                Thread.sleep(forTimeInterval: 0.05)
            }
        }

        var mem: Int64 = -1
        let e0 = nowMs()
        while nowMs() - e0 < 15000 {
            mem = sonyVal(try sonyProps(), code: 0xD215)
            if mem >= 0x8000 {
                lastShutterMs = Int(min(nowMs() - shutter, 10000))
                log("Shutter lag \(lastShutterMs) ms")
                break
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        var notes = ["memory " + (mem < 0 ? "?" : String(format: "0x%llX", mem))]
        if mem < 0x8000 {
            throw CamErr("FOCUS", "The camera didn't take the photo. Point it at something with detail or set the lens to MF (manual focus), and check Still Img. Save Dest. is PC Only and Release w/o Card is Enable.")
        }

        var sawRaw = false
        var img = Data()
        for _ in 0..<3 {
            let info = try sonyInfo()
            notes.append("info \(hex(info.code)) fmt \(hex(info.fmt)) \(info.size) B")
            if info.fmt != 0 && info.fmt != 0x3801 {
                sawRaw = true
                var junk: [String] = []
                _ = try? downloadObject(handle: SONY_PHOTO, sizeIn: info.size, notes: &junk)
                log("Skipped non-JPEG Sony object \(hex(info.fmt)) (\(info.size) B)")
                let w0 = nowMs()
                var more = false
                while nowMs() - w0 < 4000 {
                    if sonyVal(try sonyProps(), code: 0xD215) >= 0x8000 { more = true; break }
                    Thread.sleep(forTimeInterval: 0.06)
                }
                if !more { break }
                continue
            }
            img = try downloadObject(handle: SONY_PHOTO, sizeIn: info.size, notes: &notes)
            if img.count >= 4 && img[0] == 0xFF && img[1] == 0xD8 { break }
            sawRaw = sawRaw || img.count >= 4
        }

        do {
            for _ in 0..<2 {
                if sonyVal(try sonyProps(), code: 0xD215) < 0x8000 { break }
                let info = try sonyInfo()
                if info.code != PTP_OK || (info.fmt != 0 && info.fmt != 0x3801) {
                    var junk: [String] = []
                    _ = try? downloadObject(handle: SONY_PHOTO, sizeIn: info.size, notes: &junk)
                    log("Drained trailing Sony object \(hex(info.fmt))")
                } else {
                    break
                }
            }
        } catch let e as CamErr {
            if e.code == "GONE" { throw e }
        } catch { }

        log("Photo download: \(notes.joined(separator: "; "))")
        if img.count < 4 {
            if sawRaw {
                throw CamErr("CAPTURE", "The camera saved a RAW photo. Set File Format to JPEG (or RAW + JPEG) on the camera.")
            }
            throw CamErr("CAPTURE", "The photo didn't come through from the camera (\(notes.joined(separator: "; "))).")
        }
        if !(img[0] == 0xFF && img[1] == 0xD8) {
            throw CamErr("CAPTURE", "The camera saved a RAW photo. Set File Format to JPEG (or RAW + JPEG) on the camera.")
        }
        log("Photo \(img.count / 1024) KB in \(nowMs() - t0) ms")
        return img
    }

    // MARK: - Olympus / OM System (OM-D PTP)

    private func prepareOlympus() throws {
        guard ops.contains(0x9481) || ops.contains(0x100E) else {
            throw CamErr("UNSUPPORTED", "\(camName) is not in USB Tether/PC Control mode. Set USB Mode to Tether/Control on the camera, or use an HDMI capture card.")
        }
        live = ops.contains(0x9484)
    }

    private func olympusFrame() throws -> Data? {
        guard ops.contains(0x9484) else {
            throw CamErr("LIVEVIEW", "\(camName) does not support USB live view (\(diag)). Use an HDMI capture card if live view is needed.")
        }
        let r = try opRead(0x9484)
        if r.code == PTP_OK {
            let s = jpegStart(r.data)
            if s >= 0 { return cutJpeg(r.data, from: s) }
        }
        return nil
    }

    private func olympusCapture() throws -> Data {
        if ops.contains(0x9481) {
            let data = try captureViaDidAdd {
                let r = try op(0x9481)
                if r != PTP_OK && r != PTP_BUSY {
                    throw CamErr("CAPTURE", "Olympus capture failed (\(hex(r))).")
                }
            }
            if data.count > 4 && data[0] == 0xFF && data[1] == 0xD8 { return data }
            if ops.contains(0x9485) {
                let direct = try opRead(0x9485)
                if direct.code == PTP_OK && direct.data.count > 4 { return direct.data }
            }
            return data
        }
        return try genericCapture()
    }

    // MARK: - Generic / Fujifilm / Pentax / Ricoh / Standard PTP Fallback

    private func prepareGeneric() throws {
        guard ops.contains(0x100E) || ops.contains(0x900C) else {
            throw CamErr("UNSUPPORTED", "Found \(camName), which does not expose remote capture over USB PTP (\(diag)). For Fujifilm/Panasonic/Insta360 cameras, switch the camera to USB Webcam / USB Streaming mode or use an HDMI capture card.")
        }
        live = ops.contains(0x902C) || ops.contains(0x900C)
    }

    private func genericFrame() throws -> Data? {
        if ops.contains(0x902C) {
            let r = try opRead(0x902C)
            if r.code == PTP_OK {
                let s = jpegStart(r.data)
                if s >= 0 { return cutJpeg(r.data, from: s) }
            }
            return nil
        }
        throw CamErr("LIVEVIEW", "\(camName) does not stream live view over standard USB PTP. Switch the camera to USB Webcam mode or use an HDMI capture card.")
    }

    private func captureViaDidAdd(_ trigger: () throws -> Void) throws -> Data {
        let sema = DispatchSemaphore(value: 0)
        var captured: Result<Data, Error>?
        genericLock.lock()
        genericWaiters.append { res in
            captured = res
            sema.signal()
        }
        genericLock.unlock()

        do {
            try trigger()
        } catch {
            genericLock.lock()
            genericWaiters.removeAll()
            genericLock.unlock()
            throw error
        }

        if sema.wait(timeout: .now() + 15.0) == .timedOut {
            genericLock.lock()
            genericWaiters.removeAll()
            genericLock.unlock()
            throw CamErr("TIMEOUT", "Shutter capture timed out waiting for the photo from \(camName).")
        }
        switch captured {
        case .success(let d): return d
        case .failure(let e): throw e
        case .none: throw CamErr("CAPTURE", "No photo returned from \(camName).")
        }
    }

    private func genericCapture() throws -> Data {
        guard ops.contains(0x100E) else {
            throw CamErr("UNSUPPORTED", "\(camName) does not support remote shutter capture over USB PTP.")
        }
        let data = try captureViaDidAdd {
            let r = try op(0x100E, 0, 0)
            if r != PTP_OK {
                throw CamErr("CAPTURE", "\(camName) refused shutter command (\(hex(r))).")
            }
        }
        guard data.count > 4 && data[0] == 0xFF && data[1] == 0xD8 else {
            throw CamErr("CAPTURE", "The camera saved a non-JPEG file (e.g. RAW). Set Image Quality to JPEG.")
        }
        return data
    }

    // MARK: - Dual-Stack Localhost HTTP Server (127.0.0.1:17321 & [::1]:17321)

    private func startHttpServers() {
        serverSock4 = bindIPv4(port: IccCameraHelper.port)
        if serverSock4 >= 0 {
            acceptQueue4.async { [weak self] in
                guard let self = self else { return }
                self.acceptLoop(sock: self.serverSock4, isIPv6: false)
            }
        }
        serverSock6 = bindIPv6(port: IccCameraHelper.port)
        if serverSock6 >= 0 {
            acceptQueue6.async { [weak self] in
                guard let self = self else { return }
                self.acceptLoop(sock: self.serverSock6, isIPv6: true)
            }
        }
    }

    private func bindIPv4(port: UInt16) -> Int32 {
        let s = socket(AF_INET, SOCK_STREAM, 0)
        guard s >= 0 else { return -1 }
        var opt: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let res = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard res >= 0, listen(s, 32) >= 0 else { close(s); return -1 }
        return s
    }

    private func bindIPv6(port: UInt16) -> Int32 {
        let s = socket(AF_INET6, SOCK_STREAM, 0)
        guard s >= 0 else { return -1 }
        var opt: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))
        var v6only: Int32 = 1
        setsockopt(s, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in6()
        addr.sin6_family = sa_family_t(AF_INET6)
        addr.sin6_port = port.bigEndian
        addr.sin6_addr = in6addr_loopback

        let res = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(s, $0, socklen_t(MemoryLayout<sockaddr_in6>.size))
            }
        }
        guard res >= 0, listen(s, 32) >= 0 else { close(s); return -1 }
        return s
    }

    private func acceptLoop(sock: Int32, isIPv6: Bool) {
        while isRunning && sock >= 0 {
            let clientSock: Int32
            if isIPv6 {
                var ca = sockaddr_in6()
                var cl = socklen_t(MemoryLayout<sockaddr_in6>.size)
                clientSock = withUnsafeMutablePointer(to: &ca) {
                    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(sock, $0, &cl) }
                }
            } else {
                var ca = sockaddr_in()
                var cl = socklen_t(MemoryLayout<sockaddr_in>.size)
                clientSock = withUnsafeMutablePointer(to: &ca) {
                    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(sock, $0, &cl) }
                }
            }
            guard clientSock >= 0 else { continue }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.handleClient(clientSock)
            }
        }
    }

    private func handleClient(_ clientSock: Int32) {
        defer { close(clientSock) }
        var noSigPipe: Int32 = 1
        setsockopt(clientSock, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        var rcvTv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(clientSock, SOL_SOCKET, SO_RCVTIMEO, &rcvTv, socklen_t(MemoryLayout<timeval>.size))
        var sndTv = timeval(tv_sec: 15, tv_usec: 0)
        setsockopt(clientSock, SOL_SOCKET, SO_SNDTIMEO, &sndTv, socklen_t(MemoryLayout<timeval>.size))

        var reqData = Data()
        var chunk = [UInt8](repeating: 0, count: 8192)
        var headerEndOffset = -1
        let sep = Data("\r\n\r\n".utf8)

        while reqData.count < 256 * 1024 {
            let n = read(clientSock, &chunk, chunk.count)
            if n <= 0 { break }
            reqData.append(chunk, count: n)
            if let range = reqData.range(of: sep) {
                headerEndOffset = range.upperBound
                break
            }
        }
        guard headerEndOffset > 0 else { return }

        let headerText = String(data: reqData.subdata(in: 0..<headerEndOffset), encoding: .utf8) ?? ""
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return }
        let parts = requestLine.components(separatedBy: " ")
        guard parts.count >= 2 else { return }

        var contentLength = 0
        var reqHeaders: [String: String] = [:]
        for h in lines.dropFirst() where !h.isEmpty {
            if let colon = h.firstIndex(of: ":") {
                let k = h[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                let v = h[h.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                reqHeaders[k] = v
                if k == "content-length" { contentLength = Int(v) ?? 0 }
            }
        }

        var bodyData = reqData.subdata(in: headerEndOffset..<reqData.count)
        if contentLength > 0 && contentLength < 10 * 1024 * 1024 {
            while bodyData.count < contentLength {
                let n = read(clientSock, &chunk, chunk.count)
                if n <= 0 { break }
                bodyData.append(chunk, count: n)
            }
            if bodyData.count > contentLength {
                bodyData = bodyData.subdata(in: 0..<contentLength)
            }
        }

        let method = parts[0]
        let fullPath = parts[1]
        let qParts = fullPath.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var normPath = String(qParts[0])
        if normPath.count > 1 && normPath.hasSuffix("/") { normPath.removeLast() }
        let query = qParts.count > 1 ? String(qParts[1]) : ""

        if method == "OPTIONS" {
            sendResponse(clientSock, status: 204, type: "text/plain", body: Data())
            return
        }

        route(clientSock: clientSock, method: method, path: normPath, query: query, headers: reqHeaders, body: bodyData)
    }

    private func route(clientSock: Int32, method: String, path: String, query: String, headers: [String: String], body: Data) {
        // 1. Serve the injected offline booth HTML at /booth or /
        if method == "GET" && (path == "/booth" || path == "/") {
            boothLock.lock()
            let html = boothHtmlData
            boothLock.unlock()
            sendResponse(clientSock, status: 200, type: "text/html; charset=utf-8", body: html)
            return
        }

        // 2. Proxy + cache static assets (/bg/, /img/, /camera-test/build/) when online
        if method == "GET" && (path.hasPrefix("/bg/") || path.hasPrefix("/img/") || path.hasPrefix("/camera-test/build/")) {
            serveCachedRemote(clientSock: clientSock, path: path, query: query)
            return
        }

        // 2b. Native AVFoundation camera captures & frames (http://localhost:17321/avcam/*)
        if method == "GET" && path.hasPrefix("/avcam/shot/") {
            let idStr = String(path.dropFirst("/avcam/shot/".count))
            if let sid = Int(idStr), let data = NativeCameraBridge.shared.takeShotData(id: sid), !data.isEmpty {
                sendResponse(clientSock, status: 200, type: "image/jpeg", body: data)
            } else {
                sendResponse(clientSock, status: 404, type: "text/plain", body: Data("Shot not found".utf8))
            }
            return
        }
        if method == "GET" && path == "/avcam/frame" {
            if let data = NativeCameraBridge.shared.latestFrameJpeg(), !data.isEmpty {
                sendResponse(clientSock, status: 200, type: "image/jpeg", body: data)
            } else {
                sendResponse(clientSock, status: 204, type: "image/jpeg", body: Data())
            }
            return
        }
        if method == "GET" && path.hasPrefix("/avcam/video/") {
            let idStr = String(path.dropFirst("/avcam/video/".count))
            if let vid = Int(idStr), let data = NativeCameraBridge.shared.takeVideoData(id: vid), !data.isEmpty {
                sendResponse(clientSock, status: 200, type: "video/mp4", body: data)
            } else {
                sendResponse(clientSock, status: 404, type: "text/plain", body: Data("Video not found".utf8))
            }
            return
        }

        // 3. Offline /api/* fast handler (allows /api/pay & /api/camdiag when online)
        if path.hasPrefix("/api/") {
            if PBLocal.shared.isOnline() && (path.hasPrefix("/api/pay") || path.hasPrefix("/api/camdiag") || path.hasPrefix("/api/updates")) {
                proxyRemoteApi(clientSock: clientSock, method: method, path: path, query: query, headers: headers, body: body)
            } else {
                sendJson(clientSock, status: 503, json: ["ok": false, "error": "offline"])
            }
            return
        }

        // 4. Camera helper endpoints
        switch (method, path) {
        case ("GET", "/status"):
            var camOpen = false
            var camTitle = ""
            if isCapturing() {
                let cached = getCachedCamera()
                camOpen = cached.open
                camTitle = cached.name
            } else {
                camQueue.sync {
                    camOpen = (activeCamera != nil)
                    camTitle = camName
                }
            }
            sendJson(clientSock, json: [
                "ok": true,
                "app": "photobooth4u-print-helper",
                "version": "\(AppLicence.shared.appVersion())-ios",
                "printers": [],
                "camera": [
                    "supported": true,
                    "open": camOpen,
                    "name": camTitle,
                    "free": false
                ]
            ])

        case ("GET", "/camera"):
            sendJson(clientSock, json: listCamerasJson())

        case ("GET", "/camera/diag"):
            devicesLock.lock()
            let cams = availableCameras
            devicesLock.unlock()
            let ptpList: [[String: Any]] = cams.map {
                ["id": $0.uuidString, "name": $0.name ?? "Camera", "camera": true]
            }
            var openFlag = false
            var openName = ""
            camQueue.sync {
                openFlag = (activeCamera != nil)
                openName = camName
            }
            sendJson(clientSock, json: [
                "ok": true,
                "lines": recentLogs(),
                "usb": ptpList,
                "ptp": ptpList,
                "open": openFlag,
                "name": openName
            ])

        case ("POST", "/camera/open"):
            let fresh = query.contains("fresh=1")
            let classic = query.contains("classic=1")
            do {
                let info = try camQueue.sync { try self.openCamera(fresh: fresh, classic: classic) }
                sendJson(clientSock, json: info)
            } catch let e as CamErr {
                sendJson(clientSock, status: e.httpStatus, json: ["ok": false, "code": e.code, "error": e.message])
            } catch {
                sendJson(clientSock, status: 409, json: ["ok": false, "code": "ERROR", "error": error.localizedDescription])
            }

        case ("POST", "/camera/live"):
            let on = !query.contains("on=0")
            do {
                try camQueue.sync { try self.setLive(on: on) }
                sendJson(clientSock, json: ["ok": true])
            } catch let e as CamErr {
                sendJson(clientSock, status: e.httpStatus, json: ["ok": false, "code": e.code, "error": e.message])
            } catch {
                sendJson(clientSock, status: 409, json: ["ok": false, "code": "ERROR", "error": error.localizedDescription])
            }

        case ("GET", "/camera/frame"):
            if isCapturing() {
                sendResponse(clientSock, status: 204, type: "image/jpeg", body: Data())
                return
            }
            do {
                let frame = try camQueue.sync { try self.fetchFrame() }
                if let f = frame, !f.isEmpty {
                    sendResponse(clientSock, status: 200, type: "image/jpeg", body: f)
                } else {
                    sendResponse(clientSock, status: 204, type: "image/jpeg", body: Data())
                }
            } catch let e as CamErr {
                sendJson(clientSock, status: e.httpStatus, json: ["ok": false, "code": e.code, "error": e.message])
            } catch {
                sendJson(clientSock, status: 409, json: ["ok": false, "code": "ERROR", "error": error.localizedDescription])
            }

        case ("POST", "/camera/capture"):
            let classic = query.contains("classic=1")
            setCapturing(true)
            defer { setCapturing(false) }
            do {
                var focusState = ""
                let img = try camQueue.sync { () -> Data in
                    let data = try self.capturePhoto(classic: classic)
                    focusState = self.shotFocus
                    return data
                }
                let extra = (focusState == "miss") ? ["X-PB-Focus: miss"] : []
                sendResponse(clientSock, status: 200, type: "image/jpeg", body: img, extraHeaders: extra)
            } catch let e as CamErr {
                sendJson(clientSock, status: e.httpStatus, json: ["ok": false, "code": e.code, "error": e.message])
            } catch {
                sendJson(clientSock, status: 409, json: ["ok": false, "code": "CAPTURE", "error": error.localizedDescription])
            }

        case ("POST", "/camera/af"):
            let classic = query.contains("classic=1")
            do {
                let ok = try camQueue.sync { try self.autoFocus(classic: classic) }
                sendJson(clientSock, json: ["ok": ok])
            } catch let e as CamErr {
                sendJson(clientSock, status: e.httpStatus, json: ["ok": false, "code": e.code, "error": e.message])
            } catch {
                sendJson(clientSock, status: 409, json: ["ok": false, "code": "ERROR", "error": error.localizedDescription])
            }

        case ("GET", "/camera/battery"):
            do {
                let b = try camQueue.sync { () -> Int in
                    try self.needCamera()
                    return self.batteryNow()
                }
                sendJson(clientSock, json: ["ok": true, "battery": b])
            } catch let e as CamErr {
                sendJson(clientSock, status: e.httpStatus, json: ["ok": false, "code": e.code, "error": e.message])
            } catch {
                sendJson(clientSock, status: 409, json: ["ok": false, "code": "ERROR", "error": error.localizedDescription])
            }

        case ("POST", "/camera/close"):
            camQueue.sync { self.closeCamera() }
            sendJson(clientSock, json: ["ok": true])

        case ("POST", "/camera/free"):
            sendJson(clientSock, json: ["ok": true])

        default:
            sendJson(clientSock, status: 404, json: ["ok": false, "code": "NOTFOUND", "error": "Not found"])
        }
    }

    // MARK: - Static Asset Cache & API Proxy

    private func mimeForAsset(_ path: String) -> String {
        let lower = path.lowercased()
        if lower.hasSuffix(".js") || lower.hasSuffix(".mjs") { return "application/javascript; charset=utf-8" }
        if lower.hasSuffix(".wasm") { return "application/wasm" }
        if lower.hasSuffix(".json") { return "application/json" }
        if lower.hasSuffix(".css") { return "text/css; charset=utf-8" }
        if lower.hasSuffix(".png") { return "image/png" }
        if lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") { return "image/jpeg" }
        if lower.hasSuffix(".svg") { return "image/svg+xml" }
        return "application/octet-stream"
    }

    private func serveCachedRemote(clientSock: Int32, path: String, query: String) {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var cacheRoot = appSupport.appendingPathComponent("pb_static")
        try? FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
        var rsrc = URLResourceValues()
        rsrc.isExcludedFromBackup = true
        try? cacheRoot.setResourceValues(rsrc)
        let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).replacingOccurrences(of: "..", with: "")
        let fileUrl = cacheRoot.appendingPathComponent(rel)

        if let cached = try? Data(contentsOf: fileUrl), !cached.isEmpty {
            sendResponse(clientSock, status: 200, type: mimeForAsset(path), body: cached)
            return
        }

        let qs = query.isEmpty ? "" : "?\(query)"
        guard PBLocal.shared.isOnline(), let url = URL(string: "\(IccCameraHelper.remoteOrigin)\(path)\(qs)") else {
            sendResponse(clientSock, status: 404, type: "text/plain", body: Data("Offline".utf8))
            return
        }

        let sema = DispatchSemaphore(value: 0)
        var outData: Data?
        var statusCode = 502
        var contentType = mimeForAsset(path)

        URLSession.shared.dataTask(with: url) { data, resp, err in
            if err == nil, let http = resp as? HTTPURLResponse {
                statusCode = http.statusCode
                if let ct = http.value(forHTTPHeaderField: "Content-Type"), !ct.isEmpty { contentType = ct }
                outData = data
            }
            sema.signal()
        }.resume()

        _ = sema.wait(timeout: .now() + 25.0)
        if statusCode == 200, let d = outData, !d.isEmpty {
            try? FileManager.default.createDirectory(at: fileUrl.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? d.write(to: fileUrl)
            sendResponse(clientSock, status: 200, type: contentType, body: d)
        } else {
            sendResponse(clientSock, status: 404, type: "text/plain", body: Data("Not found".utf8))
        }
    }

    private func proxyRemoteApi(clientSock: Int32, method: String, path: String, query: String, headers: [String: String], body: Data) {
        let qs = query.isEmpty ? "" : "?\(query)"
        guard let url = URL(string: "\(IccCameraHelper.remoteOrigin)\(path)\(qs)") else {
            sendJson(clientSock, status: 400, json: ["ok": false, "error": "Bad URL"])
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15.0)
        req.httpMethod = method
        if let ct = headers["content-type"] { req.setValue(ct, forHTTPHeaderField: "Content-Type") }
        if !body.isEmpty { req.httpBody = body }

        let sema = DispatchSemaphore(value: 0)
        var outData = Data("{\"ok\":false,\"error\":\"offline\"}".utf8)
        var statusCode = 503
        var contentType = "application/json"

        URLSession.shared.dataTask(with: req) { data, resp, err in
            if err == nil, let http = resp as? HTTPURLResponse {
                statusCode = http.statusCode
                if let ct = http.value(forHTTPHeaderField: "Content-Type"), !ct.isEmpty { contentType = ct }
                if let d = data { outData = d }
            }
            sema.signal()
        }.resume()

        _ = sema.wait(timeout: .now() + 16.0)
        sendResponse(clientSock, status: statusCode, type: contentType, body: outData)
    }

    // MARK: - HTTP Response Helpers

    private func sendJson(_ sock: Int32, status: Int = 200, json: [String: Any]) {
        var mutableJson = json
        if mutableJson["ok"] == nil { mutableJson["ok"] = (status == 200) }
        let data = (try? JSONSerialization.data(withJSONObject: mutableJson, options: [])) ?? Data()
        sendResponse(sock, status: status, type: "application/json", body: data)
    }

    private func writeAll(_ sock: Int32, data: Data) {
        data.withUnsafeBytes { rawBuf in
            guard let base = rawBuf.baseAddress else { return }
            var sent = 0
            while sent < data.count {
                let n = Darwin.write(sock, base.advanced(by: sent), data.count - sent)
                if n <= 0 { break }
                sent += n
            }
        }
    }

    private func sendResponse(_ sock: Int32, status: Int, type: String, body: Data, extraHeaders: [String] = []) {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 204: reason = "No Content"
        case 404: reason = "Not Found"
        case 410: reason = "Gone"
        case 503: reason = "Service Unavailable"
        default: reason = "Error"
        }
        let extra = extraHeaders.isEmpty ? "" : (extraHeaders.joined(separator: "\r\n") + "\r\n")
        let header = "HTTP/1.1 \(status) \(reason)\r\n" +
            "Content-Type: \(type)\r\n" +
            "Content-Length: \(body.count)\r\n" +
            "Cache-Control: no-store\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: *\r\n" +
            "Access-Control-Allow-Private-Network: true\r\n" +
            extra +
            "Connection: close\r\n\r\n"

        if let headerData = header.data(using: .utf8) {
            writeAll(sock, data: headerData)
        }
        if !body.isEmpty {
            writeAll(sock, data: body)
        }
    }
}
