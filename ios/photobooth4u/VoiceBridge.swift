import Foundation
import AVFoundation

/**
 * photobooth4u — iOS Speech Synthesizer Bridge (window.__PBVoice)
 *
 * Speaks event voice prompts ("Get ready!", "Three, Two, One... Smile!")
 * using Apple's high quality AVSpeechSynthesizer.
 */
class VoiceBridge: NSObject {

    static let shared = VoiceBridge()
    private let synthesizer = AVSpeechSynthesizer()

    func speak(text: String, lang: String = "en-US") {
        stop()

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: lang)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        utterance.pitchMultiplier = 1.05
        utterance.volume = 1.0

        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)

        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }
}

