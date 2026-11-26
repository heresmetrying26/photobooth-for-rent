import Foundation
import UIKit

/**
 * photobooth4u — iOS Local Share Server
 *
 * Runs an embedded HTTP server on port 47777 (or fallback ports 47778..47797)
 * serving event photo galleries and direct downloads to guests scanning the QR code
 * over local Wi-Fi.
 *
 * Endpoints:
 *   /e/<slug>/          -> Event gallery page
 *   /e/<slug>/p/<file>  -> Single photo viewing page with Save button
 *   /e/<slug>/f/<file>  -> Direct file download (JPEG / PNG / GIF / MP4 / WebM)
 *   /e/<slug>/list.json -> JSON array of items in event
 *   /o/<code>           -> Guest's own session page
 */
class LocalShareServer {

    static let shared = LocalShareServer()
    static let ports: [UInt16] = [47777, 47778, 47779, 47787, 47797]

    private let serverLock = NSLock()
    private var serverSocket: Int32 = -1
    private var _activePort: UInt16 = 0
    var activePort: UInt16 {
        serverLock.lock()
        let p = _activePort
        serverLock.unlock()
        return p
    }
    private var isRunning = false
    private var serverGeneration: Int = 0
    private var restartScheduled = false
    private let acceptQueue = DispatchQueue(label: "com.photobooth4u.shareserver.accept", qos: .utility, attributes: .concurrent)
    private let clientQueue = DispatchQueue(label: "com.photobooth4u.shareserver.client", qos: .utility, attributes: .concurrent)
    private let connLimit = DispatchSemaphore(value: 16)

    func start() -> UInt16 {
        serverLock.lock()
        if isRunning && serverSocket >= 0 {
            let p = _activePort
            serverLock.unlock()
            return p
        }
        isRunning = true
        let p = restartListenerLocked()
        serverLock.unlock()
        return p
    }

    func stop() {
        serverLock.lock()
        isRunning = false
        serverGeneration &+= 1
        closeListenerLocked()
        _activePort = 0
        serverLock.unlock()
    }

    func ensureListening(forceRestart: Bool = false) {
        serverLock.lock()
        guard isRunning else {
            serverLock.unlock()
            _ = start()
            return
        }
        var restartNeeded = forceRestart || serverSocket < 0
        if !restartNeeded && serverSocket >= 0 {
            var err: Int32 = 0
            var len = socklen_t(MemoryLayout<Int32>.size)
            if getsockopt(serverSocket, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0 {
                restartNeeded = true
            }
        }
        if restartNeeded {
            _ = restartListenerLocked()
        }
        serverLock.unlock()
    }

    private func closeListenerLocked() {
        if serverSocket >= 0 {
            let s = serverSocket
            serverSocket = -1
            Darwin.shutdown(s, SHUT_RDWR)
            Darwin.close(s)
        }
    }

    private func isCurrentListener(sock: Int32, generation: Int) -> Bool {
        serverLock.lock()
        let ok = isRunning && serverGeneration == generation && serverSocket == sock
        serverLock.unlock()
        return ok
    }

    @discardableResult
    private func restartListenerLocked() -> UInt16 {
        serverGeneration &+= 1
        let gen = serverGeneration
        closeListenerLocked()
        _activePort = 0

        for port in LocalShareServer.ports {
            let sock = bindAndListen(port: port)
            if sock >= 0 {
                serverSocket = sock
                _activePort = port
                print("[LocalShareServer] Sharing photos on port \(port)")
                acceptQueue.async { [weak self] in
                    self?.acceptConnections(sock: sock, generation: gen)
                }
                return port
            }
        }

        print("[LocalShareServer] Failed to bind to any share server port")
        if isRunning && !restartScheduled {
            restartScheduled = true
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.35) { [weak self] in
                guard let self = self else { return }
                self.serverLock.lock()
                self.restartScheduled = false
                if self.isRunning && self.serverSocket < 0 {
                    _ = self.restartListenerLocked()
                }
                self.serverLock.unlock()
            }
        }
        return 0
    }

