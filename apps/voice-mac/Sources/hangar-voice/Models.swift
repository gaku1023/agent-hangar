import Foundation
import MLX
import MLXAudioCore
import MLXAudioSTT
import MLXAudioTTS
import MLXAudioVAD
import VoiceCore

/// 使うモデルの置き場。HANGAR_VOICE_ASR で認識のモデルを変えられる。
enum ModelRepos {
    static var asr: String {
        ProcessInfo.processInfo.environment["HANGAR_VOICE_ASR"] ?? "holotherapper/lilfugu-8bit"
    }
    static let vad = "mlx-community/silero-vad"
    static let tts = "mlx-community/Kokoro-82M-bf16"
}

/// Hugging Face のキャッシュに落としてあるか。mlx-audio-swift は
/// `<hub>/mlx-audio/<owner>_<name>` に置く。
func isCached(_ repo: String) -> Bool {
    let env = ProcessInfo.processInfo.environment
    let hub: URL
    if let h = env["HF_HUB_CACHE"], !h.isEmpty {
        hub = URL(fileURLWithPath: h)
    } else if let home = env["HF_HOME"], !home.isEmpty {
        hub = URL(fileURLWithPath: home).appendingPathComponent("hub")
    } else {
        hub = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache/huggingface/hub")
    }
    let dir = hub.appendingPathComponent("mlx-audio")
        .appendingPathComponent(repo.replacingOccurrences(of: "/", with: "_"))
    let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    return files.contains { $0.hasSuffix(".safetensors") }
}

/// async の関数を、呼んだスレッドで終わるまで待って返す。
/// MLX の仕事は Models.queue の上で 1 つずつ行うため、async の読み込みや生成もここで待つ。
private final class ResultBox<T>: @unchecked Sendable { var r: Result<T, Error>? }

func runBlocking<T>(_ body: @escaping () async throws -> T) throws -> T {
    let box = ResultBox<T>()
    let sem = DispatchSemaphore(value: 0)
    Task.detached {
        do { box.r = .success(try await body()) } catch { box.r = .failure(error) }
        sem.signal()
    }
    sem.wait()
    return try box.r!.get()
}

/// モデルを持ち、MLX を使う仕事を 1 本の列で順に行う。
/// VAD・認識・Kokoro を別々のスレッドから同時に動かさないため。
final class Models {
    let queue = DispatchQueue(label: "hangar-voice.mlx", qos: .userInitiated)

    // 以下は queue の上でだけ触る。
    private(set) var vad: SileroVAD?
    private(set) var asr: Qwen3ASRModel?
    private(set) var tts: SpeechGenerationModel?
    /// Kokoro に渡す文の処理。nil なら mlx-audio-swift の既定。Task 2b で日本語の読みに差し替える。
    var kokoroTextProcessor: TextProcessor? = nil

    /// 起動時に、キャッシュに無いモデルがあれば missing を出す。
    func announce() {
        let missing = [ModelRepos.vad, ModelRepos.asr, ModelRepos.tts].filter { !isCached($0) }
        if !missing.isEmpty {
            emit(.models(state: .missing, progress: 0, message: missing.joined(separator: ",")))
        }
    }

    /// 3 つを落として読み込む。進みを models で出す。
    func prepare() {
        queue.async {
            do {
                try self.load(listen: true, speak: true)
            } catch {
                emit(.models(state: .failed, progress: 0, message: "\(error)"))
            }
        }
    }

    /// queue の上で呼ぶ。聞き取りに要る VAD と認識を読み込む。
    func ensureListen() throws { try load(listen: true, speak: false) }

    /// queue の上で呼ぶ。Kokoro を読み込む。
    func ensureKokoro() throws -> SpeechGenerationModel {
        try load(listen: false, speak: true)
        return tts!
    }

    private func load(listen: Bool, speak: Bool) throws {
        var steps: [(String, () throws -> Void)] = []
        if listen, vad == nil {
            steps.append((ModelRepos.vad, { self.vad = try runBlocking { try await SileroVAD.fromPretrained(ModelRepos.vad) } }))
        }
        if listen, asr == nil {
            steps.append((ModelRepos.asr, { self.asr = try runBlocking { try await Qwen3ASRModel.fromPretrained(ModelRepos.asr) } }))
        }
        if speak, tts == nil {
            let tp = kokoroTextProcessor
            steps.append((ModelRepos.tts, {
                self.tts = try runBlocking { try await TTS.loadModel(modelRepo: ModelRepos.tts, textProcessor: tp) }
            }))
        }
        guard !steps.isEmpty else { return }
        for (i, (repo, run)) in steps.enumerated() {
            let state: ModelsState = isCached(repo) ? .loading : .downloading
            emit(.models(state: state, progress: Double(i) / Double(steps.count), message: repo))
            let t0 = Date()
            try run()
            if repo == ModelRepos.asr, let asr {
                // 最初の 1 回は Metal の準備で遅い（実測で 4 秒の区間に 3.8 秒）。読み込みのうちに済ませる。
                _ = asr.generate(audio: MLXArray.zeros([Recognizer.sampleRate]), language: "Japanese")
            }
            log("loaded \(repo) in \(String(format: "%.1f", Date().timeIntervalSince(t0)))s")
        }
        emit(.models(state: .ready, progress: 1, message: nil))
    }
}
