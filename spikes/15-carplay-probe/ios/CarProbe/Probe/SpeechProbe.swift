import Foundation
import AVFoundation
import Speech

struct TranscriptPiece: Sendable {
    let text: String
    let isFinal: Bool
    let at: Date
    /// 話し終わりの推定時刻。取れなければ nil（最後の partial の時刻で代用する）。
    var speechEnd: Date? = nil
    /// 発話の始まりの推定時刻。取れなければ nil（最初の piece の到着時刻で代用する）。
    var speechStart: Date? = nil
    /// 認識の実行時エラー。text は空。
    var error: String? = nil
    var source: String = ""
}

protocol Transcriber: Sendable {
    func start(locale: Locale) async throws -> AsyncStream<TranscriptPiece>
    func stop() async
}

/// 使えれば nil、使えなければ理由を返す。
typealias AnalyzerAvailability = @Sendable (Locale) async -> String?

/// マイクを AVAudioEngine で取り、バッファをクロージャに渡す。
final class MicTap: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private(set) var inputFormat: AVAudioFormat?
    func start(_ onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void) throws {
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        inputFormat = fmt
        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buf, _ in onBuffer(buf) }
        engine.prepare()
        try engine.start()
    }
    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

private final class ConverterBox: @unchecked Sendable { var c: AVAudioConverter? }

final class AnalyzerTranscriber: Transcriber, @unchecked Sendable {
    private let mic = MicTap()
    private let lock = NSLock()
    private var analyzer: SpeechAnalyzer?
    private var task: Task<Void, Never>?

    func start(locale: Locale) async throws -> AsyncStream<TranscriptPiece> {
        let transcriber = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
        let (inputs, inCont) = AsyncStream<AnalyzerInput>.makeStream()
        try await analyzer.start(inputSequence: inputs)
        lock.withLock { self.analyzer = analyzer }

        let (out, outCont) = AsyncStream<TranscriptPiece>.makeStream()
        let wallStart = Date()
        task = Task {
            do {
                for try await r in transcriber.results {
                    let text = String(r.text.characters)
                    let end = wallStart.addingTimeInterval(r.range.end.seconds)
                    let start = wallStart.addingTimeInterval(r.range.start.seconds)
                    outCont.yield(TranscriptPiece(text: text, isFinal: r.isFinal, at: Date(), speechEnd: r.isFinal ? end : nil, speechStart: start))
                }
            } catch {
                outCont.yield(TranscriptPiece(text: "", isFinal: false, at: Date(), error: "\(error)", source: "analyzer"))
            }
            outCont.finish()
        }
        let box = ConverterBox()
        try mic.start { buf in
            var b = buf
            if let target, buf.format != target {
                if box.c == nil { box.c = AVAudioConverter(from: buf.format, to: target) }
                let ratio = target.sampleRate / buf.format.sampleRate
                guard let c = box.c,
                      let o = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * ratio) + 1024)
                else { return }
                var given = false
                c.convert(to: o, error: nil) { _, status in
                    if given { status.pointee = .noDataNow; return nil }
                    given = true; status.pointee = .haveData; return buf
                }
                b = o
            }
            inCont.yield(AnalyzerInput(buffer: b))
        }
        return out
    }

    func stop() async {
        mic.stop()
        let a = lock.withLock { analyzer }
        await a?.cancelAndFinishNow()
        task?.cancel()
    }
}

final class LegacyTranscriber: Transcriber, @unchecked Sendable {
    private let mic = MicTap()
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var rtask: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var cont: AsyncStream<TranscriptPiece>.Continuation?
    private var stopped = false
    private var errors = 0

    func start(locale: Locale) async throws -> AsyncStream<TranscriptPiece> {
        guard let rec = SFSpeechRecognizer(locale: locale), rec.supportsOnDeviceRecognition else {
            throw NSError(domain: "LegacyTranscriber", code: 1, userInfo: [NSLocalizedDescriptionKey: "on-device 認識が使えない"])
        }
        recognizer = rec
        let (out, c) = AsyncStream<TranscriptPiece>.makeStream()
        cont = c
        newTask()
        try mic.start { [weak self] buf in
            guard let self else { return }
            self.lock.withLock { self.request }?.append(buf)
        }
        return out
    }

    /// 静かな車内で出る「音声が検出されなかった」系のエラー。打ち切りの数に入れない。
    static func isNoSpeech(domain: String, code: Int) -> Bool {
        (domain == "kAFAssistantErrorDomain" && [1110, 1107, 203].contains(code)) || (domain == "kLSRErrorDomain" && code == 201)
    }

