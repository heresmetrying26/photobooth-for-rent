import Foundation
import CryptoKit
import UIKit

/**
 * photobooth4u — iOS / iPadOS Licence Verification
 *
 * Swift port of desktop/lib/licence.mjs and Android's AppLicence.kt.
 * Talks to the SAME POST /api/license endpoint and checks the SAME Ed25519-signed licence:
 *   PB4U-LIC1.<payload base64url>.<signature base64url>
 */
class AppLicence {

    static let shared = AppLicence()

    static let appVersion = "1.1.21"
    static let serverUrl = "https://photobooth4u.netlify.app"
    private static let prefix = "PB4U-LIC1"
    private static let checkEveryMs: Int64 = 10 * 60_000
    private static let clockSlackMs: Int64 = 6 * 3_600_000

    // Raw 32 bytes of the Ed25519 public key (desktop/license-pubkey.txt)
    private static let pubKeyBytes: [UInt8] = [
        0x4B, 0xB8, 0xF2, 0x8E, 0xBB, 0x41, 0x7F, 0xD3,
        0x6E, 0x7A, 0x0C, 0x1D, 0x84, 0x46, 0xBB, 0x66,
        0xA1, 0x3B, 0xFA, 0xAE, 0xA8, 0xFC, 0x7B, 0xF9,
        0x35, 0x8E, 0xD9, 0x23, 0x87, 0xB6, 0xA4, 0x01
    ]

    struct Status {
        let ok: Bool
        let reason: String   // "" | "none" | "invalid" | "revoked" | "clock" | "expired" | "checkin"
        let message: String
        let payload: [String: Any]?
        let warn: String
    }

    private let defaults = UserDefaults.standard
    private let stateLock = NSLock()
    private let keyState = "pb4u_licence_state"
    private let keyLegacy = "pb4u_licence_token"
    private let keyRandomId = "pb4u_random_mid"

    private var lic: String?
    private var seen: Int64 = 0
    private var revokedReason: String?
    private var revokedError: String?
    private var lastCheck: Int64 = 0
    private var lastTry: Int64 = 0
    private var skew: Int64 = 0
    private var cachedMid: String?

    private init() {
        loadState()
        if lic == nil, let legacy = defaults.string(forKey: keyLegacy), !legacy.isEmpty, readLicence(legacy) != nil {
            store(legacy)
            defaults.removeObject(forKey: keyLegacy)
        }
    }

    // MARK: - Device Identity

    func machineId() -> String {
        stateLock.lock()
        if let m = cachedMid {
            stateLock.unlock()
            return m
        }
        stateLock.unlock()

        let raw: String
        if let vid = UIDevice.current.identifierForVendor?.uuidString, !vid.isEmpty {
            raw = vid
        } else if let saved = defaults.string(forKey: keyRandomId), !saved.isEmpty {
            raw = saved
        } else {
            let gen = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            defaults.set(gen, forKey: keyRandomId)
            raw = gen
        }

        let digest = Array(SHA256.hash(data: Data(("pb4u-mid|" + raw.uppercased()).utf8)))
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        var chars = ""
        for i in 0..<16 {
            if i > 0 && i % 4 == 0 { chars.append("-") }
            chars.append(alphabet[Int(digest[i]) % 32])
        }
        let mid = "IPD-\(chars)"

        stateLock.lock()
        cachedMid = mid
        stateLock.unlock()
        return mid
    }

    func appVersion() -> String {
        if let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String, !v.isEmpty {
            return v
        }
        return AppLicence.appVersion
    }

    func currentLicenceString() -> String? {
        stateLock.lock()
        let v = lic
        stateLock.unlock()
        return v
    }

