import Foundation
import CryptoKit
import UIKit

/**
 * photobooth4u — iOS Licence Verification
 *
 * Swift port of desktop/lib/licence.mjs and Android's AppLicence.kt.
 * Verifies the Ed25519-signed licence token using Apple's native CryptoKit:
 *   PB4U-LIC1.<payload base64url>.<signature base64url>
 */
class AppLicence {

    static let shared = AppLicence()

    static let appVersion = "1.0.0"
    static let serverUrl = "https://photobooth4u.netlify.app"
    private static let prefix = "PB4U-LIC1"

    // Raw 32 bytes of the Ed25519 public key (desktop/license-pubkey.txt)
    private static let pubKeyBytes: [UInt8] = [
        0x4B, 0xB8, 0xF2, 0x8E, 0xBB, 0x41, 0x7F, 0xD3,
        0x6E, 0x7A, 0x0C, 0x1D, 0x84, 0x46, 0xBB, 0x66,
        0xA1, 0x3B, 0xFA, 0xAE, 0xA8, 0xFC, 0x7B, 0xF9,
        0x35, 0x8E, 0xD9, 0x23, 0x87, 0xB6, 0xA4, 0x01
    ]

    struct Status {
        let ok: Bool
        let reason: String
        let message: String
        let payload: [String: Any]?
    }

    private let defaults = UserDefaults.standard
    private let keyLicence = "pb4u_licence_token"

    func machineId() -> String {
        let vendorId = UIDevice.current.identifierForVendor?.uuidString ?? "ios-device"
        let data = Data(("pb4u-mid|" + vendorId.uppercased()).utf8)
        let hash = SHA256.hash(data: data)
        return hash.compactMap { String(format: "%02x", $0) }.joined().prefix(16).lowercased()
    }

    func saveLicence(token: String) {
        defaults.set(token, forKey: keyLicence)
    }

    func loadLicence() -> String? {
        return defaults.string(forKey: keyLicence)
    }

    func verify() -> Status {
        guard let token = loadLicence(), !token.isEmpty else {
            return Status(ok: false, reason: "none", message: "Activate this iPad with your photobooth4u code.", payload: nil)
        }

        let parts = token.components(separatedBy: ".")
        guard parts.count == 3, parts[0] == AppLicence.prefix else {
            return Status(ok: false, reason: "invalid", message: "Licence code is invalid.", payload: nil)
        }

        guard let payloadData = base64UrlDecode(parts[1]),
              let sigData = base64UrlDecode(parts[2]),
              let json = (try? JSONSerialization.jsonObject(with: payloadData, options: [])) as? [String: Any] else {
            return Status(ok: false, reason: "invalid", message: "Licence cannot be parsed.", payload: nil)
        }

        // Verify Ed25519 signature via CryptoKit
        do {
            let pubKey = try Curve25519.Signing.PublicKey(rawRepresentation: AppLicence.pubKeyBytes)
            let signedMessage = Data((parts[0] + "." + parts[1]).utf8)
            let isValid = pubKey.isValidSignature(sigData, for: signedMessage)

            guard isValid else {
                return Status(ok: false, reason: "invalid", message: "Signature verification failed.", payload: nil)
            }

            // Check expiration
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            if let exp = json["exp"] as? Int64, exp < now {
                return Status(ok: false, reason: "expired", message: "Licence has expired.", payload: json)
            }

            return Status(ok: true, reason: "", message: "Active", payload: json)
        } catch {
            return Status(ok: false, reason: "invalid", message: "Crypto error", payload: nil)
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

