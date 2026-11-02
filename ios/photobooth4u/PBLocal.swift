import Foundation
import UIKit
import Photos

/**
 * photobooth4u — iOS Local Event & Photo Storage
 *
 * Mirrors desktop/lib/photos.mjs and Android's PBLocal.kt.
 * Saves photos directly onto the iPad's internal storage and Photo Library.
 * Guests scanning QR codes over local Wi-Fi download photos from LocalShareServer.
 */
class PBLocal {

    static let shared = PBLocal()

    struct Folder: Codable {
        let slug: String
        let id: String
        let name: String
        let sub: String
        let at: Int64
    }

    private let lock = NSLock()
    private var folders: [String: Folder] = [:]
    private let indexFile: URL

    let rootDir: URL

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.rootDir = docs.appendingPathComponent("Pictures/photobooth4u")
        self.indexFile = docs.appendingPathComponent("folders.json")

        try? FileManager.default.createDirectory(at: rootDir, withIntermediateDirectories: true)
        loadIndex()
    }

    // MARK: - Index Management

    private func loadIndex() {
        guard let data = try? Data(contentsOf: indexFile),
              let list = try? JSONDecoder().decode([Folder].self, from: data) else { return }
        for f in list {
            folders[f.slug] = f
        }
    }

    private func saveIndex() {
        let list = Array(folders.values)
        if let data = try? JSONEncoder().encode(list) {
            try? data.write(to: indexFile)
        }
    }

    func folderBySlug(_ slug: String) -> Folder? {
        lock.lock()
        defer { lock.unlock() }
        return folders[slug]
    }

    func dirOf(folder: Folder) -> URL {
        if !folder.sub.isEmpty {
            return rootDir.appendingPathComponent(folder.name).appendingPathComponent(folder.sub)
        }
        return rootDir.appendingPathComponent(folder.name)
    }

    func photosIn(dir: URL) -> [URL] {
        guard let items = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else {
            return []
        }
        let exts = ["jpg", "jpeg", "png", "gif", "mp4", "webm"]
        return items
            .filter { exts.contains($0.pathExtension.lowercased()) }
            .sorted { (u1, u2) -> Bool in
                let d1 = (try? u1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date.distantPast
                let d2 = (try? u2.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date.distantPast
                return d1 > d2
            }
    }

    // MARK: - Safe Naming

    private func safeName(_ str: String?) -> String {
        guard let s = str else { return "" }
        let invalid = CharacterSet(charactersIn: "\\/:*?\"<>|\0")
        var cleaned = s.components(separatedBy: invalid).joined(separator: " ")
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.count > 80 {
            cleaned = String(cleaned.prefix(80))
        }
        return cleaned
    }

    private func todayString() -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        return fmt.string(from: Date())
    }

    private func folderFor(folderKey: String?, subfolder: String?) -> Folder {
        lock.lock()
        defer { lock.unlock() }

        var name = safeName(folderKey)
        if name.isEmpty { name = "Photobooth " + todayString() }
        let sub = safeName(subfolder)
        let id = (name + (sub.isEmpty ? "" : "/\(sub)")).lowercased()

        if let existing = folders.values.first(where: { $0.id == id }) {
            return existing
        }

        let slug = UUID().uuidString.prefix(8).lowercased()
        let newFolder = Folder(slug: String(slug), id: id, name: name, sub: sub, at: Int64(Date().timeIntervalSince1970 * 1000))
        folders[newFolder.slug] = newFolder
        saveIndex()

        let dir = dirOf(folder: newFolder)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return newFolder
    }

    // MARK: - Drive Save Operation (called by window.__PBLocal.drive)

    func drive(body: String) -> String {
        guard let data = body.data(using: .utf8),
              let dict = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else {
            return "{\"ok\":false,\"error\":\"Bad request\"}"
        }

        let folder = folderFor(folderKey: dict["folderKey"] as? String, subfolder: dict["subfolder"] as? String)
        let dir = dirOf(folder: folder)

        // Resolve only
        if let resolveOnly = dict["resolveOnly"] as? Bool, resolveOnly {
            let nextNum = (photosIn(dir: dir).count) + 1
            let res: [String: Any] = [
                "ok": true,
                "folderUrl": "pb4u-local:\(folder.slug)",
                "folderName": folder.name,
                "nextSessionNumber": nextNum,
                "folderPath": dir.path
            ]
            let resData = (try? JSONSerialization.data(withJSONObject: res, options: [])) ?? Data()
            return String(data: resData, encoding: .utf8) ?? "{}"
        }

        // Save photo
        guard let b64 = dict["imageBase64"] as? String,
              let imgData = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else {
            return "{\"ok\":false,\"error\":\"No photo data\"}"
        }

        var filename = safeName(dict["filename"] as? String)
        if filename.isEmpty {
            filename = "photo-\(Int64(Date().timeIntervalSince1970 * 1000)).jpg"
        }
        if !filename.lowercased().hasSuffix(".jpg") && !filename.lowercased().hasSuffix(".png") {
            filename += ".jpg"
        }

        let destFile = dir.appendingPathComponent(filename)
        do {
            try imgData.write(to: destFile)
        } catch {
            return "{\"ok\":false,\"error\":\"Write failed\"}"
        }

        // Also save copy to iOS Camera Roll for convenience
        if let image = UIImage(data: imgData) {
            UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
        }

        let res: [String: Any] = [
            "ok": true,
            "filename": filename,
            "path": destFile.path,
            "url": "/e/\(folder.slug)/f/\(filename)",
            "pageUrl": "/e/\(folder.slug)/p/\(filename)"
        ]

        let resData = (try? JSONSerialization.data(withJSONObject: res, options: [])) ?? Data()
        return String(data: resData, encoding: .utf8) ?? "{}"
    }

    func lanBase() -> String {
        let ip = getWiFiAddress() ?? "127.0.0.1"
        let port = LocalShareServer.shared.activePort
        return "http://\(ip):\(port)"
    }

    func photosPath() -> String {
        return rootDir.path
    }

    // Helper to get iPad Wi-Fi IP address
    private func getWiFiAddress() -> String? {
        var address: String?
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            let addr = ptr.pointee.ifa_addr.pointee

            if (flags & (IFF_UP | IFF_RUNNING | IFF_LOOPBACK)) == (IFF_UP | IFF_RUNNING) {
                if addr.sa_family == UInt8(AF_INET) {
                    let name = String(cString: ptr.pointee.ifa_name)
                    if name == "en0" { // Standard iOS Wi-Fi interface
                        var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                        getnameinfo(ptr.pointee.ifa_addr, socklen_t(addr.sa_len), &hostname, socklen_t(hostname.count), nil, socklen_t(0), NI_NUMERICHOST)
                        address = String(cString: hostname)
                        break
                    }
                }
            }
        }
        freeifaddrs(ifaddr)
        return address
    }
}

