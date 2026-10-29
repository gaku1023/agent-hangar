import Foundation
import XCTest
@testable import CarProbe

@MainActor
final class FakeSpeaker: Speaking {
    var isSpeaking = false
    var said: [String] = []
    func say(_ text: String) { said.append(text) }
}

final class FakeTranscriber: Transcriber {
    func start(locale: Locale) async throws -> AsyncStream<TranscriptPiece> { AsyncStream { $0.finish() } }
    func stop() async {}
}

@MainActor
final class SpeechProbeTests: XCTestCase {
    private func makeStore() -> EventStore {
        EventStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("sp-\(UUID().uuidString)"))
    }

    private func events(_ store: EventStore, _ kind: String, expect: Int) async -> [ProbeEvent] {
        var out: [ProbeEvent] = []
        for _ in 0..<200 {
            out = await store.pending(limit: 1000).filter { $0.kind == kind }
            if out.count >= expect { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return out
    }

    func test_fallback_is_logged_when_analyzer_unavailable() async {
        let store = makeStore()
        let probe = SpeechProbe(store: store, speaker: FakeSpeaker(), availability: { _ in "モデルなし" })
        let t = await probe.makeTranscriber(locale: Locale(identifier: "ja-JP"))
        XCTAssertTrue(t is LegacyTranscriber)
        let evs = await events(store, "speech.fallback", expect: 1)
        XCTAssertEqual(evs.count, 1)
        XCTAssertEqual(evs.first?.detail["reason"], "モデルなし")
    }

    func test_transcription_paused_while_speaking() async {
        let store = makeStore()
        let sp = FakeSpeaker()
        let probe = SpeechProbe(store: store, speaker: sp, availability: { _ in nil })
        sp.isSpeaking = true
        probe.handle(TranscriptPiece(text: "自分の声", isFinal: true, at: Date()))
        XCTAssertTrue(sp.said.isEmpty)
        sp.isSpeaking = false
        probe.handle(TranscriptPiece(text: "PR 42 をマージして", isFinal: true, at: Date()))
        XCTAssertEqual(sp.said, ["聞き取りました。PR 42 をマージして"])
        let finals = await events(store, "speech.final", expect: 1)
        try? await Task.sleep(for: .milliseconds(100))
        let all = await store.pending(limit: 1000).filter { $0.kind == "speech.final" }
        XCTAssertEqual(finals.count, 1)
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all.first?.detail["text"], "PR 42 をマージして")
        XCTAssertNotNil(all.first?.detail["endBasis"])
    }

    func test_partial_is_throttled_to_one_per_3s() async {
        let store = makeStore()
        var t = Date(timeIntervalSince1970: 1000)
        let probe = SpeechProbe(store: store, speaker: FakeSpeaker(), availability: { _ in nil })
        for i in 0..<5 {
            probe.handle(TranscriptPiece(text: "p\(i)", isFinal: false, at: t))
            t = t.addingTimeInterval(1)
        }
        let evs = await events(store, "speech.partial", expect: 2)
        try? await Task.sleep(for: .milliseconds(100))
        let all = await store.pending(limit: 1000).filter { $0.kind == "speech.partial" }
        XCTAssertEqual(all.count, 2)
        XCTAssertGreaterThanOrEqual(evs.count, 2)
    }

    func test_phrases_has_ten() {
        XCTAssertEqual(Phrases.all.count, 10)
        XCTAssertTrue(Phrases.all.contains("PR 42 をマージして"))
    }
}
