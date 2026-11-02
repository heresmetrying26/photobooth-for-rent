import Foundation
import ImageCaptureCore
import UIKit

/**
 * photobooth4u — iOS ImageCaptureCore DSLR USB Bridge
 *
 * Implements the camera bridge on 127.0.0.1:17321, matching Android's UsbCameraHelper.kt
 * and desktop/tools/print-helper.
 *
 * Exposes:
 *   GET  /camera           -> list connected cameras
 *   POST /camera/open      -> open camera session
 *   POST /camera/live      -> toggle live view (query: on=1 or on=0)
 *   GET  /camera/frame     -> single JPEG live view frame (200 with bytes or 204)
 *   POST /camera/capture   -> trigger physical shutter & return downloaded JPEG
 *   GET  /camera/battery   -> battery percentage
 *   POST /camera/close     -> release camera
 *   POST /camera/free      -> clear locks
 */
class IccCameraHelper: NSObject, ICDeviceBrowserDelegate, ICCameraDeviceDelegate, ICCameraDeviceDownloadDelegate {

    static let shared = IccCameraHelper()
    static let port: UInt16 = 17321

    private let browser = ICDeviceBrowser()
    private var availableCameras: [ICCameraDevice] = []
    private var activeCamera: ICCameraDevice?
    private let lock = NSLock()

    // Live view state
    private var isLiveViewActive = false
    private var latestFrame: Data?
    private var liveViewTimer: Timer?

    // Capture state
    private var pendingCaptureCompletion: ((Result<Data, Error>) -> Void)?
    private var captureTimeoutTimer: Timer?

    // Background HTTP server socket
    private var serverSocket: Int32 = -1
    private var isRunning = false
    private let serverQueue = DispatchQueue(label: "com.photobooth4u.cameraserver", qos: .userInitiated)

    // PTP transaction ids for commands sent through requestSendPTPCommand
    private var ptpTransactionId: UInt32 = 1
    private let ptpTransactionLock = NSLock()

    override init() {
        super.init()
        browser.delegate = self
        // ICDeviceTypeMask / browsedDeviceTypeMask only exist from iOS 15.2
        if #available(iOS 15.2, *),
           let combined = ICDeviceTypeMask(rawValue: ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue) {
            browser.browsedDeviceTypeMask = combined
        }
    }

    // MARK: - Lifecycle

    func start() {
        guard !isRunning else { return }
        isRunning = true
        // iPadOS asks the user once before an app may list and control USB cameras
        browser.requestContentsAuthorization { _ in }
        browser.requestControlAuthorization { _ in }
        browser.start()
        startHttpServer()
        print("[IccCameraHelper] Started camera helper & browser on 127.0.0.1:\(IccCameraHelper.port)")
    }

    func stop() {
        isRunning = false
        browser.stop()
        stopHttpServer()
        closeCamera()
        print("[IccCameraHelper] Stopped camera helper")
    }