    private func deviceName() -> String {
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return String(name.prefix(60)) }
        let model = UIDevice.current.model.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.isEmpty ? "iPad" : String(model.prefix(60))
    }

    // MARK: - Ed25519 Licence Parsing

    func readLicence(_ licText: String?) -> [String: Any]? {
        guard let raw = licText else { return nil }
        let cleaned = raw.replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
        let parts = cleaned.components(separatedBy: ".")
        guard parts.count == 3, parts[0] == AppLicence.prefix else { return nil }
        guard let payloadData = base64UrlDecode(parts[1]),
              let sigData = base64UrlDecode(parts[2]),
              let json = (try? JSONSerialization.jsonObject(with: payloadData, options: [])) as? [String: Any] else {
            return nil
        }
        do {
            let pubKey = try Curve25519.Signing.PublicKey(rawRepresentation: AppLicence.pubKeyBytes)
            let signedBody = Data((parts[0] + "." + parts[1]).utf8)
            guard pubKey.isValidSignature(sigData, for: signedBody) else { return nil }
            guard (json["typ"] as? String) == "pb4u-desktop" else { return nil }
            return json
        } catch {
            return nil
        }
    }

    // MARK: - Sealed State Persistence

    private func stateKey() -> SymmetricKey {
        let digest = SHA256.hash(data: Data(("pb4u-state|" + machineId()).utf8))
        return SymmetricKey(data: digest)
    }

    private func hmacHex(_ text: String) -> String {
        let code = HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: stateKey())
        return code.map { String(format: "%02x", $0) }.joined()
    }

    private func loadState() {
        guard let raw = defaults.string(forKey: keyState),
              let outerData = raw.data(using: .utf8),
              let outer = (try? JSONSerialization.jsonObject(with: outerData, options: [])) as? [String: Any],
              let body = outer["body"] as? String,
              let mac = outer["mac"] as? String,
              hmacHex(body) == mac,
              let bodyData = body.data(using: .utf8),
              let s = (try? JSONSerialization.jsonObject(with: bodyData, options: [])) as? [String: Any] else {
            return
        }
        stateLock.lock()
        lic = s["lic"] as? String
        seen = (s["seen"] as? NSNumber)?.int64Value ?? 0
        revokedReason = s["revokedReason"] as? String
        revokedError = s["revokedError"] as? String
        lastCheck = (s["lastCheck"] as? NSNumber)?.int64Value ?? 0
        lastTry = (s["lastTry"] as? NSNumber)?.int64Value ?? 0
        skew = (s["skew"] as? NSNumber)?.int64Value ?? 0
        stateLock.unlock()
    }

    private func saveState() {
        stateLock.lock()
        var s: [String: Any] = [
            "seen": seen,
            "lastCheck": lastCheck,
            "lastTry": lastTry,
            "skew": skew
        ]
        if let l = lic { s["lic"] = l }
        if let rr = revokedReason { s["revokedReason"] = rr }
        if let re = revokedError { s["revokedError"] = re }
        stateLock.unlock()

        guard let bodyData = try? JSONSerialization.data(withJSONObject: s, options: []),
              let body = String(data: bodyData, encoding: .utf8) else { return }
        let outer: [String: Any] = ["body": body, "mac": hmacHex(body)]
        if let outerData = try? JSONSerialization.data(withJSONObject: outer, options: []),
           let raw = String(data: outerData, encoding: .utf8) {
            defaults.set(raw, forKey: keyState)
        }
    }

    private func nowMs() -> Int64 {
        return Int64(Date().timeIntervalSince1970 * 1000.0)
    }

    private func touchClock() {
        let now = nowMs()
        stateLock.lock()
        if now > seen { seen = now }
        stateLock.unlock()
    }

    private func applyClockFrom(_ serverDateMs: Int64) {
        guard serverDateMs > 0 else { return }
        let now = nowMs()
        let off = now - serverDateMs
        stateLock.lock()
        skew = abs(off) > 36 * 3_600_000 ? off : 0
        seen = max(seen, min(now, serverDateMs + 3_600_000))
        stateLock.unlock()
    }

    private func store(_ licText: String) {
        let cleaned = licText.replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
        stateLock.lock()
        lic = cleaned
        revokedReason = nil
        revokedError = nil
        lastCheck = nowMs()
        skew = 0
        stateLock.unlock()
        touchClock()
        saveState()
    }

    // MARK: - Status Gate

    func verify() -> Status {
        return status()
    }

    func status() -> Status {
        let now = nowMs()
        stateLock.lock()
        let currentLic = lic
        let currentSeen = seen
        let currentRevReason = revokedReason
        let currentRevError = revokedError
        let currentSkew = skew
        stateLock.unlock()

        guard let l = currentLic, !l.isEmpty else {
            return Status(ok: false, reason: "none", message: "Activate this iPad with your photobooth4u rental code. It needs Wi-Fi once to activate, then keeps working offline.", payload: nil, warn: "")
        }
        guard let p = readLicence(l) else {
            return Status(ok: false, reason: "invalid", message: "This iPad's licence isn't valid. Activate it again with your code.", payload: nil, warn: "")
        }
        if (p["mid"] as? String) != machineId() {
            return Status(ok: false, reason: "invalid", message: "This licence isn't for this iPad. Activate it again with your code.", payload: nil, warn: "")
        }
        if currentRevReason != nil {
            let msg = (currentRevError?.isEmpty == false) ? currentRevError! : "This iPad's code was cancelled. Activate it again with your code."
            return Status(ok: false, reason: "revoked", message: msg, payload: p, warn: "")
        }
        if currentSkew != 0 {
            return Status(ok: false, reason: "clock", message: "This iPad's date and time are wrong. Turn on Set Automatically in Settings > General > Date & Time, then try again.", payload: p, warn: "")
        }
        let iat = (p["iat"] as? NSNumber)?.int64Value ?? 0
        if now < currentSeen - AppLicence.clockSlackMs || now < iat - AppLicence.clockSlackMs {
            return Status(ok: false, reason: "clock", message: "This iPad's clock was set back. Turn on Set Automatically in Settings > General > Date & Time, then try again.", payload: p, warn: "")
        }
        let expNum = p["exp"] as? NSNumber
        let hasExp = expNum != nil
        let exp = expNum?.int64Value ?? 0
        if hasExp && now >= exp {
            return Status(ok: false, reason: "expired", message: "This code has ended. Message us to book again.", payload: p, warn: "")
        }
        let hard = (p["hard"] as? NSNumber)?.int64Value ?? 0
        if hard > 0 && now >= hard {
            return Status(ok: false, reason: "checkin", message: "Connect this iPad to Wi-Fi once so it can renew its licence — it needs to every few weeks.", payload: p, warn: "")
        }
        var warn = ""
        let chk = (p["chk"] as? NSNumber)?.int64Value ?? 0
        if !hasExp && chk > 0 && now >= chk {
            warn = "Connect to Wi-Fi soon: this iPad needs to renew its licence."
        }
        return Status(ok: true, reason: "", message: "Active", payload: p, warn: warn)
    }

    // MARK: - Network Calls (/api/license)

    private struct NetResult {
        let status: Int
        let json: [String: Any]
        let dateMs: Int64
    }

    private func parseHttpDate(_ str: String?) -> Int64 {
        guard let s = str, !s.isEmpty else { return 0 }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(abbreviation: "GMT")
        fmt.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let d = fmt.date(from: s) {
            return Int64(d.timeIntervalSince1970 * 1000.0)
        }
        return 0
    }

    private func postLicense(body: [String: Any], timeout: TimeInterval, completion: @escaping (NetResult?) -> Void) {
        guard let url = URL(string: "\(AppLicence.serverUrl)/api/license"),
              let payload = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            completion(nil)
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        req.httpBody = payload

        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else {
                completion(nil)
                return
            }
            let json: [String: Any]
            if let d = data, let parsed = (try? JSONSerialization.jsonObject(with: d, options: [])) as? [String: Any] {
                json = parsed
            } else {
                json = [:]
            }
            let dateHeader = http.value(forHTTPHeaderField: "Date")
            let dateMs = self?.parseHttpDate(dateHeader) ?? 0
            completion(NetResult(status: http.statusCode, json: json, dateMs: dateMs))
        }.resume()
    }

    func activate(code: String, completion: @escaping (_ ok: Bool, _ error: String?) -> Void) {
        let c = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !c.isEmpty else {
            completion(false, "Type your rental code first.")
            return
        }
        let body: [String: Any] = [
            "action": "activate",
            "code": c,
            "mid": machineId(),
            "name": deviceName(),
            "os": "ios",
            "ver": appVersion()
        ]
        postLicense(body: body, timeout: 20.0) { [weak self] res in
            guard let self = self else { return }
            guard let res = res else {
                DispatchQueue.main.async {
                    completion(false, "Can't reach photobooth4u. Check Wi-Fi and try again.")
                }
                return
            }
            let licText = (res.json["licence"] as? String) ?? ""
            let okFlag = (res.json["ok"] as? NSNumber)?.boolValue ?? false
            if res.status != 200 || !okFlag || self.readLicence(licText) == nil {
                let errMsg = (res.json["error"] as? String) ?? "Activation failed (\(res.status))."
                DispatchQueue.main.async {
                    completion(false, errMsg)
                }
                return
            }
            self.applyClockFrom(res.dateMs)
            self.store(licText)
            DispatchQueue.main.async {
                completion(true, nil)
            }
        }
    }

    func checkin(force: Bool = false, completion: ((String) -> Void)? = nil) {
        stateLock.lock()
        let currentLic = lic
        let currentTry = lastTry
        let currentSkew = skew
        stateLock.unlock()

        guard let l = currentLic, !l.isEmpty else {
            completion?("skip")
            return
        }
        let now = nowMs()
        if !force && (now - currentTry) < AppLicence.checkEveryMs && currentSkew == 0 {
            completion?("skip")
            return
        }
        stateLock.lock()
        lastTry = now
        stateLock.unlock()
        saveState()

        let body: [String: Any] = [
            "action": "checkin",
            "licence": l,
            "mid": machineId(),
            "ver": appVersion()
        ]
        postLicense(body: body, timeout: 15.0) { [weak self] res in
            guard let self = self else { return }
            guard let res = res else {
                DispatchQueue.main.async { completion?("offline") }
                return
            }
            self.applyClockFrom(res.dateMs)
            let okFlag = (res.json["ok"] as? NSNumber)?.boolValue ?? false
            if res.status == 200 && okFlag,
               let newLic = res.json["licence"] as? String,
               self.readLicence(newLic) != nil {
                self.store(newLic)
                DispatchQueue.main.async { completion?("ok") }
                return
            }
            let revoked = (res.json["revoked"] as? NSNumber)?.boolValue ?? false
            if revoked {
                self.stateLock.lock()
                self.revokedReason = (res.json["reason"] as? String) ?? "removed"
                self.revokedError = (res.json["error"] as? String) ?? ""
                self.lastCheck = self.nowMs()
                self.stateLock.unlock()
                self.saveState()
                DispatchQueue.main.async { completion?("revoked") }
                return
            }
            self.saveState()
            DispatchQueue.main.async { completion?("offline") }
        }
    }

    private func base64UrlDecode(_ str: String) -> Data? {
        var base64 = str.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 {
            base64.append("=")
        }
        return Data(base64Encoded: base64)
    }
}
