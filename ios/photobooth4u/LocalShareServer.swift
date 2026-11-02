import Foundation
import UIKit

/**
 * photobooth4u — iOS Local Share Server
 *
 * Runs an embedded HTTP server on port 47777 (or fallback ports 47778..47797)
 * serving event photo galleries and direct downloads to guests scanning the QR code
 * over the local Wi-Fi.
 *
 * Endpoints:
 *   /e/<slug>/          -> Event gallery page
 *   /e/<slug>/p/<file>  -> Single photo viewing page with Save button
 *   /e/<slug>/f/<file>  -> Direct file download (JPEG / MP4 / GIF)
 *   /e/<slug>/list.json -> JSON array of items in event
 */
class LocalShareServer {

    static let shared = LocalShareServer()
    static let ports: [UInt16] = [47777, 47778, 47779, 47787, 47797]

    private var serverSocket: Int32 = -1
    private(set) var activePort: UInt16 = 0
    private var isRunning = false
    private let serverQueue = DispatchQueue(label: "com.photobooth4u.shareserver", qos: .utility)

    func start() -> UInt16 {
        guard !isRunning else { return activePort }

        for port in LocalShareServer.ports {
            if bindAndListen(port: port) {
                activePort = port
                isRunning = true
                print("[LocalShareServer] Sharing photos on port \(port)")
                serverQueue.async { [weak self] in
                    self?.acceptConnections()
                }
                return port
            }
        }

        print("[LocalShareServer] Failed to bind to any share server port")
        return 0
    }

    func stop() {
        isRunning = false
        if serverSocket >= 0 {
            close(serverSocket)
            serverSocket = -1
        }
        activePort = 0
    }