    private func scheduleRestart() {
        serverLock.lock()
        if !isRunning || restartScheduled {
            serverLock.unlock()
            return
        }
        restartScheduled = true
        serverLock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self = self else { return }
            self.serverLock.lock()
            self.restartScheduled = false
            if self.isRunning {
                _ = self.restartListenerLocked()
            }
            self.serverLock.unlock()
        }
    }

    private func bindAndListen(port: UInt16) -> Int32 {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return -1 }

        var opt: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(sock, SOL_SOCKET, SO_REUSEPORT, &opt, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = INADDR_ANY

        let bindRes = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        if bindRes < 0 {
            close(sock)
            return -1
        }

        if listen(sock, 32) < 0 {
            close(sock)
            return -1
        }

        return sock
    }

    private func acceptConnections(sock: Int32, generation: Int) {
        while sock >= 0 && isCurrentListener(sock: sock, generation: generation) {
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientSock = withUnsafeMutablePointer(to: &clientAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    accept(sock, $0, &clientLen)
                }
            }

            if clientSock < 0 {
                let err = errno
                if err == EINTR { continue }
                if err == EAGAIN || err == EWOULDBLOCK || err == EMFILE || err == ENFILE {
                    usleep(20_000)
                    continue
                }
                if isCurrentListener(sock: sock, generation: generation) {
                    scheduleRestart()
                }
                break
            }
            let limit = connLimit
            if limit.wait(timeout: .now() + 0.5) == .timedOut {
                close(clientSock)
                continue
            }
            clientQueue.async { [weak self] in
                defer { limit.signal() }
                self?.handleRequest(clientSock)
            }
        }
    }

    private func handleRequest(_ sock: Int32) {
        defer { close(sock) }
        var noSigPipe: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        var rcvTv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &rcvTv, socklen_t(MemoryLayout<timeval>.size))
        var sndTv = timeval(tv_sec: 15, tv_usec: 0)
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &sndTv, socklen_t(MemoryLayout<timeval>.size))

        var buffer = [UInt8](repeating: 0, count: 4096)
        let bytesRead = read(sock, &buffer, buffer.count)
        guard bytesRead > 0 else { return }

        let req = String(bytes: buffer[0..<bytesRead], encoding: .utf8) ?? ""
        let reqLines = req.components(separatedBy: "\r\n")
        guard let line = reqLines.first else { return }
        let parts = line.components(separatedBy: " ")
        guard parts.count >= 2 else { return }

        var rangeHeader: String? = nil
        for h in reqLines.dropFirst() where !h.isEmpty {
            if let colon = h.firstIndex(of: ":") {
                let k = h[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                if k == "range" {
                    rangeHeader = h[h.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    break
                }
            }
        }

        let method = parts[0]
        let rawTarget = parts[1]
        let comps = rawTarget.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(comps[0])
        let query = comps.count > 1 ? String(comps[1]) : ""

        if method != "GET" && method != "HEAD" {
            sendResponse(sock, status: 405, type: "text/plain", body: Data("Method Not Allowed".utf8))
            return
        }

        route(sock: sock, path: path, query: query, rangeHeader: rangeHeader, headOnly: method == "HEAD")
    }

    private func route(sock: Int32, path: String, query: String, rangeHeader: String?, headOnly: Bool) {
        let components = path.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }

        // Guest own-photos link: /o/<code>
        if components.count >= 2 && components[0] == "o" {
            let code = components[1]
            guard let gc = PBLocal.shared.guestCode(code),
                  let folder = PBLocal.shared.folderBySlug(gc.slug) else {
                sendResponse(sock, status: 404, type: "text/html; charset=utf-8", body: Data(renderErrorHtml(title: "Photos Not Found", message: "Check the QR code or link.").utf8), headOnly: headOnly)
                return
            }
            let dir = PBLocal.shared.dirOf(folder: folder)
            let files = gc.files.compactMap { PBLocal.shared.findFile(in: dir, name: $0) }
            let showAll = PBLocal.shared.guestView != "only"
            let html = renderGalleryHtml(folder: folder, files: files, showAllLink: showAll, headOnlyTitle: "Your Photos — \(PBLocal.shared.galleryTitle(folder: folder))")
            sendResponse(sock, status: 200, type: "text/html; charset=utf-8", body: Data(html.utf8), headOnly: headOnly)
            return
        }

        guard components.count >= 2, components[0] == "e" else {
            sendResponse(sock, status: 404, type: "text/plain", body: Data("Not Found".utf8), headOnly: headOnly)
            return
        }

        let slug = components[1]
        guard let folder = PBLocal.shared.folderBySlug(slug) else {
            sendResponse(sock, status: 404, type: "text/html; charset=utf-8", body: Data(renderErrorHtml(title: "Event Not Found", message: "Check the QR code or link.").utf8), headOnly: headOnly)
            return
        }

        let dir = PBLocal.shared.dirOf(folder: folder)

        // /e/<slug>/ or /e/<slug>
        if components.count == 2 {
            let files = PBLocal.shared.photosIn(dir: dir)
            let html = renderGalleryHtml(folder: folder, files: files, showAllLink: false, headOnlyTitle: nil)
            sendResponse(sock, status: 200, type: "text/html; charset=utf-8", body: Data(html.utf8), headOnly: headOnly)
            return
        }

        let action = components[2]

        // /e/<slug>/list.json
        if action == "list.json" {
            let files = PBLocal.shared.photosIn(dir: dir).map { $0.lastPathComponent }
            let json = try? JSONSerialization.data(withJSONObject: ["ok": true, "files": files], options: [])
            sendResponse(sock, status: 200, type: "application/json", body: json ?? Data(), headOnly: headOnly)
            return
        }

        guard components.count >= 4 else {
            sendResponse(sock, status: 404, type: "text/plain", body: Data("Not Found".utf8), headOnly: headOnly)
            return
        }

        let filename = components[3]
        guard let fileUrl = PBLocal.shared.findFile(in: dir, name: filename) else {
            sendResponse(sock, status: 404, type: "text/plain", body: Data("File Not Found".utf8), headOnly: headOnly)
            return
        }

        // /e/<slug>/f/<filename> -> Direct raw image/video (supports HTTP 206 Range for Safari video playback)
        if action == "f" {
            if let data = try? Data(contentsOf: fileUrl) {
                let mime = mimeTypeFor(path: filename)
                var extra: [String] = ["Accept-Ranges: bytes"]
                if query.contains("dl=1") {
                    let safeFile = filename.replacingOccurrences(of: "\"", with: "_")
                    extra.append("Content-Disposition: attachment; filename=\"\(safeFile)\"")
                }
                if !query.contains("dl=1"), let rng = parseByteRange(rangeHeader, total: data.count) {
                    let slice = data.subdata(in: rng.start..<(rng.end + 1))
                    extra.append("Content-Range: bytes \(rng.start)-\(rng.end)/\(data.count)")
                    sendResponse(sock, status: 206, type: mime, body: slice, extraHeaders: extra, headOnly: headOnly)
                } else {
                    sendResponse(sock, status: 200, type: mime, body: data, extraHeaders: extra, headOnly: headOnly)
                }
            } else {
                sendResponse(sock, status: 500, type: "text/plain", body: Data("Read Error".utf8), headOnly: headOnly)
            }
            return
        }

        // /e/<slug>/p/<filename> -> Single item display page with Save button
        if action == "p" {
            let html = renderPhotoPageHtml(slug: slug, filename: filename, eventName: PBLocal.shared.galleryTitle(folder: folder))
            sendResponse(sock, status: 200, type: "text/html; charset=utf-8", body: Data(html.utf8), headOnly: headOnly)
            return
        }

        sendResponse(sock, status: 404, type: "text/plain", body: Data("Not Found".utf8), headOnly: headOnly)
    }

    private func esc(_ s: String) -> String {
        return s
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    private func urlEsc(_ s: String) -> String {
        return s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    private func parseByteRange(_ header: String?, total: Int) -> (start: Int, end: Int)? {
        guard total > 0, let h = header?.lowercased(), h.hasPrefix("bytes=") else { return nil }
        let spec = h.dropFirst(6).split(separator: ",", maxSplits: 1)[0].trimmingCharacters(in: .whitespaces)
        let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let sStr = String(parts[0]), eStr = String(parts[1])
        if sStr.isEmpty {
            guard let suffix = Int(eStr), suffix > 0 else { return nil }
            let start = max(0, total - suffix)
            return (start, total - 1)
        }
        guard let start = Int(sStr), start >= 0, start < total else { return nil }
        let end = eStr.isEmpty ? (total - 1) : min(total - 1, Int(eStr) ?? (total - 1))
        guard end >= start else { return nil }
        return (start, end)
    }

    private func mimeTypeFor(path: String) -> String {
        let lower = path.lowercased()
        if lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") { return "image/jpeg" }
        if lower.hasSuffix(".png") { return "image/png" }
        if lower.hasSuffix(".webp") { return "image/webp" }
        if lower.hasSuffix(".gif") { return "image/gif" }
        if lower.hasSuffix(".mp4") { return "video/mp4" }
        if lower.hasSuffix(".mov") { return "video/quicktime" }
        if lower.hasSuffix(".webm") { return "video/webm" }
        return "application/octet-stream"
    }

    private func renderGalleryHtml(folder: PBLocal.Folder, files: [URL], showAllLink: Bool, headOnlyTitle: String?) -> String {
        let title = PBLocal.shared.galleryTitle(folder: folder)
        var itemsHtml = ""

        for photo in files {
            let name = photo.lastPathComponent
            let encName = urlEsc(name)
            let isVideo = name.lowercased().hasSuffix(".mp4") || name.lowercased().hasSuffix(".webm")
            if isVideo {
                itemsHtml += """
                <div class="card">
                    <a href="/e/\(folder.slug)/p/\(encName)">
                        <video src="/e/\(folder.slug)/f/\(encName)" preload="metadata" muted playsinline></video>
                    </a>
                </div>
                """
            } else {
                itemsHtml += """
                <div class="card">
                    <a href="/e/\(folder.slug)/p/\(encName)">
                        <img src="/e/\(folder.slug)/f/\(encName)" loading="lazy" alt="Photo" />
                    </a>
                </div>
                """
            }
        }

        if itemsHtml.isEmpty {
            itemsHtml = "<p class='empty'>No photos taken yet for this event.</p>"
        }

        let allBtn = showAllLink ? "<p style='margin-top:10px'><a class='pill' href='/e/\(folder.slug)/'>See all event photos</a></p>" : ""
        let pageTitle = esc(headOnlyTitle ?? title)

        return """
        <!doctype html>
        <html lang="en">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>\(pageTitle) — photobooth4u</title>
            <style>
                * { box-sizing: border-box; }
                body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F5F1EA; color: #1C1A1E; }
                header { padding: 28px 16px 14px; text-align: center; }
                h1 { margin: 0 0 6px; font-size: 22px; font-weight: 800; }
                .sub { color: #6B666C; font-size: 13px; margin: 0; }
                .pill { display: inline-block; padding: 8px 16px; border-radius: 999px; background: #fff; border: 1px solid #E4DCCF; color: #1C1A1E; text-decoration: none; font-weight: 700; font-size: 13px; }
                .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; padding: 16px; max-width: 900px; margin: 0 auto; }
                .card { border-radius: 10px; overflow: hidden; background: #fff; box-shadow: 0 4px 14px rgba(0,0,0,0.06); }
                .card img, .card video { width: 100%; height: 180px; object-fit: cover; display: block; }
                .empty { grid-column: 1 / -1; text-align: center; color: #6B666C; padding: 40px; }
            </style>
        </head>
        <body>
            <header>
                <h1>\(esc(title))</h1>
                <p class="sub">photobooth4u Live Event Gallery</p>
                \(allBtn)
            </header>
            <div class="grid">
                \(itemsHtml)
            </div>
        </body>
        </html>
        """
    }

    private func renderPhotoPageHtml(slug: String, filename: String, eventName: String) -> String {
        let encName = urlEsc(filename)
        let safeFile = esc(filename)
        let lower = filename.lowercased()
        let isVideo = lower.hasSuffix(".mp4") || lower.hasSuffix(".webm") || lower.hasSuffix(".mov") || lower.hasSuffix(".m4v")
        let isGif = lower.hasSuffix(".gif")
        let mediaTag = isVideo ?
            "<video src='/e/\(slug)/f/\(encName)' controls autoplay playsinline loop></video>" :
            "<img src='/e/\(slug)/f/\(encName)' alt='Photo' />"
        let printBtn = (!isVideo && !isGif) ? "<button class=\"btn alt\" type=\"button\" onclick=\"window.print()\">Print photo</button>" : ""

        return """
        <!doctype html>
        <html lang="en">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>\(esc(eventName)) — Photo</title>
            <style>
                * { box-sizing: border-box; }
                body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F5F1EA; color: #1C1A1E; text-align: center; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 20px; }
                .box { max-width: 500px; margin: 0 auto; width: 100%; }
                img, video { max-width: 100%; max-height: 72vh; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.15); display: block; margin: 0 auto; }
                .actions { margin-top: 20px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
                .btn { display: inline-block; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 15px; background: #C93D27; color: #fff; border: 0; cursor: pointer; font-family: inherit; }
                .btn.alt { background: #fff; color: #1C1A1E; border: 1.5px solid #E4DCCF; }
                @media print { @page { margin: 0; } body { padding: 0; background: #fff; } .actions { display: none !important; } .box { max-width: none; } img { max-width: 100vw; max-height: 100vh; border-radius: 0; box-shadow: none; } }
            </style>
        </head>
        <body>
            <div class="box">
                \(mediaTag)
                <div class="actions">
                    <a class="btn" href="/e/\(slug)/f/\(encName)?dl=1" download="\(safeFile)">Save Photo</a>
                    \(printBtn)
                    <a class="btn alt" href="/e/\(slug)/">All Photos</a>
                </div>
            </div>
        </body>
        </html>
        """
    }

    private func renderErrorHtml(title: String, message: String) -> String {
        return """
        <!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#F5F1EA;">
        <h2>\(esc(title))</h2><p style="color:#666;">\(esc(message))</p>
        </body></html>
        """
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

    private func sendResponse(_ sock: Int32, status: Int, type: String, body: Data, extraHeaders: [String] = [], headOnly: Bool = false) {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 206: reason = "Partial Content"
        case 404: reason = "Not Found"
        case 405: reason = "Method Not Allowed"
        default: reason = "Error"
        }
        let extra = extraHeaders.isEmpty ? "" : (extraHeaders.joined(separator: "\r\n") + "\r\n")
        let header = "HTTP/1.1 \(status) \(reason)\r\n" +
            "Content-Type: \(type)\r\n" +
            "Content-Length: \(body.count)\r\n" +
            "Cache-Control: no-store\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            extra +
            "Connection: close\r\n\r\n"

        if let headerData = header.data(using: .utf8) {
            writeAll(sock, data: headerData)
        }
        if !headOnly && !body.isEmpty {
            writeAll(sock, data: body)
        }
    }
}
