import Foundation
import AVFoundation

@MainActor
protocol Speaking: AnyObject {
    var isSpeaking: Bool { get }
    var lastFinishedAt: Date? { get }
    func say(_ text: String)
}

@MainActor
final class Speaker: NSObject, Speaking, AVSpeechSynthesizerDelegate {
    private let store: EventStore
    private let synth = AVSpeechSynthesizer()
    private var pendingCount = 0
    private(set) var lastFinishedAt: Date?
    var isSpeaking: Bool { pendingCount > 0 }

    init(store: EventStore) {
        self.store = store
        super.init()
        synth.delegate = self
    }

    func say(_ text: String) {
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        pendingCount += 1
        synth.speak(u)
    }

    private func record(_ kind: String, _ text: String) {
        let s = store
        Task { await s.record(kind, ["text": text]) }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        let t = u.speechString
        Task { @MainActor in self.record("tts.start", t) }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        let t = u.speechString
        Task { @MainActor in self.pendingCount = max(0, self.pendingCount - 1); self.lastFinishedAt = Date(); self.record("tts.finish", t) }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        let t = u.speechString
        Task { @MainActor in self.pendingCount = max(0, self.pendingCount - 1); self.lastFinishedAt = Date(); self.record("tts.finish", t) }
    }
}
