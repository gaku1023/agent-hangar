import AVFoundation
import Foundation
import MLX
import MLXAudioCore
import MLXAudioTTS
import VoiceCore

/// 読み上げ。声は `os:<識別子>`（AVSpeechSynthesizer）、`kokoro:<声>`（Kokoro）、`voicevox:<style>`・`aivis:<style>`（エンジンへ HTTP）。
/// 新しい speak か stopSpeaking が来たら、前の読み上げを止めて stopped を出す。
final class Speaker {
    private let models: Models
    private let capture: Capture?
    private let outDir: URL?
    // 以下は queue の上でだけ触る。
    private let queue = DispatchQueue(label: "hangar-voice.speaker")
    private var current: String?
    private var generation = 0
    private let synth = AVSpeechSynthesizer()

    /// outDir があれば鳴らさずに `<outDir>/<id>.wav` を書く。
    init(models: Models, capture: Capture?, outDir: String?) {
        self.models = models
        self.capture = capture
        self.outDir = outDir.map { URL(fileURLWithPath: $0) }
    }

    func speak(id: String, text: String, voice: String, speed: Double) {
        queue.async {
            self.stopLocked()
            self.generation += 1
            let gen = self.generation
            self.current = id
            guard let spec = VoiceSpec(voice) else {
                emit(.error(code: "voice", message: "unknown voice \(voice)"))
                self.finish(id: id, gen: gen, state: .stopped)
                return
            }
            let deliver: ([Float], Int) -> Void = { samples, rate in
                self.queue.async { self.output(id: id, gen: gen, samples: samples, sampleRate: rate) }
            }
            switch spec {
            case .os(let identifier): self.synthesizeOS(text: text, identifier: identifier, speed: speed, gen: gen, id: id, deliver: deliver)
            case .kokoro(let v): self.synthesizeKokoro(text: text, voice: v, speed: speed, gen: gen, id: id, deliver: deliver)
            case .voicevox(let style): self.synthesizeEngine(.voicevox, style: style, text: text, speed: speed, deliver: deliver)
            case .aivis(let style): self.synthesizeEngine(.aivis, style: style, text: text, speed: speed, deliver: deliver)
            }
        }
    }

    func stop() {
        queue.async { self.stopLocked() }
    }

    private func stopLocked() {
        guard let id = current else { return }
        generation += 1
        current = nil
        synth.stopSpeaking(at: .immediate)
        capture?.stopPlayback()
        emit(.speaking(id: id, state: .stopped))
    }

    private func finish(id: String, gen: Int, state: SpeakingState) {
        guard gen == generation, current == id else { return }
        current = nil
        emit(.speaking(id: id, state: state))
    }

    private func output(id: String, gen: Int, samples: [Float], sampleRate: Int) {
        guard gen == generation else { return }
        if samples.isEmpty {
            emit(.error(code: "tts", message: "no audio"))
            finish(id: id, gen: gen, state: .stopped)
            return
        }
        emit(.speaking(id: id, state: .start))
        if let outDir {
            let safe = id.replacingOccurrences(of: "/", with: "_")
            let url = outDir.appendingPathComponent("\(safe).wav")
            do {
                try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
                try AudioUtils.writeWavFile(samples: samples, sampleRate: sampleRate, fileURL: url)
            } catch {
                emit(.error(code: "tts", message: "\(error)"))
            }
            finish(id: id, gen: gen, state: .end)
            return
        }
        guard let capture else { return }
        capture.play(samples: samples, sampleRate: sampleRate) {
            self.queue.async { self.finish(id: id, gen: gen, state: .end) }
        }
    }

    private func synthesizeOS(
        text: String, identifier: String, speed: Double, gen: Int, id: String,
        deliver: @escaping ([Float], Int) -> Void
    ) {
        let u = AVSpeechUtterance(string: text)
        if let v = AVSpeechSynthesisVoice(identifier: identifier) {
            u.voice = v
        } else {
            emit(.error(code: "voice", message: "voice not found: \(identifier)"))
            u.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        }
        u.rate = osSpeechRate(
            speed: speed, defaultRate: AVSpeechUtteranceDefaultSpeechRate,
            minRate: AVSpeechUtteranceMinimumSpeechRate, maxRate: AVSpeechUtteranceMaximumSpeechRate)
        var samples: [Float] = []
        var rate = 0
        var done = false
        // 書き出しの知らせは主の RunLoop で受ける。
        DispatchQueue.main.async {
            self.synth.write(u) { buffer in
                guard !done, let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 {
                    done = true
                    deliver(samples, rate)
                    return
                }
                rate = Int(pcm.format.sampleRate)
                samples.append(contentsOf: monoFloatSamples(pcm))
            }
        }
    }

    /// VOICEVOX 互換のエンジンに合成を頼む（audio_query → 速さを上書き → synthesis）。
    /// 失敗は error（code engine）を出して空の音を返す。output が end で閉じる。
    private func synthesizeEngine(
        _ kind: EngineKind, style: Int, text: String, speed: Double,
        deliver: @escaping ([Float], Int) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let base = engineBaseURL(kind, env: ProcessInfo.processInfo.environment)
                guard let qReq = audioQueryRequest(base: base, speaker: style, text: text) else {
                    throw EngineError.message("bad request")
                }
                let query = try httpBody(qReq)
                guard let body = rewriteSpeedScale(query, speed: speed),
                    let sReq = synthesisRequest(base: base, speaker: style, body: body)
                else { throw EngineError.message("bad audio_query response") }
                let wav = try httpBody(sReq)
                guard let decoded = decodeWav(wav) else { throw EngineError.message("unreadable wav") }
                deliver(decoded.samples, decoded.sampleRate)
            } catch {
                emit(.error(code: "engine", message: "\(kind): \(error)"))
                deliver([], 0)
            }
        }
    }

    private func synthesizeKokoro(
        text: String, voice: String, speed: Double, gen: Int, id: String,
        deliver: @escaping ([Float], Int) -> Void
    ) {
        models.queue.async {
            do {
                let model = try self.models.ensureKokoro()
                if let k = model as? KokoroModel { k.speed = Float(speed) }
                let audio = try runBlocking {
                    try await model.generate(text: text, voice: voice, refAudio: nil, refText: nil, language: "ja")
                }
                deliver(audio.asArray(Float.self), model.sampleRate)
            } catch {
                emit(.error(code: "tts", message: "\(error)"))
                deliver([], 0)
            }
        }
    }
}

enum EngineError: Error { case message(String) }

/// 同期の HTTP。10 秒（要求の timeoutInterval）で諦める。2xx 以外は失敗。
private func httpBody(_ req: URLRequest) throws -> Data {
    var result: Result<Data, Error> = .failure(EngineError.message("no response"))
    let sem = DispatchSemaphore(value: 0)
    let task = URLSession.shared.dataTask(with: req) { data, resp, err in
        if let err {
            result = .failure(err)
        } else if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            result = .failure(EngineError.message("HTTP \(http.statusCode)"))
        } else {
            result = .success(data ?? Data())
        }
        sem.signal()
    }
    task.resume()
    if sem.wait(timeout: .now() + engineTimeout + 2) == .timedOut {
        task.cancel()
        throw EngineError.message("timeout")
    }
    return try result.get()
}