    private func bindAndListen(port: UInt16) -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }

        var opt: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))

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
            return false
        }

        if listen(sock, 20) < 0 {
            close(sock)
            return false
        }

        serverSocket = sock
        return true
    }

    private func acceptConnections() {
        while isRunning {
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientSock = withUnsafeMutablePointer(to: &clientAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    accept(self.serverSocket, $0, &clientLen)
                }
            }

            guard clientSock >= 0 else { continue }
            DispatchQueue.global(qos: .utility).async { [weak self] in
                self?.handleRequest(clientSock)
            }
        }
    }

    private func handleRequest(_ sock: Int32) {
        defer { close(sock) }

        var buffer = [UInt8](repeating: 0, count: 4096)
        let bytesRead = read(sock, &buffer, buffer.count)
        guard bytesRead > 0 else { return }

        let req = String(bytes: buffer[0..<bytesRead], encoding: .utf8) ?? ""
        guard let line = req.components(separatedBy: "\r\n").first else { return }
        let parts = line.components(separatedBy: " ")
        guard parts.count >= 2 else { return }

        let method = parts[0]
        let rawPath = parts[1]
        let path = rawPath.components(separatedBy: "?").first ?? "/"

        if method != "GET" && method != "HEAD" {
            sendResponse(sock, status: 405, type: "text/plain", body: Data("Method Not Allowed".utf8))
            return
        }

        route(sock: sock, path: path)
    }

    private func route(sock: Int32, path: String) {
        // Match /e/<slug>/...
        let components = path.split(separator: "/").map(String.init)
        guard components.count >= 2, components[0] == "e" else {
            sendResponse(sock, status: 404, type: "text/plain", body: Data("Not Found".utf8))
            return
        }

        let slug = components[1]
        guard let folder = PBLocal.shared.folderBySlug(slug) else {
            sendResponse(sock, status: 404, type: "text/html", body: Data(renderErrorHtml(title: "Event Not Found", message: "Check the QR code or link.").utf8))
            return
        }

        let dir = PBLocal.shared.dirOf(folder: folder)

        // /e/<slug>/ or /e/<slug>
        if components.count == 2 {
            let html = renderGalleryHtml(folder: folder, dir: dir)
            sendResponse(sock, status: 200, type: "text/html; charset=utf-8", body: Data(html.utf8))
            return
        }

        let action = components[2]

        // /e/<slug>/list.json
        if action == "list.json" {
            let files = PBLocal.shared.photosIn(dir: dir).map { $0.lastPathComponent }
            let json = try? JSONSerialization.data(withJSONObject: ["ok": true, "files": files], options: [])
            sendResponse(sock, status: 200, type: "application/json", body: json ?? Data())
            return
        }

        guard components.count >= 4 else {
            sendResponse(sock, status: 404, type: "text/plain", body: Data("Not Found".utf8))
            return
        }

        let filename = components[3]
        let fileUrl = dir.appendingPathComponent(filename)

        guard FileManager.default.fileExists(atPath: fileUrl.path) else {
            sendResponse(sock, status: 404, type: "text/plain", body: Data("File Not Found".utf8))
            return
        }

        // /e/<slug>/f/<filename> -> Direct raw image/video
        if action == "f" {
            if let data = try? Data(contentsOf: fileUrl) {
                let mime = mimeTypeFor(path: filename)
                sendResponse(sock, status: 200, type: mime, body: data)
            } else {
                sendResponse(sock, status: 500, type: "text/plain", body: Data("Read Error".utf8))
            }
            return
        }

        // /e/<slug>/p/<filename> -> Single item display page with Save button
        if action == "p" {
            let html = renderPhotoPageHtml(slug: slug, filename: filename, eventName: folder.name)
            sendResponse(sock, status: 200, type: "text/html; charset=utf-8", body: Data(html.utf8))
            return
        }

        sendResponse(sock, status: 404, type: "text/plain", body: Data("Not Found".utf8))
    }

    private func mimeTypeFor(path: String) -> String {
        let lower = path.lowercased()
        if lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") { return "image/jpeg" }
        if lower.hasSuffix(".png") { return "image/png" }
        if lower.hasSuffix(".gif") { return "image/gif" }
        if lower.hasSuffix(".mp4") { return "video/mp4" }
        if lower.hasSuffix(".webm") { return "video/webm" }
        return "application/octet-stream"
    }

    private func renderGalleryHtml(folder: PBLocal.Folder, dir: URL) -> String {
        let photos = PBLocal.shared.photosIn(dir: dir)
        var itemsHtml = ""

        for photo in photos {
            let name = photo.lastPathComponent
            let isVideo = name.lowercased().hasSuffix(".mp4") || name.lowercased().hasSuffix(".webm")
            if isVideo {
                itemsHtml += """
                <div class="card">
                    <a href="/e/\(folder.slug)/p/\(name)">
                        <video src="/e/\(folder.slug)/f/\(name)" preload="metadata" muted playsinline></video>
                    </a>
                </div>
                """
            } else {
                itemsHtml += """
                <div class="card">
                    <a href="/e/\(folder.slug)/p/\(name)">
                        <img src="/e/\(folder.slug)/f/\(name)" loading="lazy" alt="Photo" />
                    </a>
                </div>
                """
            }
        }

        if itemsHtml.isEmpty {
            itemsHtml = "<p class='empty'>No photos taken yet for this event.</p>"
        }

        return """
        <!doctype html>
        <html lang="en">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>\(folder.name) — photobooth4u</title>
            <style>
                * { box-sizing: border-box; }
                body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F5F1EA; color: #1C1A1E; }
                header { padding: 28px 16px 14px; text-align: center; }
                h1 { margin: 0 0 6px; font-size: 22px; font-weight: 800; }
                .sub { color: #6B666C; font-size: 13px; margin: 0; }
                .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; padding: 16px; max-width: 900px; margin: 0 auto; }
                .card { border-radius: 10px; overflow: hidden; background: #fff; box-shadow: 0 4px 14px rgba(0,0,0,0.06); }
                .card img, .card video { width: 100%; height: 180px; object-fit: cover; display: block; }
                .empty { grid-column: 1 / -1; text-align: center; color: #6B666C; padding: 40px; }
            </style>
        </head>
        <body>
            <header>
                <h1>\(folder.name)</h1>
                <p class="sub">photobooth4u Live Event Gallery</p>
            </header>
            <div class="grid">
                \(itemsHtml)
            </div>
        </body>
        </html>
        """
    }

    private func renderPhotoPageHtml(slug: String, filename: String, eventName: String) -> String {
        let isVideo = filename.lowercased().hasSuffix(".mp4") || filename.lowercased().hasSuffix(".webm")
        let mediaTag = isVideo ?
            "<video src='/e/\(slug)/f/\(filename)' controls autoplay playsinline loop></video>" :
            "<img src='/e/\(slug)/f/\(filename)' alt='Photo' />"

        return """
        <!doctype html>
        <html lang="en">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>\(eventName) — Photo</title>
            <style>
                * { box-sizing: border-box; }
                body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F5F1EA; color: #1C1A1E; text-align: center; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 20px; }
                .box { max-width: 500px; margin: 0 auto; width: 100%; }
                img, video { max-width: 100%; max-height: 72vh; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.15); display: block; margin: 0 auto; }
                .actions { margin-top: 20px; display: flex; gap: 10px; justify-content: center; }
                .btn { display: inline-block; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 15px; background: #C93D27; color: #fff; border: 0; }
                .btn.alt { background: #fff; color: #1C1A1E; border: 1.5px solid #E4DCCF; }
            </style>
        </head>
        <body>
            <div class="box">
                \(mediaTag)
                <div class="actions">
                    <a class="btn" href="/e/\(slug)/f/\(filename)?dl=1" download="\(filename)">Save Photo</a>
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
        <h2>\(title)</h2><p style="color:#666;">\(message)</p>
        </body></html>
        """
    }

    private func sendResponse(_ sock: Int32, status: Int, type: String, body: Data) {
        let reason = (status == 200) ? "OK" : (status == 404 ? "Not Found" : "Error")
        let header = "HTTP/1.1 \(status) \(reason)\r\n" +
            "Content-Type: \(type)\r\n" +
            "Content-Length: \(body.count)\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Connection: close\r\n\r\n"

        if let headerData = header.data(using: .utf8) {
            _ = headerData.withUnsafeBytes { write(sock, $0.baseAddress, headerData.count) }
        }
        if !body.isEmpty {
            _ = body.withUnsafeBytes { write(sock, $0.baseAddress, body.count) }
        }
    }
}

