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
        var at: Int64
    }

    struct GuestCode: Codable {
        let slug: String
        var files: [String]
        let first: Int64
    }

    struct SpinCloudContext {
        var folderKey: String = ""
        var eventName: String = ""
        var driveFolderId: String = ""
        var opKey: String = ""
        var licence: String = ""
        var mid: String = ""
        var token: String = ""
        var deviceId: String = ""
        var standaloneAllowed: Bool = false
    }

    private let lock = NSLock()
    // Serialize Apple Photos imports so saving composite + 4 solo photos doesn't spawn 5 concurrent assetsd transactions.
    private let photosQueue = DispatchQueue(label: "com.photobooth4u.photos", qos: .utility)
    private var folders: [String: Folder] = [:]
    private var codes: [String: GuestCode] = [:]
    private var onlineUrls: [String: String] = [:]
    private let indexFile: URL
    private let codesFile: URL
    private var _spinContext = SpinCloudContext()
    var spinContext: SpinCloudContext {
        get { lock.lock(); defer { lock.unlock() }; return _spinContext }
        set { lock.lock(); _spinContext = newValue; lock.unlock() }
    }

    let rootDir: URL
    var guestView: String = "all"

    private let pathMonitor = NWPathMonitor()
    private let onlineLock = NSLock()
    private var onlineNow = true
    var onOnlineChange: ((Bool) -> Void)?
    var onNetworkUpdate: ((Bool, String, String) -> Void)?

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.rootDir = docs.appendingPathComponent("Pictures/photobooth4u")
        self.indexFile = docs.appendingPathComponent("folders.json")
        self.codesFile = docs.appendingPathComponent("guestcodes.json")

        try? FileManager.default.createDirectory(at: rootDir, withIntermediateDirectories: true)
        loadIndex()
        loadCodes()

        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            let online = (path.status == .satisfied)
            self.onlineLock.lock()
            let changed = (self.onlineNow != online)
            self.onlineNow = online
            self.onlineLock.unlock()
            let lan = self.lanBase()
            let loc = self.localBase()
            DispatchQueue.main.async {
                self.onNetworkUpdate?(online, lan, loc)
                if changed {
                    self.onOnlineChange?(online)
                }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.photobooth4u.netmon"))
    }

    func isOnline() -> Bool {
        onlineLock.lock()
        let v = onlineNow
        onlineLock.unlock()
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

    func latestFolder() -> Folder? {
        lock.lock()
        defer { lock.unlock() }
        return folders.values.max { $0.at < $1.at }
    }

    func ensureDefaultEventFolder(name: String? = nil) -> Folder {
        let clean = safeName(name)
        if !clean.isEmpty {
            return folderFor(folderKey: clean, subfolder: nil)
        }
        let ctxKey = safeName(spinContext.folderKey)
        if !ctxKey.isEmpty {
            return folderFor(folderKey: ctxKey, subfolder: nil)
        }
        if let latest = latestFolder() {
            return latest
        }
        return folderFor(folderKey: nil, subfolder: nil)
    }

    func setOnlineShareUrl(slug: String, filename: String, url: String) {
        guard !slug.isEmpty, !filename.isEmpty, !url.isEmpty else { return }
        lock.lock()
        onlineUrls["\(slug)/\(filename)"] = url
        lock.unlock()
    }

    func onlineShareUrl(slug: String, filename: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return onlineUrls["\(slug)/\(filename)"]
    }

    func overlaysDirectory() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("pb360_overlays", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func findSessionFiles(in dir: URL, prefix: String) -> [URL] {
        guard !prefix.isEmpty else { return [] }
        return photosIn(dir: dir).filter {
            let n = $0.lastPathComponent
            return n.hasPrefix(prefix + "_") || n.hasPrefix(prefix + ".")
        }
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

    func photomanDirOf(folder: Folder) -> URL {
        let pmRoot = rootDir.appendingPathComponent("Photoman")
        if !folder.sub.isEmpty {
            return pmRoot.appendingPathComponent(folder.name).appendingPathComponent(folder.sub)
        }
        return pmRoot.appendingPathComponent(folder.name)
    }

    private func photomanDirFor(dir: URL) -> URL? {
        let rootPrefix = rootDir.standardizedFileURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/"
        let dirPath = dir.standardizedFileURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard dirPath.hasPrefix(rootPrefix) else { return nil }
        let rel = String(dirPath.dropFirst(rootPrefix.count))
        guard !rel.isEmpty, !rel.hasPrefix("Photoman/") else { return nil }
        return rootDir.appendingPathComponent("Photoman").appendingPathComponent(rel)
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

    private func findInBase(_ baseDir: URL, name: String) -> URL? {
        let direct = baseDir.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: direct.path) { return direct }
        let cat = baseDir.appendingPathComponent(categoryOf(name)).appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: cat.path) { return cat }
        for sub in subdirs {
            let p = baseDir.appendingPathComponent(sub).appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: p.path) { return p }
        }
        return nil
    }

    func findFile(in dir: URL, name: String) -> URL? {
        guard !name.isEmpty, !name.hasPrefix("."), !name.contains("/"), !name.contains("\\"), !name.contains("..") else {
            return nil
        }
        if let found = findInBase(dir, name: name) { return found }
        if let pmDir = photomanDirFor(dir: dir), let found = findInBase(pmDir, name: name) { return found }
        return nil
    }

    func photosIn(dir: URL) -> [URL] {
        let exts = Set(["jpg", "jpeg", "png", "webp", "gif", "mp4", "webm", "mov", "m4v"])
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
        if let pmDir = photomanDirFor(dir: dir), FileManager.default.fileExists(atPath: pmDir.path) {
            scan(pmDir, rootLevel: true)
        }

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

        if var existing = folders.values.first(where: { $0.id == id }) {
            existing.at = Int64(Date().timeIntervalSince1970 * 1000)
            folders[existing.slug] = existing
            saveIndex()
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
        // Parse JSON, decode base64, and write to disk inside a tight autoreleasepool so the multi-megabyte
        // UTF-8 body, parsed NSDictionary, base64 NSString, and decoded JPEG Data are all released BEFORE
        // guest-code metadata indexing and Apple Photos Library import begin (critical on 3 GB iPads).
        enum DriveOutcome {
            case earlyReturn(String)
            case saved(folderSlug: String, folderUrl: String, shownName: String, dirPath: String, candidate: String, destFile: URL, guestCode: String?)
        }

        let outcome: DriveOutcome = autoreleasepool {
            guard let data = body.data(using: .utf8),
                  let dict = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else {
                return .earlyReturn(jsonErr("Bad request"))
            }

            let folder = folderFor(folderKey: dict["folderKey"] as? String, subfolder: dict["subfolder"] as? String)
            let dir = dirOf(folder: folder)
            let folderUrl = "pb4u-local:\(folder.slug)"
            let shownName = folder.sub.isEmpty ? folder.name : "\(folder.name) / \(folder.sub)"

            if let resolveOnly = dict["resolveOnly"] as? Bool, resolveOnly {
                return .earlyReturn(jsonStr([
                    "ok": true,
                    "folderUrl": folderUrl,
                    "folderName": shownName,
                    "nextSessionNumber": nextSessionNumber(in: dir),
                    "folderPath": dir.path
                ]))
            }

            guard let b64 = dict["imageBase64"] as? String, !b64.isEmpty,
                  let imgData = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !imgData.isEmpty else {
                return .earlyReturn(jsonErr("No photo data"))
            }

            var rawName = safeName(dict["filename"] as? String)
            if rawName.isEmpty { rawName = "photo-\(Int64(Date().timeIntervalSince1970 * 1000)).jpg" }
            let extRegex = "\\.(jpe?g|png|webp|gif|mp4|webm)$"
            if rawName.range(of: extRegex, options: [.regularExpression, .caseInsensitive]) == nil {
                rawName += ".jpg"
            }

            let isPhotoman = (dict["photoman"] as? Bool == true) ||
                ((dict["photoman"] as? Int) == 1) ||
                ((dict["photoman"] as? String) == "1") ||
                ((dict["source"] as? String)?.lowercased() == "photoman")
            let pmDir = photomanDirOf(folder: folder)
            let baseDir = isPhotoman ? pmDir : dir
            let cat = categoryOf(rawName)
            let targetDir = baseDir.appendingPathComponent(cat)
            try? FileManager.default.createDirectory(at: targetDir, withIntermediateDirectories: true)

            var candidate = rawName
            var idx = 2
            lock.lock()
            while FileManager.default.fileExists(atPath: targetDir.appendingPathComponent(candidate).path) ||
                  FileManager.default.fileExists(atPath: baseDir.appendingPathComponent(candidate).path) ||
                  FileManager.default.fileExists(atPath: dir.appendingPathComponent(candidate).path) ||
                  FileManager.default.fileExists(atPath: dir.appendingPathComponent(cat).appendingPathComponent(candidate).path) ||
                  FileManager.default.fileExists(atPath: pmDir.appendingPathComponent(candidate).path) ||
                  FileManager.default.fileExists(atPath: pmDir.appendingPathComponent(cat).appendingPathComponent(candidate).path) ||
                  findFile(in: dir, name: candidate) != nil {
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
                return .earlyReturn(jsonErr("Write failed: \(error.localizedDescription)"))
            }
            lock.unlock()

            return .saved(
                folderSlug: folder.slug,
                folderUrl: folderUrl,
                shownName: shownName,
                dirPath: dir.path,
                candidate: candidate,
                destFile: destFile,
                guestCode: dict["guestCode"] as? String
            )
        }

        switch outcome {
        case .earlyReturn(let reply):
            return reply
        case .saved(let slug, let folderUrl, let shownName, let dirPath, let candidate, let destFile, let guestCode):
            noteGuestFile(code: guestCode, slug: slug, file: candidate)

            // Save photos, animated GIFs, and videos directly to Apple Photos Library
            saveToPhotosLibrary(fileUrl: destFile)

            return jsonStr([
                "ok": true,
                "fileId": "\(slug)/\(candidate)",
                "downloadUrl": "pb4u-local:\(slug)/\(candidate)",
                "folderUrl": folderUrl,
                "folderName": shownName,
                "folderPath": dirPath,
                "filename": candidate,
                "url": "/e/\(slug)/f/\(candidate)",
                "pageUrl": "/e/\(slug)/p/\(candidate)"
            ])
        }
    }

    struct SavedVideoResult {
        let ok: Bool
        let slug: String
        let eventTitle: String
        let filename: String
        let destURL: URL?
        let url: String
        let pageUrl: String
        let sessionUrl: String
        let error: String?
    }

    func saveVideoFile(from sourceURL: URL, folderKey: String?, subfolder: String?, filename: String?, saveToPhotos: Bool) -> SavedVideoResult {
        let folder = (folderKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? ensureDefaultEventFolder()
            : folderFor(folderKey: folderKey, subfolder: subfolder)
        let dir = dirOf(folder: folder)
        let targetDir = dir.appendingPathComponent("360 Videos", isDirectory: true)
        try? FileManager.default.createDirectory(at: targetDir, withIntermediateDirectories: true)

        let sessionNum = nextSessionNumber(in: dir)
        var rawName = safeName(filename)
        if rawName.isEmpty {
            rawName = "\(sessionNum)_360_spin.mp4"
        }
        let extRegex = "\\.(mp4|mov|webm|m4v)$"
        if rawName.range(of: extRegex, options: [.regularExpression, .caseInsensitive]) == nil {
            rawName += ".mp4"
        }

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
            try FileManager.default.copyItem(at: sourceURL, to: destFile)
        } catch {
            lock.unlock()
            return SavedVideoResult(ok: false, slug: folder.slug, eventTitle: galleryTitle(folder: folder), filename: "", destURL: nil, url: "", pageUrl: "", sessionUrl: "", error: error.localizedDescription)
        }
        lock.unlock()

        if saveToPhotos {
            saveToPhotosLibrary(fileUrl: destFile)
        }

        let prefix = candidate.components(separatedBy: "_").first ?? candidate
        let encName = candidate.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? candidate
        let encPref = prefix.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? prefix
        return SavedVideoResult(
            ok: true,
            slug: folder.slug,
            eventTitle: galleryTitle(folder: folder),
            filename: candidate,
            destURL: destFile,
            url: "/e/\(folder.slug)/f/\(encName)",
            pageUrl: "/e/\(folder.slug)/p/\(encName)",
            sessionUrl: "/e/\(folder.slug)/s/\(encPref)",
            error: nil
        )
    }

    func saveImage(fileName: String, base64: String) -> String {
        let name = safeName(fileName).isEmpty ? "photobooth4u.png" : safeName(fileName)
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), !data.isEmpty,
              UIImage(data: data) != nil else {
            return jsonErr("Could not decode image.")
        }
        let dest = rootDir.appendingPathComponent(name)
        try? data.write(to: dest)
        saveToPhotosLibrary(fileUrl: dest)
        return jsonStr(["ok": true, "dir": "Photos & Files"])
    }

    /// Asks for permission to add photos to the Photos app when the app starts, so the iPad's permission box does not
    /// pop up over the camera during the first guest's photo. Does nothing once the question has been answered.
    func requestPhotosAccess() {
        if #available(iOS 14, *) {
            if PHPhotoLibrary.authorizationStatus(for: .addOnly) == .notDetermined {
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { _ in }
            }
        } else if PHPhotoLibrary.authorizationStatus() == .notDetermined {
            PHPhotoLibrary.requestAuthorization { _ in }
        }
    }

    private func saveToPhotosLibrary(fileUrl: URL) {
        let ext = fileUrl.pathExtension.lowercased()
        let isVideo = (ext == "mp4" || ext == "mov")
        let isImage = (ext == "jpg" || ext == "jpeg" || ext == "png" || ext == "gif" || ext == "webp")
        guard isVideo || isImage else { return }

        let performSave: () -> Void = { [weak self] in
            self?.photosQueue.async {
                let sema = DispatchSemaphore(value: 0)
                PHPhotoLibrary.shared().performChanges({
                    if isVideo {
                        PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: fileUrl)
                    } else {
                        PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: fileUrl)
                    }
                }) { ok, _ in
                    if !ok && !isVideo && ext != "gif" {
                        autoreleasepool {
                            if let diskData = try? Data(contentsOf: fileUrl),
                               let img = UIImage(data: diskData) {
                                DispatchQueue.main.async {
                                    UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
                                }
                            }
                        }
                    }
                    sema.signal()
                }
                _ = sema.wait(timeout: .now() + 10.0)
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

    func stationUrl() -> String {
        let base = lanBase()
        return base.isEmpty ? "" : "\(base)/station"
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
