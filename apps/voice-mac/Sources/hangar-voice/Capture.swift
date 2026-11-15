import AVFoundation
import Foundation
import MLXAudioCore
import VoiceCore

/// マイクの取り込みと、読み上げの再生。
/// 両方を 1 つの AVAudioEngine に載せ、再生の音を voice processing の回り込み消しの参照に入れる。
final class Capture {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let recognizer: Recognizer
    private let target = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: Double(Recognizer.sampleRate), channels: 1,
        interleaved: false)!
    // 以下は queue の上でだけ触る。
    private let queue = DispatchQueue(label: "hangar-voice.capture")
    private var configured = false
    private var listening = false
    private var playing = 0

    init(recognizer: Recognizer) { self.recognizer = recognizer }

    /// 2026-11-16 の実測：先に mainMixerNode と outputNode に触れ、接続の形式を nil にしないと、
    /// voice processing を入れたエンジンの開始が -10875 で落ちた。
    private func configure() throws {
        guard !configured else { return }
        _ = engine.mainMixerNode
        _ = engine.outputNode
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                enableAdvancedDucking: false, duckingLevel: .min)
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: nil)
        configured = true
    }

    private func startEngineIfNeeded() throws {
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
    }

    private func stopEngineIfIdle() {
        if !listening && playing == 0 && engine.isRunning { engine.stop() }
    }

    func setListening(_ on: Bool) {
        queue.async {
            guard on != self.listening else { return }
            do {
                if on {
                    try self.configure()
                    try self.installTap()
                    self.listening = true
                    try self.startEngineIfNeeded()
                } else {
                    self.engine.inputNode.removeTap(onBus: 0)
                    self.listening = false
                    self.recognizer.reset()
                    self.stopEngineIfIdle()
                }
            } catch {
                self.listening = false
                emit(.error(code: "mic", message: "\(error)"))
            }
        }
    }

    private func installTap() throws {
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
            throw NSError(domain: "hangar-voice", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input device"])
        }
        // voice processing の入力は多チャンネルのことがある。先頭のチャンネルだけを単声として取る。
        let mono = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: fmt.sampleRate, channels: 1, interleaved: false)!
        guard let converter = AVAudioConverter(from: mono, to: target) else {
            throw NSError(domain: "hangar-voice", code: 2, userInfo: [NSLocalizedDescriptionKey: "no converter"])
        }
        var framer = Framer(size: 512)
        let recognizer = self.recognizer
        let target = self.target
        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buf, _ in
            guard let src = buf.floatChannelData,
                  let m = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buf.frameLength)
            else { return }
            m.frameLength = buf.frameLength
            memcpy(m.floatChannelData![0], src[0], Int(buf.frameLength) * MemoryLayout<Float>.size)
            let cap = AVAudioFrameCount(Double(buf.frameLength) * target.sampleRate / fmt.sampleRate) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return }
            var fed = false
            var err: NSError?
            converter.convert(to: out, error: &err) { _, status in
                if fed {
                    status.pointee = .noDataNow
                    return nil
                }
                fed = true
                status.pointee = .haveData
                return m
            }
            guard err == nil, let p = out.floatChannelData else { return }
            let samples = Array(UnsafeBufferPointer(start: p[0], count: Int(out.frameLength)))
            for f in framer.push(samples) { recognizer.push(frame: f) }
        }
    }

    /// 読み上げの音を鳴らす。鳴り終わる（または止められる）と done を呼ぶ。
    func play(samples: [Float], sampleRate: Int, done: @escaping () -> Void) {
        queue.async {
            do {
                try self.configure()
                let outFmt = self.player.outputFormat(forBus: 0)
                guard let buf = convertSamples(samples, sampleRate: sampleRate, to: outFmt) else {
                    throw NSError(domain: "hangar-voice", code: 3, userInfo: [NSLocalizedDescriptionKey: "convert failed"])
                }
                try self.startEngineIfNeeded()
                self.playing += 1
                self.player.scheduleBuffer(buf, at: nil, options: [], completionCallbackType: .dataPlayedBack) { _ in
                    self.queue.async {
                        self.playing -= 1
                        self.stopEngineIfIdle()
                    }
                    done()
                }
                self.player.play()
            } catch {
                emit(.error(code: "playback", message: "\(error)"))
                done()
            }
        }
    }

    /// 鳴っている読み上げを止める。予約した音の done はここで呼ばれる。
    func stopPlayback() {
        queue.async {
            if self.configured { self.player.stop() }
        }
    }
}

/// 単声の Float の音を、指定の形式のバッファに直す。
func convertSamples(_ samples: [Float], sampleRate: Int, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let srcFmt = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
    guard let src = AVAudioPCMBuffer(pcmFormat: srcFmt, frameCapacity: AVAudioFrameCount(max(samples.count, 1)))
    else { return nil }
    src.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { p in
        if let base = p.baseAddress { memcpy(src.floatChannelData![0], base, samples.count * MemoryLayout<Float>.size) }
    }
    return convertBuffer(src, to: format)
}

/// バッファを別の形式に直す（標本化の率、チャンネル数、数の型）。
func convertBuffer(_ src: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
    if src.format == format { return src }
    guard let conv = AVAudioConverter(from: src.format, to: format) else { return nil }
    if src.format.channelCount == 1 && format.channelCount > 1 {
        // 単声を全部のチャンネルに配る。
        conv.channelMap = [NSNumber](repeating: 0, count: Int(format.channelCount))
    }
    let cap = AVAudioFrameCount(Double(src.frameLength) * format.sampleRate / src.format.sampleRate) + 1024
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return nil }
    var fed = false
    var err: NSError?
    let status = conv.convert(to: out, error: &err) { _, st in
        if fed {
            st.pointee = .endOfStream
            return nil
        }
        fed = true
        st.pointee = .haveData
        return src
    }
    if status == .error || err != nil { return nil }
    return out
}

/// 単声の Float の音に直す（読み上げを wav に書くときや Kokoro と同じ扱いにするため）。
func monoFloatSamples(_ buf: AVAudioPCMBuffer) -> [Float] {
    let fmt = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: buf.format.sampleRate, channels: 1, interleaved: false)!
    guard let out = convertBuffer(buf, to: fmt), let p = out.floatChannelData else { return [] }
    return Array(UnsafeBufferPointer(start: p[0], count: Int(out.frameLength)))
}

/// --input-file：マイクの代わりに wav を実時間で流し、終わったら区間を閉じる。
func streamFile(_ path: String, models: Models, recognizer: Recognizer) throws {
    let url = URL(fileURLWithPath: path)
    let samples: [Float] = try models.queue.sync {
        let (_, audio) = try loadAudioArray(from: url, sampleRate: Recognizer.sampleRate)
        return audio.asArray(Float.self)
    }
    var framer = Framer(size: 512)
    var frames = framer.push(samples)
    let rest = samples.count % 512
    if rest > 0 {
        frames.append(Array(samples.suffix(rest)) + [Float](repeating: 0, count: 512 - rest))
    }
    let frameSec = 512.0 / Double(Recognizer.sampleRate)
    let start = Date()
    for (i, f) in frames.enumerated() {
        let due = start.addingTimeInterval(Double(i) * frameSec)
        let wait = due.timeIntervalSinceNow
        if wait > 0 { Thread.sleep(forTimeInterval: wait) }
        recognizer.push(frame: f)
    }
    recognizer.flush(emitFlushed: true)
}
