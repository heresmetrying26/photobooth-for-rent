import Foundation
import AVFoundation

/**
 * photobooth4u — iOS Speech Synthesizer Bridge (window.__PBVoice)
 *
 * Speaks event voice prompts ("Get ready!", "Three, Two, One... Smile!")
 * using Apple's AVSpeechSynthesizer, matching Android's VoiceBridge.kt contract.
 */
class VoiceBridge: NSObject {

    static let shared = VoiceBridge()
    private let synthesizer = AVSpeechSynthesizer()

    func voicesJson(lang: String) -> String {
        let wantFil = lang.lowercased().hasPrefix("fil") || lang.lowercased().hasPrefix("tl")
        let all = AVSpeechSynthesisVoice.speechVoices()
        var out: [[String: Any]] = []
        var seen = Set<String>()
        for v in all {
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
        if let data = try? JSONSerialization.data(withJSONObject: out, options: []),
           let str = String(data: data, encoding: .utf8) {
            return str
        }
        return "[]"
    }

    func speak(text: String, voiceName: String? = nil, volume: Float = 1.0) {
        stop()

        let utterance = AVSpeechUtterance(string: text)
        let all = AVSpeechSynthesisVoice.speechVoices()
        if let vn = voiceName, !vn.isEmpty,
           let matched = all.first(where: { $0.name == vn || $0.identifier == vn }) {
            utterance.voice = matched
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        }
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.98
        utterance.pitchMultiplier = 1.02
        utterance.volume = max(0.05, min(1.0, volume))

        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers, .duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)

        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }
}
