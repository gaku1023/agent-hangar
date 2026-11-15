import Foundation
import MLXAudioTTS
import VoiceCore

/// Kokoro に渡す日本語の文の処理。
/// mlx-audio-swift の既定（KokoroMultilingualProcessor）は日本語を 1 字ずつ byT5 で音素にし、別の文に聞こえる。
/// こちらは語に分けて読みを取り、かなの表で音素にする（VoiceCore の japaneseToPhonemes）。
/// 英字の語は、大文字だけの短い語（PR、CI）を文字の名前で読み、ほかは英語の G2P（misaki の英語）に回す。
/// 13 文の往復（読み上げて認識に戻す）で、英字をそのまま渡すと一致 0.74、この形で 0.87 だった。
final class JapaneseKokoroProcessor: TextProcessor, @unchecked Sendable {
    private let english = MisakiTextProcessor()
    private let lock = NSLock()
    private var englishReady = false

    /// Kokoro の読み込み（KokoroModel.fromPretrained）から呼ばれる。
    func prepare() async throws {
        // 英語の G2P は無くても日本語は読めるので、落とせなくても続ける（英字はそのまま渡す）。
        do {
            try await english.prepare()
            lock.withLock { englishReady = true }
        } catch {
            FileHandle.standardError.write(Data("hangar-voice: english g2p unavailable: \(error)\n".utf8))
        }
    }

    func process(text: String, language: String?) throws -> String {
        var opts = LatinOptions(spellAcronyms: true)
        if lock.withLock({ englishReady }) {
            let eng = english
            opts.english = { phrase in try? eng.process(text: phrase, language: "en-us") }
        }
        return japaneseToPhonemes(text, latin: opts)
    }
}
