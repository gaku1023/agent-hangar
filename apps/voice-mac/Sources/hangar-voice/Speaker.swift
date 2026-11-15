import AVFoundation
import Foundation
import MLX
import MLXAudioCore
import MLXAudioTTS
import VoiceCore

/// 読み上げ。声は `os:<識別子>`（AVSpeechSynthesizer）か `kokoro:<声>`（Kokoro）。
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
