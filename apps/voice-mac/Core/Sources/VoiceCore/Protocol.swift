import Foundation

// サーバと補助の 1 行 1 JSON の約束。

public enum Command: Equatable {
    case listen(on: Bool)
    case hints(context: String)
    case flush
    case speak(id: String, text: String, voice: String, speed: Double)
    case stopSpeaking
    case prepare
    case voices
    case quit
}

extension Command: Decodable {
    private enum Keys: String, CodingKey { case cmd, on, context, id, text, voice, speed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let name = try c.decode(String.self, forKey: .cmd)
        switch name {
        case "listen": self = .listen(on: try c.decode(Bool.self, forKey: .on))
        case "hints": self = .hints(context: try c.decode(String.self, forKey: .context))
        case "flush": self = .flush
        case "speak":
            self = .speak(
                id: try c.decode(String.self, forKey: .id),
                text: try c.decode(String.self, forKey: .text),
                voice: try c.decode(String.self, forKey: .voice),
                speed: try c.decode(Double.self, forKey: .speed))
        case "stopSpeaking": self = .stopSpeaking
        case "prepare": self = .prepare
        case "voices": self = .voices
        case "quit": self = .quit
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .cmd, in: c, debugDescription: "unknown cmd \(name)")
        }
    }
}

public enum ModelsState: String, Encodable, Equatable {
    case missing, downloading, loading, ready, failed
}

public enum SpeakingState: String, Encodable, Equatable {
    case start, end, stopped
}

/// この Mac の声の 1 件（`voices` の応答）。
public struct VoiceInfo: Equatable, Encodable {
    public let id: String
    public let name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public enum Event: Equatable {
    case ready(version: String)
    case models(state: ModelsState, progress: Double, message: String?)
    case vad(speech: Bool)
    case segment(id: String, text: String, dbfs: Double, ms: Int)
    case flushed
    case speaking(id: String, state: SpeakingState)
    case micUsers(bundles: [String])
    case voices(os: [VoiceInfo])
    case error(code: String, message: String)
}

extension Event: Encodable {
    private enum Keys: String, CodingKey {
        case ev, version, state, progress, message, speech, id, text, dbfs, ms, bundles, code, os
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .ready(let version):
            try c.encode("ready", forKey: .ev)
            try c.encode(version, forKey: .version)
        case .models(let state, let progress, let message):
            try c.encode("models", forKey: .ev)
            try c.encode(state, forKey: .state)
            try c.encode(progress, forKey: .progress)
            try c.encodeIfPresent(message, forKey: .message)
        case .vad(let speech):
            try c.encode("vad", forKey: .ev)
            try c.encode(speech, forKey: .speech)
        case .segment(let id, let text, let dbfs, let ms):
            try c.encode("segment", forKey: .ev)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
            try c.encode(dbfs, forKey: .dbfs)
            try c.encode(ms, forKey: .ms)
        case .flushed:
            try c.encode("flushed", forKey: .ev)
        case .speaking(let id, let state):
            try c.encode("speaking", forKey: .ev)
            try c.encode(id, forKey: .id)
            try c.encode(state, forKey: .state)
        case .micUsers(let bundles):
            try c.encode("micUsers", forKey: .ev)
            try c.encode(bundles, forKey: .bundles)
        case .voices(let os):
            try c.encode("voices", forKey: .ev)
            try c.encode(os, forKey: .os)
        case .error(let code, let message):
            try c.encode("error", forKey: .ev)
            try c.encode(code, forKey: .code)
            try c.encode(message, forKey: .message)
        }
    }
}

/// ev を 1 行の JSON にする。JSONEncoder は文字列中の改行を \n に直すので、出力に生の改行は入らない。
public func encodeLine(_ e: Event) -> String {
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? enc.encode(e), let s = String(data: data, encoding: .utf8) else {
        return #"{"ev":"error","code":"encode","message":"encode failed"}"#
    }
    return s
}

/// 1 行を cmd にする。知らない cmd と壊れた JSON は nil。
public func decodeLine(_ s: String) -> Command? {
    guard let data = s.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(Command.self, from: data)
}