    // MARK: - ICDeviceBrowserDelegate

    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        guard let camera = device as? ICCameraDevice else { return }
        lock.lock()
        if !availableCameras.contains(where: { $0.uuidString == camera.uuidString }) {
            availableCameras.append(camera)
            print("[IccCameraHelper] Discovered camera: \(camera.name ?? "Unknown") (\(camera.productKind ?? ""))")
        }
        lock.unlock()
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        guard let camera = device as? ICCameraDevice else { return }
        lock.lock()
        availableCameras.removeAll(where: { $0.uuidString == camera.uuidString })
        if activeCamera?.uuidString == camera.uuidString {
            activeCamera = nil
            isLiveViewActive = false
            print("[IccCameraHelper] Active camera disconnected")
        }
        lock.unlock()
    }

    // MARK: - Camera Operations

    private func listCamerasJson() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }

        var list: [[String: Any]] = []
        for cam in availableCameras {
            let isOpen = (activeCamera?.uuidString == cam.uuidString)
            list.append([
                "name": cam.name ?? "USB Camera",
                "model": cam.productKind ?? "",
                "vendor": inferVendorString(cam),
                "open": isOpen
            ])
        }

        return [
            "ok": true,
            "cameras": list,
            "count": list.count
        ]
    }

    private func inferVendorString(_ cam: ICCameraDevice) -> String {
        let name = (cam.name ?? "").lowercased()
        if name.contains("canon") { return "canon" }
        if name.contains("nikon") { return "nikon" }
        if name.contains("sony") { return "sony" }
        return "generic"
    }

    private func openCamera() throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }

        guard let cam = availableCameras.first else {
            throw CameraError(code: "NOCAMERA", message: "No Canon, Nikon or Sony camera found on USB.")
        }

        activeCamera = cam
        cam.delegate = self

        let semaphore = DispatchSemaphore(value: 0)
        var openError: Error?

        cam.requestOpenSession(options: nil) { error in
            openError = error
            semaphore.signal()
        }

        _ = semaphore.wait(timeout: .now() + 5.0)

        if let err = openError {
            throw CameraError(code: "ERROR", message: "Failed to open camera: \(err.localizedDescription)")
        }

        let vendor = inferVendorString(cam)
        let batteryVal = readBattery(cam)
        return [
            "ok": true,
            "name": cam.name ?? "Camera",
            "maker": vendor.capitalized,
            "model": cam.productKind ?? "DSLR",
            "vendor": vendor,
            "battery": batteryVal
        ]
    }

    private func closeCamera() {
        lock.lock()
        defer { lock.unlock() }

        stopLiveViewTimer()
        isLiveViewActive = false
        latestFrame = nil

        if let cam = activeCamera {
            cam.requestCloseSession(options: nil) { _ in }
            activeCamera = nil
        }
    }

    // MARK: - PTP helpers
    //
    // iOS has no requestTakePicture / tethering / battery API (macOS only), so the camera
    // is driven with raw PTP commands through requestSendPTPCommand instead.

    private func ptpContainer(code: UInt16, params: [UInt32] = []) -> Data {
        ptpTransactionLock.lock()
        let tid = ptpTransactionId
        ptpTransactionId &+= 1
        ptpTransactionLock.unlock()

        var data = Data()
        func put<T: FixedWidthInteger>(_ value: T) {
            var le = value.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        put(UInt32(12 + params.count * 4)) // container length
        put(UInt16(1))                     // PTP_USB_CONTAINER_COMMAND
        put(code)
        put(tid)
        for p in params { put(p) }
        return data
    }

    private func sendPTP(_ cam: ICCameraDevice, code: UInt16, params: [UInt32] = [],
                         completion: @escaping (_ response: Data, _ data: Data, _ error: Error?) -> Void) {
        cam.requestSendPTPCommand(ptpContainer(code: code, params: params), outData: nil, completion: completion)
    }

    /// GetDevicePropValue(BatteryLevel); falls back to 100 when the camera doesn't answer.
    private func readBattery(_ cam: ICCameraDevice) -> Int {
        let sema = DispatchSemaphore(value: 0)
        var level = 100
        sendPTP(cam, code: 0x1015, params: [0x5001]) { _, data, error in
            if error == nil, let b = data.last, b <= 100 { level = Int(b) }
            sema.signal()
        }
        _ = sema.wait(timeout: .now() + 2.0)
        return level
    }

    private func setLiveView(enabled: Bool) {
        lock.lock()
        defer { lock.unlock() }

        isLiveViewActive = enabled
        if enabled {
            startLiveViewTimer()
        } else {
            stopLiveViewTimer()
            latestFrame = nil
        }
    }

    private func startLiveViewTimer() {
        stopLiveViewTimer()
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.liveViewTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                self?.pollLiveViewFrame()
            }
        }
    }

    private func stopLiveViewTimer() {
        DispatchQueue.main.async { [weak self] in
            self?.liveViewTimer?.invalidate()
            self?.liveViewTimer = nil
        }
    }

    private func pollLiveViewFrame() {
        guard let cam = activeCamera, isLiveViewActive else { return }

        // Send PTP GetLiveViewImg command (0x9203 for Nikon, Canon CCAPI/PTP equivalent)
        sendPTP(cam, code: 0x9203) { [weak self] _, data, error in
            guard let self = self, error == nil else { return }
            if let jpeg = self.extractJpeg(from: data) {
                self.lock.lock()
                self.latestFrame = jpeg
                self.lock.unlock()
            }
        }
    }

    private func extractJpeg(from buffer: Data) -> Data? {
        guard buffer.count > 4 else { return nil }
        let soi: [UInt8] = [0xFF, 0xD8]
        let eoi: [UInt8] = [0xFF, 0xD9]

        guard let startRange = buffer.range(of: Data(soi)) else { return nil }
        guard let endRange = buffer.range(of: Data(eoi), options: .backwards, in: startRange.lowerBound..<buffer.count) else {
            return nil
        }

        return buffer.subdata(in: startRange.lowerBound..<endRange.upperBound)
    }

    private func capturePhoto(completion: @escaping (Result<Data, Error>) -> Void) {
        lock.lock()
        guard let cam = activeCamera else {
            lock.unlock()
            completion(.failure(CameraError(code: "NOCAMERA", message: "No active camera connected")))
            return
        }

        pendingCaptureCompletion = completion
        lock.unlock()

        // Set capture timeout timer (15s)
        DispatchQueue.main.async { [weak self] in
            self?.captureTimeoutTimer?.invalidate()
            self?.captureTimeoutTimer = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: false) { [weak self] _ in
                self?.lock.lock()
                let cb = self?.pendingCaptureCompletion
                self?.pendingCaptureCompletion = nil
                self?.lock.unlock()
                cb?(.failure(CameraError(code: "TIMEOUT", message: "Shutter capture timed out.")))
            }
        }

        // Trigger the shutter with PTP InitiateCapture (0x100E, any storage, any format).
        // The new photo then arrives through cameraDevice(_:didAdd:) and is downloaded there.
        sendPTP(cam, code: 0x100E, params: [0, 0]) { [weak self] _, _, error in
            guard let self = self, let error = error else { return }
            self.lock.lock()
            let cb = self.pendingCaptureCompletion
            self.pendingCaptureCompletion = nil
            self.lock.unlock()
            cb?(.failure(CameraError(code: "CAPTURE_FAILED", message: error.localizedDescription)))
        }
    }

    // MARK: - ICDeviceDelegate

    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {}

    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}

    func didRemove(_ device: ICDevice) {
        lock.lock()
        availableCameras.removeAll(where: { $0.uuidString == device.uuidString })
        if activeCamera?.uuidString == device.uuidString {
            activeCamera = nil
            isLiveViewActive = false
        }
        lock.unlock()
    }

    func deviceDidBecomeReady(_ device: ICDevice) {
        print("[IccCameraHelper] Camera became ready: \(device.name ?? "")")
    }

    func device(_ device: ICDevice, didEncounterError error: Error?) {
        print("[IccCameraHelper] Camera error: \(error?.localizedDescription ?? "unknown")")
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
        for item in items {
            guard let file = item as? ICCameraFile else { continue }
            let tempDir = FileManager.default.temporaryDirectory
            let filename = file.name ?? "capture.jpg"
            let options: [ICDownloadOption: Any] = [
                .downloadsDirectoryURL: tempDir,
                .saveAsFilename: filename,
                .overwrite: true
            ]

            camera.requestDownloadFile(
                file,
                options: options,
                downloadDelegate: self,
                didDownloadSelector: #selector(didDownloadFile(_:error:options:contextInfo:)),
                contextInfo: nil
            )
        }
    }

    @objc func didDownloadFile(
        _ file: ICCameraFile,
        error: Error?,
        options: [String: Any],
        contextInfo: UnsafeMutableRawPointer?
    ) {
        captureTimeoutTimer?.invalidate()
        captureTimeoutTimer = nil

        lock.lock()
        let cb = pendingCaptureCompletion
        pendingCaptureCompletion = nil
        lock.unlock()

        if let err = error {
            cb?(.failure(CameraError(code: "CAPTURE_FAILED", message: err.localizedDescription)))
            return
        }

        let tempDir = FileManager.default.temporaryDirectory
        let downloadedUrl = tempDir.appendingPathComponent(file.name ?? "capture.jpg")
        if let data = try? Data(contentsOf: downloadedUrl) {
            try? FileManager.default.removeItem(at: downloadedUrl)
            cb?(.success(data))
        } else {
            cb?(.failure(CameraError(code: "EMPTY_DATA", message: "Downloaded file is empty or missing")))
        }
    }

    // MARK: - Lightweight POSIX HTTP Server (127.0.0.1:17321)

    private func startHttpServer() {
        serverQueue.async { [weak self] in
            guard let self = self else { return }
            self.runSocketServer()
        }
    }

    private func stopHttpServer() {
        if serverSocket >= 0 {
            close(serverSocket)
            serverSocket = -1
        }
    }

    private func runSocketServer() {
        serverSocket = socket(AF_INET, SOCK_STREAM, 0)
        guard serverSocket >= 0 else {
            print("[IccCameraHelper] Failed to create socket")
            return
        }

        var opt: Int32 = 1
        setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = IccCameraHelper.port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bindRes = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(self.serverSocket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        guard bindRes >= 0 else {
            print("[IccCameraHelper] Failed to bind to 127.0.0.1:\(IccCameraHelper.port)")
            return
        }

        listen(serverSocket, 10)
        print("[IccCameraHelper] Socket server listening on 127.0.0.1:\(IccCameraHelper.port)")

        while isRunning {
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientSock = withUnsafeMutablePointer(to: &clientAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    accept(self.serverSocket, $0, &clientLen)
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

        var buffer = [UInt8](repeating: 0, count: 4096)
        let bytesRead = read(clientSock, &buffer, buffer.count)
        guard bytesRead > 0 else { return }

        let requestString = String(bytes: buffer[0..<bytesRead], encoding: .utf8) ?? ""
        let lines = requestString.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return }

        let parts = requestLine.components(separatedBy: " ")
        guard parts.count >= 2 else { return }

        let method = parts[0]
        let fullPath = parts[1]
        let path = fullPath.components(separatedBy: "?").first?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        let normPath = "/" + path
        let query = fullPath.contains("?") ? String(fullPath.split(separator: "?").last ?? "") : ""

        if method == "OPTIONS" {
            sendResponse(clientSock, status: 204, type: "text/plain", body: Data())
            return
        }

        route(clientSock: clientSock, method: method, path: normPath, query: query)
    }

    private func route(clientSock: Int32, method: String, path: String, query: String) {
        switch (method, path) {
        case ("GET", "/camera"):
            sendJson(clientSock, json: listCamerasJson())

        case ("POST", "/camera/open"):
            do {
                let info = try openCamera()
                sendJson(clientSock, json: info)
            } catch let err as CameraError {
                sendJson(clientSock, status: 409, json: ["ok": false, "code": err.code, "error": err.message])
            } catch {
                sendJson(clientSock, status: 409, json: ["ok": false, "code": "ERROR", "error": error.localizedDescription])
            }

        case ("POST", "/camera/live"):
            let on = !query.contains("on=0")
            setLiveView(enabled: on)
            sendJson(clientSock, json: ["ok": true])

        case ("GET", "/camera/frame"):
            lock.lock()
            let frame = latestFrame
            lock.unlock()

            if let f = frame, !f.isEmpty {
                sendResponse(clientSock, status: 200, type: "image/jpeg", body: f)
            } else {
                sendResponse(clientSock, status: 204, type: "image/jpeg", body: Data())
            }

        case ("POST", "/camera/capture"):
            let sema = DispatchSemaphore(value: 0)
            var resultData: Data?
            var captureError: Error?

            capturePhoto { result in
                switch result {
                case .success(let data):
                    resultData = data
                case .failure(let err):
                    captureError = err
                }
                sema.signal()
            }

            _ = sema.wait(timeout: .now() + 16.0)

            if let data = resultData {
                sendResponse(clientSock, status: 200, type: "image/jpeg", body: data)
            } else {
                let msg = captureError?.localizedDescription ?? "Capture timed out"
                sendJson(clientSock, status: 409, json: ["ok": false, "code": "CAPTURE_FAILED", "error": msg])
            }

        case ("GET", "/camera/battery"):
            lock.lock()
            let cam = activeCamera
            lock.unlock()
            let b = cam.map { readBattery($0) } ?? 100
            sendJson(clientSock, json: ["ok": true, "battery": b])

        case ("POST", "/camera/close"):
            closeCamera()
            sendJson(clientSock, json: ["ok": true])

        case ("POST", "/camera/free"):
            sendJson(clientSock, json: ["ok": true])

        default:
            sendJson(clientSock, status: 404, json: ["ok": false, "code": "NOT_FOUND", "error": "Not found"])
        }
    }

    private func sendJson(_ sock: Int32, status: Int = 200, json: [String: Any]) {
        var mutableJson = json
        if mutableJson["ok"] == nil {
            mutableJson["ok"] = (status == 200)
        }
        let data = (try? JSONSerialization.data(withJSONObject: mutableJson, options: [])) ?? Data()
        sendResponse(sock, status: status, type: "application/json", body: data)
    }

    private func sendResponse(_ sock: Int32, status: Int, type: String, body: Data) {
        let reason = (status == 200) ? "OK" : (status == 204 ? "No Content" : (status == 404 ? "Not Found" : "Error"))
        let header = "HTTP/1.1 \(status) \(reason)\r\n" +
            "Content-Type: \(type)\r\n" +
            "Content-Length: \(body.count)\r\n" +
            "Cache-Control: no-store\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: *\r\n" +
            "Access-Control-Allow-Private-Network: true\r\n" +
            "Connection: close\r\n\r\n"

        if let headerData = header.data(using: .utf8) {
            _ = headerData.withUnsafeBytes { write(sock, $0.baseAddress, headerData.count) }
        }
        if !body.isEmpty {
            _ = body.withUnsafeBytes { write(sock, $0.baseAddress, body.count) }
        }
    }
}

struct CameraError: Error {
    let code: String
    let message: String
}
