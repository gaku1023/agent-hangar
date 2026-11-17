import Foundation

// 補助の本体から切り出した、OS やモデルに依らない部品。

// MARK: - マイクを使っているプロセス

/// CoreAudio のプロセスの 1 件。
public struct AudioProcessInfo: Equatable {
    public let pid: Int32
    public let bundleID: String?
    public let runningInput: Bool

    public init(pid: Int32, bundleID: String?, runningInput: Bool) {
        self.pid = pid
        self.bundleID = bundleID
        self.runningInput = runningInput
    }
}

/// OS の音声の部品。会議の判断に入れない。
public let ignoredMicBundles: Set<String> = ["com.apple.CoreSpeech"]

/// マイクを使っているプロセスのうち、自分と OS の音声の部品を除いたもの。
/// 束の識別子の無いプロセスは `pid:<番号>` で表す。並びは辞書順で、重複は除く。
public func micUserBundles(_ procs: [AudioProcessInfo], selfPID: Int32) -> [String] {
    var out = Set<String>()
    for p in procs where p.runningInput && p.pid != selfPID {
        let name = (p.bundleID?.isEmpty == false) ? p.bundleID! : "pid:\(p.pid)"
        if ignoredMicBundles.contains(name) { continue }
        out.insert(name)
    }
    return out.sorted()
}

/// 値が変わったときだけ返す。最初の値は必ず返す。
public struct ChangeGate<T: Equatable> {
    private var last: T?
    public init() {}
    public mutating func update(_ v: T) -> T? {
        if let last, last == v { return nil }
        last = v
        return v
    }
}

// MARK: - 枠への切り分け

/// 届いた音を決まった長さの枠に切る。余りは次へ持ち越す。
public struct Framer {
    public let size: Int
    private var rest: [Float] = []

    public init(size: Int = 512) { self.size = size }

    public mutating func push(_ samples: [Float]) -> [[Float]] {
        rest.append(contentsOf: samples)
        var out: [[Float]] = []
        var i = 0
        while rest.count - i >= size {
            out.append(Array(rest[i..<(i + size)]))
            i += size
        }
        if i > 0 { rest.removeFirst(i) }
        return out
    }
}

// MARK: - 声の指定

/// speak の voice。`os:<識別子>` か `kokoro:<声>`。
public enum VoiceSpec: Equatable {
    case os(identifier: String)
    case kokoro(voice: String)
    case voicevox(style: Int)
    case aivis(style: Int)

    public init?(_ s: String) {
        guard let colon = s.firstIndex(of: ":") else { return nil }
        let kind = s[..<colon]
        let rest = String(s[s.index(after: colon)...])
        guard !rest.isEmpty else { return nil }
        // 非負の整数（数字だけ）。
        let style: Int? = rest.allSatisfy({ $0.isASCII && $0.isNumber }) ? Int(rest) : nil
        switch kind {
        case "os": self = .os(identifier: rest)
        case "kokoro": self = .kokoro(voice: rest)
        case "voicevox":
            guard let style else { return nil }
            self = .voicevox(style: style)
        case "aivis":
            guard let style else { return nil }
            self = .aivis(style: style)
        default: return nil
        }
    }
}

/// 速さ（1 で標準）を AVSpeechUtterance の rate に直す。
/// 既定の値は AVSpeechUtteranceDefaultSpeechRate・Minimum・Maximum と同じ。
public func osSpeechRate(
    speed: Double, defaultRate: Float = 0.5, minRate: Float = 0, maxRate: Float = 1
) -> Float {
    min(max(defaultRate * Float(speed), minRate), maxRate)
}

// MARK: - 引数

public struct Options: Equatable {
    /// マイクの代わりに流す wav。
    public var inputFile: String?
    /// 読み上げを鳴らさずに wav を書く先のフォルダ。
    public var speakToDir: String?

    public init(inputFile: String? = nil, speakToDir: String? = nil) {
        self.inputFile = inputFile
        self.speakToDir = speakToDir
    }

    /// 知らない引数や値の抜けは nil。
    public static func parse(_ args: [String]) -> Options? {
        var o = Options()
        var i = 0
        while i < args.count {
            let a = args[i]
            guard i + 1 < args.count else { return nil }
            switch a {
            case "--input-file": o.inputFile = args[i + 1]
            case "--speak-to-file": o.speakToDir = args[i + 1]
            default: return nil
            }
            i += 2
        }
        return o
    }
}
