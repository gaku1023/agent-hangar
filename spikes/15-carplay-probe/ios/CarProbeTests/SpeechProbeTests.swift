import Foundation
import XCTest
import AVFoundation
@testable import CarProbe

@MainActor
final class FakeSpeaker: Speaking {
    var isSpeaking = false
    var lastFinishedAt: Date?
    let micGate = MicGate()
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

    func test_echo_grace_window_after_tts_finish() async {
        let store = makeStore()
        let sp = FakeSpeaker()
        let t0 = Date(timeIntervalSince1970: 5000)
        sp.lastFinishedAt = t0
        let probe = SpeechProbe(store: store, speaker: sp, availability: { _ in nil })
        probe.handle(TranscriptPiece(text: "echo", isFinal: true, at: t0.addingTimeInterval(1)))
        probe.handle(TranscriptPiece(text: "real", isFinal: true, at: t0.addingTimeInterval(2)))
        _ = await events(store, "speech.final", expect: 1)
        try? await Task.sleep(for: .milliseconds(100))
        let all = await store.pending(limit: 1000).filter { $0.kind == "speech.final" }
        XCTAssertEqual(all.map { $0.detail["text"] }, ["real"])
    }

    func test_error_piece_is_recorded() async {
        let store = makeStore()
        let probe = SpeechProbe(store: store, speaker: FakeSpeaker(), availability: { _ in nil })
        probe.handle(TranscriptPiece(text: "", isFinal: false, at: Date(), error: "boom", source: "legacy"))
        let evs = await events(store, "speech.error", expect: 1)
        XCTAssertEqual(evs.first?.detail["transcriber"], "legacy")
        XCTAssertEqual(evs.first?.detail["error"], "boom")
    }

    func test_fromStartMs_uses_speechStart() async {
        let store = makeStore()
        let probe = SpeechProbe(store: store, speaker: FakeSpeaker(), availability: { _ in nil })
        let t = Date(timeIntervalSince1970: 9000)
        probe.handle(TranscriptPiece(text: "x", isFinal: true, at: t, speechEnd: t.addingTimeInterval(-0.5), speechStart: t.addingTimeInterval(-2)))
        let evs = await events(store, "speech.final", expect: 1)
        XCTAssertEqual(evs.first?.detail["fromStartMs"], "2000")
        XCTAssertEqual(evs.first?.detail["fromEndMs"], "500")
        XCTAssertEqual(evs.first?.detail["startBasis"], "audioRange")
    }

    func test_phrases_has_ten() {
        XCTAssertEqual(Phrases.all.count, 10)
        XCTAssertTrue(Phrases.all.contains("PR 42 をマージして"))
    }

    func test_no_speech_errors_are_benign() {
        XCTAssertTrue(LegacyTranscriber.isNoSpeech(domain: "kAFAssistantErrorDomain", code: 1110))
        XCTAssertFalse(LegacyTranscriber.isNoSpeech(domain: "kAFAssistantErrorDomain", code: 1))
    }

    func test_mic_gate_decision() {
        let now = Date()
        XCTAssertTrue(MicGate.shouldFeed(isSpeaking: false, lastFinishedAt: nil, now: now))
        XCTAssertFalse(MicGate.shouldFeed(isSpeaking: true, lastFinishedAt: nil, now: now))
        XCTAssertFalse(MicGate.shouldFeed(isSpeaking: false, lastFinishedAt: now.addingTimeInterval(-1.0), now: now))
        XCTAssertTrue(MicGate.shouldFeed(isSpeaking: false, lastFinishedAt: now.addingTimeInterval(-1.6), now: now))
    }

    func test_mic_gate_reports_only_transitions() {
        let gate = MicGate()
        let log = LockedLog()
        gate.setOnChange { log.add($0) }
        let t0 = Date()
        XCTAssertTrue(gate.shouldFeed(now: t0))
        gate.update(isSpeaking: true, lastFinishedAt: nil)
        XCTAssertFalse(gate.shouldFeed(now: t0))
        XCTAssertFalse(gate.shouldFeed(now: t0.addingTimeInterval(0.1)))
        gate.update(isSpeaking: false, lastFinishedAt: t0.addingTimeInterval(1))
        XCTAssertFalse(gate.shouldFeed(now: t0.addingTimeInterval(2)))
        XCTAssertTrue(gate.shouldFeed(now: t0.addingTimeInterval(2.6)))
        XCTAssertTrue(gate.shouldFeed(now: t0.addingTimeInterval(3)))
        XCTAssertEqual(log.values, [true, false])
    }

    func test_silence_keeps_length_and_is_zero() {
        let fmt = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
        let b = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 100)!
        b.frameLength = 100
        b.floatChannelData![0][5] = 0.5
        let s = MicGate.silence(like: b)
        XCTAssertEqual(s.frameLength, 100)
        XCTAssertEqual(s.floatChannelData![0][5], 0)
    }
}

final class LockedLog: @unchecked Sendable {
    private let lock = NSLock()
    private var v: [Bool] = []
    func add(_ x: Bool) { lock.withLock { v.append(x) } }
    var values: [Bool] { lock.withLock { v } }
}
