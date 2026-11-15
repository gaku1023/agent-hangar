import Foundation
import MLX
import MLXAudioCore
import MLXAudioSTT
import MLXAudioVAD
import VoiceCore

/// 16 kHz 単声の 512 サンプルの枠を受け、Silero VAD → 区切り → 認識の順に通す。
/// 仕事は全部 Models.queue の上で順に行う。
final class Recognizer {
    static let sampleRate = 16000

    private let models: Models
    // 以下は models.queue の上でだけ触る。
    private var segmenter = Segmenter()
    private var vadState: SileroVADStreamingState?
    private var context = ""
    private var counter = 0
    private var failed = false

    init(models: Models) { self.models = models }

    /// 認識に渡す語彙のヒント。
    func setHints(_ context: String) {
        models.queue.async {
            self.context = context
            log("hints \(context.count) chars")
        }
    }

    func push(frame: [Float]) {
        models.queue.async { self.handle(frame: frame) }
    }

    /// いまの区間をすぐ閉じて出す。emitFlushed なら、続けて flushed を出す。
    func flush(emitFlushed: Bool) {
        models.queue.async {
            self.deliver(self.segmenter.flush())
            if emitFlushed { emit(.flushed) }
        }
    }

    /// 聞き取りを止めたとき。途中の区間は出し、VAD の内側の状態は捨てる。
    func reset() {
        models.queue.async {
            self.deliver(self.segmenter.flush())
            self.vadState = nil
        }
    }

    private func handle(frame: [Float]) {
        do {
            try models.ensureListen()
            failed = false
        } catch {
            if !failed {
                emit(.models(state: .failed, progress: 0, message: "\(error)"))
                failed = true
            }
            return
        }
        guard let vad = models.vad else { return }
        let prob: Float
        do {
            let (p, st) = try vad.feed(chunk: MLXArray(frame), state: vadState, sampleRate: Self.sampleRate)
            vadState = st
            prob = p.asArray(Float.self).last ?? 0
        } catch {
            emit(.error(code: "vad", message: "\(error)"))
            return
        }
        deliver(segmenter.push(frame: frame, prob: prob))
    }

    private func deliver(_ outs: [SegmenterOutput]) {
        for o in outs {
            switch o {
            case .speechStart: emit(.vad(speech: true))
            case .speechEnd: emit(.vad(speech: false))
            case .segment(let samples, let dbfs): recognize(samples, dbfs: dbfs)
            }
        }
    }

    private func recognize(_ samples: [Float], dbfs: Float) {
        guard let asr = models.asr else { return }
        let t0 = Date()
        // 区間の前後に 300 ms の無音を足してから認識に渡す。2026-11-16 の実測（利用者の実声 15 文、
        // 語のヒントあり）で、区間のままでは語の当たりが 26/36、前後に足すと 29/36 だった。
        // 前を 150〜1000 ms 足した案もどれも 27〜28 で、区間の頭が詰まっていると外しやすい。
        let pad = [Float](repeating: 0, count: Self.sampleRate * 300 / 1000)
        let out = asr.generate(audio: MLXArray(pad + samples + pad), context: context, language: "Japanese")
        let text = out.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let ms = samples.count * 1000 / Self.sampleRate
        log(String(format: "asr %.2fs for %dms dbfs %.1f: %@", Date().timeIntervalSince(t0), ms, dbfs, text))
        counter += 1
        let id = "s\(counter)"
        // 確かめ用：HANGAR_VOICE_DUMP のフォルダに区間の音を書く。
        if let dir = ProcessInfo.processInfo.environment["HANGAR_VOICE_DUMP"], !dir.isEmpty {
            let url = URL(fileURLWithPath: dir).appendingPathComponent("\(id).wav")
            try? AudioUtils.writeWavFile(samples: samples, sampleRate: Self.sampleRate, fileURL: url)
        }
        guard !text.isEmpty else { return }
        emit(.segment(id: id, text: text, dbfs: Double(dbfs), ms: ms))
    }
}