    private func newTask() {
        guard let rec = recognizer, let cont else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        let began = Date()
        let t = rec.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let final = result.isFinal
                var end: Date?
                if final, let seg = result.bestTranscription.segments.last {
                    end = began.addingTimeInterval(seg.timestamp + seg.duration)
                }
                let start = result.bestTranscription.segments.first.map { began.addingTimeInterval($0.timestamp) }
                self.lock.withLock { self.errors = 0 }
                cont.yield(TranscriptPiece(text: result.bestTranscription.formattedString, isFinal: final, at: Date(), speechEnd: end, speechStart: start))
            }
            if let error {
                let ns = error as NSError
                let benign = LegacyTranscriber.isNoSpeech(domain: ns.domain, code: ns.code)
                let ranFor = Date().timeIntervalSince(began)
                let n: Int = self.lock.withLock {
                    if ranFor >= 10 { self.errors = 0 }
                    if !benign { self.errors += 1 }
                    return self.errors
                }
                cont.yield(TranscriptPiece(text: "", isFinal: false, at: Date(), error: "\(ns.domain) \(ns.code) \(error) (consecutive \(n), benign \(benign), ranFor \(Int(ranFor))s)", source: "legacy"))
                if n > 5 || self.lock.withLock({ self.stopped }) { cont.finish(); return }
                // 無音や短い失敗でも最低 1 秒は空けて、再起動が空回りしないようにする。
                let wait = benign ? 1.0 : Double(max(n, 1))
                Task { try? await Task.sleep(for: .seconds(wait)); if !self.lock.withLock({ self.stopped }) { self.newTask() } }
            } else if result?.isFinal == true {
                if !self.lock.withLock({ self.stopped }) { self.newTask() } else { cont.finish() }
            }
        }
        lock.withLock { request = req; rtask = t }
    }

    func stop() async {
        lock.withLock { stopped = true }
        mic.stop()
        lock.withLock { request }?.endAudio()
        lock.withLock { rtask }?.cancel()
        cont?.finish()
    }
}

@MainActor
final class SpeechProbe {
    private let store: EventStore
    private let speaker: any Speaking
    private let availability: AnalyzerAvailability
    private var lastPartial: Date?
    private var utteranceStart: Date?
    private var utteranceStartBasis = "firstPiece"
    private var lastPieceAt: Date?
    private var current: Transcriber?
    private var runTask: Task<Void, Never>?
    private var ticker: Task<Void, Never>?

    init(store: EventStore, speaker: any Speaking, availability: @escaping AnalyzerAvailability = SpeechProbe.defaultAvailability) {
        self.store = store
        self.speaker = speaker
        self.availability = availability
    }

    /// ja-JP が SpeechTranscriber で使えるか。未インストールなら取得を試みる。
    static let defaultAvailability: AnalyzerAvailability = { locale in
        guard SpeechTranscriber.isAvailable else { return "SpeechTranscriber が使えない端末" }
        let supported = await SpeechTranscriber.supportedLocales
        guard supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
            return "ロケール未対応"
        }
        let t = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let status = await AssetInventory.status(forModules: [t])
        if status >= .installed { return nil }
        do {
            if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
                try await req.downloadAndInstall()
            }
            return nil
        } catch {
            return "モデル取得に失敗: \(error.localizedDescription)"
        }
    }

    func makeTranscriber(locale: Locale) async -> Transcriber {
        if let reason = await availability(locale) {
            let s = store
            Task { await s.record("speech.fallback", ["reason": reason, "locale": locale.identifier]) }
            return LegacyTranscriber()
        }
        return AnalyzerTranscriber()
    }

    func start(locale: Locale = Locale(identifier: "ja-JP")) async {
        let t = await makeTranscriber(locale: locale)
        current = t
        do {
            let stream = try await t.start(locale: locale)
            runTask = Task { [weak self] in
                for await p in stream { self?.handle(p) }
            }
        } catch {
            let s = store, m = "\(error)"
            Task { await s.record("speech.error", ["error": m]) }
        }
    }

    func stop() async {
        runTask?.cancel(); ticker?.cancel()
        await current?.stop()
    }

    /// 60 秒ごとに生存確認を読む。テストでは起動しない。
    func startTicker() {
        ticker = Task { [weak self] in
            var n = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                n += 1
                self?.speaker.say("生存確認、\(n) 分")
            }
        }
    }

    func handle(_ p: TranscriptPiece) {
        let s = store
        if let e = p.error {
            let d = ["transcriber": p.source, "error": e]
            Task { await s.record("speech.error", d) }
            return
        }
        if speaker.isSpeaking { return }
        if let f = speaker.lastFinishedAt, p.at.timeIntervalSince(f) < 1.5 { return }
        if utteranceStart == nil {
            utteranceStart = p.speechStart ?? p.at
            utteranceStartBasis = p.speechStart == nil ? "firstPiece" : "audioRange"
        }
        if !p.isFinal {
            lastPieceAt = p.at
            if let l = lastPartial, p.at.timeIntervalSince(l) < 3 { return }
            lastPartial = p.at
            Task { await s.record("speech.partial", ["text": p.text]) }
            return
        }
        var start = utteranceStart ?? p.at
        var startBasis = utteranceStartBasis
        if let ps = p.speechStart { start = ps; startBasis = "audioRange" }
        let (end, basis) = p.speechEnd.map { ($0, "audioRange") } ?? (lastPieceAt ?? p.at, "lastPartial")
        let detail = [
            "text": p.text,
            "fromStartMs": String(Int(p.at.timeIntervalSince(start) * 1000)),
            "fromEndMs": String(Int(p.at.timeIntervalSince(end) * 1000)),
            "endBasis": basis,
            "startBasis": startBasis,
        ]
        utteranceStart = nil; lastPieceAt = nil
        Task { await s.record("speech.final", detail) }
        speaker.say("聞き取りました。\(p.text)")
    }
}
