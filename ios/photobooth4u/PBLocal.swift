import Foundation
import UIKit
import Photos
import Network

/**
 * photobooth4u — iOS / iPadOS Local Event & Photo Storage
 *
 * Mirrors desktop/lib/photos.mjs and Android's PBLocal.kt.
 * Saves photos directly onto the iPad's Documents/Pictures/photobooth4u folder
 * and Photos Library. Guests scanning QR codes over local Wi-Fi download photos
 * from LocalShareServer.
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

    struct GuestCode: Codable {
        let slug: String
        var files: [String]
        let first: Int64
    }

    private let lock = NSLock()
    private var folders: [String: Folder] = [:]
    private var codes: [String: GuestCode] = [:]
    private let indexFile: URL
    private let codesFile: URL

    let rootDir: URL
    var guestView: String = "all"

    private let pathMonitor = NWPathMonitor()
    private var onlineNow = true
    var onOnlineChange: ((Bool) -> Void)?

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.rootDir = docs.appendingPathComponent("Pictures/photobooth4u")
        self.indexFile = docs.appendingPathComponent("folders.json")
        self.codesFile = docs.appendingPathComponent("guestcodes.json")

        try? FileManager.default.createDirectory(at: rootDir, withIntermediateDirectories: true)
        loadIndex()
        loadCodes()

        pathMonitor.pathUpdateHandler = { [weak self] path in
            let online = (path.status == .satisfied)
            self?.lock.lock()
            let changed = (self?.onlineNow != online)
            self?.onlineNow = online
            self?.lock.unlock()
            if changed {
                DispatchQueue.main.async {
                    self?.onOnlineChange?(online)
                }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.photobooth4u.netmon"))
    }

    func isOnline() -> Bool {
        lock.lock()
        let v = onlineNow
        lock.unlock()
        return v
    }

    // MARK: - Index & Guest Code Persistence

    private func loadIndex() {
        guard let data = try? Data(contentsOf: indexFile),
              let list = try? JSONDecoder().decode([Folder].self, from: data) else { return }
        for f in list { folders[f.slug] = f }
    }

    private func saveIndex() {
        let list = Array(folders.values)
        if let data = try? JSONEncoder().encode(list) {
            try? data.write(to: indexFile)
        }
    }

    private func loadCodes() {
        guard let data = try? Data(contentsOf: codesFile),
              let map = try? JSONDecoder().decode([String: GuestCode].self, from: data) else { return }
        codes = map
    }

    private func saveCodes() {
        if let data = try? JSONEncoder().encode(codes) {
            try? data.write(to: codesFile)
        }
    }

    func folderBySlug(_ slug: String) -> Folder? {
        lock.lock()
        defer { lock.unlock() }
        return folders[slug]
    }

    func guestCode(_ code: String) -> GuestCode? {
        lock.lock()
        defer { lock.unlock() }
        return codes[code]
    }

    func dirOf(folder: Folder) -> URL {
        if !folder.sub.isEmpty {
            return rootDir.appendingPathComponent(folder.name).appendingPathComponent(folder.sub)
        }
        return rootDir.appendingPathComponent(folder.name)
    }

    func galleryTitle(folder: Folder) -> String {
        return folder.sub.isEmpty ? folder.name : "\(folder.name) · \(folder.sub)"
    }

    private func categoryOf(_ name: String) -> String {
        let lower = name.lowercased()
        if lower.hasSuffix(".mp4") || lower.hasSuffix(".webm") || lower.hasSuffix(".mov") || lower.hasPrefix("360_") {
            return "360 Videos"
        }
        if lower.hasSuffix(".gif") || lower.contains("_gif.") {
            return "GIFs"
        }
        if lower.range(of: "_solo_\\d+", options: .regularExpression) != nil {
            return "Solo Shots"
        }
        return "Prints"
    }

    private let subdirs = ["Prints", "Solo Shots", "GIFs", "360 Videos"]

    func findFile(in dir: URL, name: String) -> URL? {
        guard !name.isEmpty, !name.hasPrefix("."), !name.contains("/"), !name.contains("\\"), !name.contains("..") else {
            return nil
        }
        let direct = dir.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: direct.path) { return direct }
        let cat = dir.appendingPathComponent(categoryOf(name)).appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: cat.path) { return cat }
        for sub in subdirs {
            let p = dir.appendingPathComponent(sub).appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: p.path) { return p }
        }
        return nil
    }

    func photosIn(dir: URL) -> [URL] {
        let exts = Set(["jpg", "jpeg", "png", "webp", "gif", "mp4", "webm"])
        var out: [URL] = []
        var seen = Set<String>()

        func scan(_ folderUrl: URL, rootLevel: Bool) {
            guard let items = try? FileManager.default.contentsOfDirectory(
                at: folderUrl,
                includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey]
            ) else { return }
            for u in items {
                let n = u.lastPathComponent
                if n.hasPrefix(".") || n == "done" || n == ".thumbs" { continue }
                let isDir = (try? u.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                if isDir {
                    if rootLevel && subdirs.contains(n) { scan(u, rootLevel: false) }
                } else if exts.contains(u.pathExtension.lowercased()) {
                    if seen.insert(n).inserted { out.append(u) }
                }
            }
        }
        scan(dir, rootLevel: true)

        return out.sorted { u1, u2 in
            let d1 = (try? u1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let d2 = (try? u2.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return d1 > d2
        }
    }

    // MARK: - Safe Naming

    private func safeName(_ str: String?) -> String {
        guard let s = str else { return "" }
        let invalid = CharacterSet(charactersIn: "\\/:*?\"<>|\0")
        var cleaned = s.components(separatedBy: invalid).joined(separator: " ")
        cleaned = cleaned.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        if cleaned.count > 80 { cleaned = String(cleaned.prefix(80)).trimmingCharacters(in: .whitespaces) }
        return cleaned
    }

    private func todayString() -> String {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"
        return fmt.string(from: Date())
    }

    private func nextSessionNumber(in dir: URL) -> Int {
        var maxNum = 0
        for u in photosIn(dir: dir) {
            let n = u.lastPathComponent
            if let r = n.range(of: "^(?:BONUS_)?(\\d+)_", options: .regularExpression) {
                let sub = String(n[r]).replacingOccurrences(of: "BONUS_", with: "").replacingOccurrences(of: "_", with: "")
                if let val = Int(sub), val > maxNum { maxNum = val }
            }
        }
        return maxNum + 1
    }

    private func folderFor(folderKey: String?, subfolder: String?) -> Folder {
        lock.lock()
        defer { lock.unlock() }

        var name = safeName(folderKey)
        if name.isEmpty { name = "Photobooth " + todayString() }
        let sub = safeName(subfolder)
        let id = (name + (sub.isEmpty ? "" : "/\(sub)")).lowercased()

        if let existing = folders.values.first(where: { $0.id == id }) {
            let dir = dirOf(folder: existing)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            return existing
        }

        let slug = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10).lowercased()
        let newFolder = Folder(slug: String(slug), id: id, name: name, sub: sub, at: Int64(Date().timeIntervalSince1970 * 1000))
        folders[newFolder.slug] = newFolder
        saveIndex()

        let dir = dirOf(folder: newFolder)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return newFolder
    }

    private func noteGuestFile(code: String?, slug: String, file: String) {
        guard let c = code, c.range(of: "^[A-Za-z0-9_-]{16,40}$", options: .regularExpression) != nil else { return }
        lock.lock()
        defer { lock.unlock() }
        var gc = codes[c] ?? GuestCode(slug: slug, files: [], first: Int64(Date().timeIntervalSince1970 * 1000))
        if gc.slug == slug && !gc.files.contains(file) && gc.files.count < 40 {
            gc.files.append(file)
        }
        codes[c] = gc
        saveCodes()
    }

    // MARK: - Drive Save Operation (window.__PBLocal.drive)

    func drive(body: String) -> String {
        guard let data = body.data(using: .utf8),
              let dict = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else {
            return jsonErr("Bad request")
        }

        let folder = folderFor(folderKey: dict["folderKey"] as? String, subfolder: dict["subfolder"] as? String)
        let dir = dirOf(folder: folder)
        let folderUrl = "pb4u-local:\(folder.slug)"
        let shownName = folder.sub.isEmpty ? folder.name : "\(folder.name) / \(folder.sub)"

        if let resolveOnly = dict["resolveOnly"] as? Bool, resolveOnly {
            return jsonStr([
                "ok": true,
                "folderUrl": folderUrl,
                "folderName": shownName,
                "nextSessionNumber": nextSessionNumber(in: dir),
                "folderPath": dir.path
            ])
        }

        guard let b64 = dict["imageBase64"] as? String, !b64.isEmpty,
              let imgData = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !imgData.isEmpty else {
            return jsonErr("No photo data")
        }

        var rawName = safeName(dict["filename"] as? String)
        if rawName.isEmpty { rawName = "photo-\(Int64(Date().timeIntervalSince1970 * 1000)).jpg" }
        let extRegex = "\\.(jpe?g|png|webp|gif|mp4|webm)$"
        if rawName.range(of: extRegex, options: [.regularExpression, .caseInsensitive]) == nil {
            rawName += ".jpg"
        }

        let cat = categoryOf(rawName)
        let targetDir = dir.appendingPathComponent(cat)
        try? FileManager.default.createDirectory(at: targetDir, withIntermediateDirectories: true)

        var candidate = rawName
        var idx = 2
        lock.lock()
        while FileManager.default.fileExists(atPath: targetDir.appendingPathComponent(candidate).path) ||
              FileManager.default.fileExists(atPath: dir.appendingPathComponent(candidate).path) {
            let base = (rawName as NSString).deletingPathExtension
            let ext = (rawName as NSString).pathExtension
            candidate = "\(base) (\(idx)).\(ext)"
            idx += 1
        }
        let destFile = targetDir.appendingPathComponent(candidate)
        do {
            try imgData.write(to: destFile)
        } catch {
            lock.unlock()
            return jsonErr("Write failed: \(error.localizedDescription)")
        }
        lock.unlock()

        noteGuestFile(code: dict["guestCode"] as? String, slug: folder.slug, file: candidate)

        // Save photos, animated GIFs, and videos directly to Apple Photos Library
        saveToPhotosLibrary(fileUrl: destFile, rawData: imgData)

        return jsonStr([
            "ok": true,
            "fileId": "\(folder.slug)/\(candidate)",
            "downloadUrl": "pb4u-local:\(folder.slug)/\(candidate)",
            "folderUrl": folderUrl,
            "folderName": shownName,
            "folderPath": dir.path,
            "filename": candidate,
            "url": "/e/\(folder.slug)/f/\(candidate)",
            "pageUrl": "/e/\(folder.slug)/p/\(candidate)"
        ])
    }

    func saveImage(fileName: String, base64: String) -> String {
        let name = safeName(fileName).isEmpty ? "photobooth4u.png" : safeName(fileName)
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), !data.isEmpty,
              let image = UIImage(data: data) else {
            return jsonErr("Could not decode image.")
        }
        let dest = rootDir.appendingPathComponent(name)
        try? data.write(to: dest)
        saveToPhotosLibrary(fileUrl: dest, rawData: data)
        return jsonStr(["ok": true, "dir": "Photos & Files"])
    }

    private func saveToPhotosLibrary(fileUrl: URL, rawData: Data) {
        let ext = fileUrl.pathExtension.lowercased()
        let isVideo = (ext == "mp4" || ext == "mov")
        let isImage = (ext == "jpg" || ext == "jpeg" || ext == "png" || ext == "gif" || ext == "webp")
        guard isVideo || isImage else { return }

        let performSave: () -> Void = {
            PHPhotoLibrary.shared().performChanges({
                if isVideo {
                    PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: fileUrl)
                } else {
                    PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: fileUrl)
                }
            }) { ok, _ in
                if !ok && !isVideo && ext != "gif", let img = UIImage(data: rawData) {
                    DispatchQueue.main.async {
                        UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
                    }
                }
            }
        }

        let status: PHAuthorizationStatus
        if #available(iOS 14, *) {
            status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        } else {
            status = PHPhotoLibrary.authorizationStatus()
        }
        if status == .authorized || status == .limited {
            performSave()
        } else if status == .notDetermined {
            if #available(iOS 14, *) {
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { newStatus in
                    if newStatus == .authorized || newStatus == .limited {
                        performSave()
                    }
                }
            } else {
                PHPhotoLibrary.requestAuthorization { newStatus in
                    if newStatus == .authorized {
                        performSave()
                    }
                }
            }
        }
    }

    func guestViewSet(_ mode: String) {
        lock.lock()
        guestView = mode.isEmpty ? "all" : mode
        lock.unlock()
    }

    func lanBase() -> String {
        let port = LocalShareServer.shared.activePort
        guard port > 0, let ip = getWiFiAddress() else { return "" }
        return "http://\(ip):\(port)"
    }

    func localBase() -> String {
        let port = LocalShareServer.shared.activePort
        return port > 0 ? "http://127.0.0.1:\(port)" : ""
    }

    func photosPath() -> String {
        return "Files › On My iPad › photobooth4u"
    }

    // MARK: - Network Address Picker (Wi-Fi en0 / Hotspot bridge100)

    private func getWiFiAddress() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        var bestIp: String?
        var bestScore = -100

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & (IFF_UP | IFF_RUNNING | IFF_LOOPBACK)) == (IFF_UP | IFF_RUNNING) else { continue }
            guard let ifaAddr = ptr.pointee.ifa_addr, ifaAddr.pointee.sa_family == UInt8(AF_INET) else { continue }

            let name = String(cString: ptr.pointee.ifa_name).lowercased()
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(ifaAddr, socklen_t(ifaAddr.pointee.sa_len), &hostname, socklen_t(hostname.count), nil, socklen_t(0), NI_NUMERICHOST)
            let ip = String(cString: hostname)

            var score: Int
            if ip.hasPrefix("192.168.") { score = 3 }
            else if ip.hasPrefix("10.") { score = 2 }
            else if ip.range(of: "^172\\.(1[6-9]|2\\d|3[01])\\.", options: .regularExpression) != nil { score = 1 }
            else { continue }

            if name == "en0" || name == "en1" || name.hasPrefix("bridge") { score += 3 }
            if name.hasPrefix("pdp_ip") || name.hasPrefix("utun") || name.hasPrefix("ipsec") { score -= 10 }

            if score > bestScore {
                bestScore = score
                bestIp = ip
            }
        }
        return bestScore > -5 ? bestIp : nil
    }

    private func jsonErr(_ msg: String) -> String {
        return jsonStr(["ok": false, "error": msg])
    }

    private func jsonStr(_ dict: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: dict, options: []),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
}
