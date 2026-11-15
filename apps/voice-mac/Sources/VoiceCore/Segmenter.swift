import Foundation

public enum SegmenterOutput: Equatable {
    case speechStart
    case speechEnd
    case segment(samples: [Float], dbfs: Float)
}

/// VAD の声の確率から、1 区間ごとの音を切り出す。
/// 声の確率が startProb 以上で startFrames 枠続いたら始まり、前の preRollMs も含める。
/// 無音が silenceMs 続くか maxMs に達したら閉じる。
public struct Segmenter {
    let frame: Int
    let startProb: Float
    let startFrames: Int
    let preRollFrames: Int
    let silenceFrames: Int
    let maxSamples: Int

    private var preRoll: [[Float]] = []
    private var pending: [[Float]] = []  // 声の確率が高い枠が始まりの数に届くまでの分
    private var active = false
    private var buffer: [Float] = []
    private var silentRun = 0
    private var sumSquares: Double = 0
    private var voiceSamples = 0

    public init(
        sampleRate: Int = 16000, frame: Int = 512, startProb: Float = 0.5, startFrames: Int = 2,
        preRollMs: Int = 300, silenceMs: Int = 700, maxMs: Int = 30000
    ) {
        self.frame = frame
        self.startProb = startProb
        self.startFrames = startFrames
        let frameMs = Double(frame) * 1000 / Double(sampleRate)
        self.preRollFrames = Int((Double(preRollMs) / frameMs).rounded(.up))
        self.silenceFrames = Int((Double(silenceMs) / frameMs).rounded(.up))
        self.maxSamples = sampleRate * maxMs / 1000
    }

    private mutating func addVoice(_ f: [Float]) {
        for v in f { sumSquares += Double(v) * Double(v) }
        voiceSamples += f.count
    }

    public mutating func push(frame f: [Float], prob: Float) -> [SegmenterOutput] {
        var out: [SegmenterOutput] = []
        let isVoice = prob >= startProb
        if !active {
            if isVoice {
                pending.append(f)
                if pending.count >= startFrames {
                    active = true
                    buffer = preRoll.flatMap { $0 } + pending.flatMap { $0 }
                    for p in pending { addVoice(p) }
                    pending = []
                    preRoll = []
                    silentRun = 0
                    out.append(.speechStart)
                }
            } else {
                // 声の疑いの枠は前の音として戻す。
                preRoll.append(contentsOf: pending)
                pending = []
                preRoll.append(f)
                if preRoll.count > preRollFrames { preRoll.removeFirst(preRoll.count - preRollFrames) }
            }
            return out
        }
        buffer.append(contentsOf: f)
        if isVoice {
            silentRun = 0
            addVoice(f)
        } else {
            silentRun += 1
        }
        if silentRun >= silenceFrames || buffer.count >= maxSamples {
            out.append(contentsOf: close())
        }
        return out
    }

    public mutating func flush() -> [SegmenterOutput] {
        active ? close() : []
    }

    private mutating func close() -> [SegmenterOutput] {
        let rms = voiceSamples > 0 ? (sumSquares / Double(voiceSamples)).squareRoot() : 0
        let dbfs = Float(20 * log10(max(rms, 1e-10)))
        let out: [SegmenterOutput] = [.speechEnd, .segment(samples: buffer, dbfs: dbfs)]
        active = false
        buffer = []
        silentRun = 0
        sumSquares = 0
        voiceSamples = 0
        return out
    }
}
