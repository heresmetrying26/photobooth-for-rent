import Foundation
import AVFoundation

/**
 * photobooth4u — iOS Speech Synthesizer Bridge (window.__PBVoice)
 *
 * Speaks event voice prompts ("Get ready!", "Three, Two, One... Smile!")
 * using Apple's AVSpeechSynthesizer, matching Android's VoiceBridge.kt contract.
 *
 * Speed matters here: the booth speaks a word every second during the countdown, and the page asks for the voice
 * list through a blocking call. Listing every voice on the iPad and switching the audio session each time made the
 * camera picture stall on every number. So the voice list is read once (in the background, at launch), the audio
 * session is set up once, and the speech engine is warmed up before the first guest.
 */
class VoiceBridge: NSObject {

    static let shared = VoiceBridge()

    private let synthesizer = AVSpeechSynthesizer()
    private let lock = NSLock()
    private var voices: [AVSpeechSynthesisVoice]?
    private var jsonByLang: [String: String] = [:]
    private var sessionReady = false
    private var warmed = false

    /// Called once when the app starts: reads the voices off the main thread and warms up the speech engine.
    func warmUp() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            _ = self.allVoices()
            _ = self.voicesJson(lang: "en")
            _ = self.voicesJson(lang: "fil")
            DispatchQueue.main.async {
                self.prepareSession()
                self.warmEngine()
            }
        }
    }

    private func allVoices() -> [AVSpeechSynthesisVoice] {
        lock.lock()
        if let v = voices {
            lock.unlock()
            return v
        }
        lock.unlock()
        let list = AVSpeechSynthesisVoice.speechVoices()
        lock.lock()
        voices = list
        lock.unlock()
        return list
    }

    func voicesJson(lang: String) -> String {
        let wantFil = lang.lowercased().hasPrefix("fil") || lang.lowercased().hasPrefix("tl")
        let cacheKey = wantFil ? "fil" : "en"
        lock.lock()
        if let cached = jsonByLang[cacheKey] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        var out: [[String: Any]] = []
        var seen = Set<String>()
        for v in allVoices() {
            let l = v.language.lowercased()
            let match = wantFil ? (l.hasPrefix("fil") || l.hasPrefix("tl")) : l.hasPrefix("en")
            guard match else { continue }
            let key = "\(v.name)|\(v.language)"
            if seen.contains(key) { continue }
            seen.insert(key)
            out.append([
                "name": v.name,
                "lang": v.language,
                "local": true
            ])
        }
        var result = "[]"
        if let data = try? JSONSerialization.data(withJSONObject: out, options: []),
           let str = String(data: data, encoding: .utf8) {
            result = str
        }
        if !out.isEmpty {
            lock.lock()
            jsonByLang[cacheKey] = result
            lock.unlock()
        }
        return result
    }

    /// play-and-record, not play-only: switching the audio session to play-only while the camera / microphone is open
    /// (video guestbook) cuts the microphone and can stall the camera picture. Done once, not for every word.
    private func prepareSession() {
        if sessionReady { return }
        let session = AVAudioSession.sharedInstance()
        if session.category != .playAndRecord {
            try? session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
        }
        try? session.setActive(true)
        sessionReady = true
    }

    /// The first spoken word loads the speech engine, which takes a noticeable moment. A silent word at start-up does it early.
    private func warmEngine() {
        if warmed { return }
        warmed = true
        let u = AVSpeechUtterance(string: " ")
        u.volume = 0
        synthesizer.speak(u)
    }

    func speak(text: String, voiceName: String? = nil, volume: Float = 1.0) {
        stop()
        prepareSession()

        let utterance = AVSpeechUtterance(string: text)
        if let vn = voiceName, !vn.isEmpty,
           let matched = allVoices().first(where: { $0.name == vn || $0.identifier == vn }) {
            utterance.voice = matched
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        }
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.98
        utterance.pitchMultiplier = 1.02
        utterance.volume = max(0.05, min(1.0, volume))

        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }
}
