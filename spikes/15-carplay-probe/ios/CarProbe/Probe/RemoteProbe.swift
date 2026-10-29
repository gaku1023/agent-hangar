import Foundation
import AVFoundation
import MediaPlayer

@MainActor
final class RemoteProbe {
    private let store: EventStore
    var micActive: @MainActor () -> Bool
    private let playsSilence: Bool
    private var tokens: [(name: String, command: MPRemoteCommand, token: Any)] = []
    private var player: AVAudioPlayer?
    private(set) var mode: ProbeMode = .media
    private(set) var lastCommand = "-"
    private(set) var lastCommandAt: Date?
    func resetLastCommand() { lastCommand = "-"; lastCommandAt = nil }

    init(store: EventStore, micActive: @escaping @MainActor () -> Bool = { false }, playsSilence: Bool = true) {
        self.store = store
        self.micActive = micActive
        self.playsSilence = playsSilence
    }

    private var commands: [(String, MPRemoteCommand)] {
        let c = MPRemoteCommandCenter.shared()
        return [("play", c.playCommand), ("pause", c.pauseCommand), ("togglePlayPause", c.togglePlayPauseCommand),
                ("nextTrack", c.nextTrackCommand), ("previousTrack", c.previousTrackCommand),
                ("skipForward", c.skipForwardCommand), ("skipBackward", c.skipBackwardCommand),
                ("seekForward", c.seekForwardCommand), ("seekBackward", c.seekBackwardCommand),
                ("changePlaybackPosition", c.changePlaybackPositionCommand),
                ("like", c.likeCommand), ("dislike", c.dislikeCommand), ("bookmark", c.bookmarkCommand),
                ("stop", c.stopCommand)]
    }

    func enable(mode: ProbeMode) {
        removeAll()
        self.mode = mode
        for (name, cmd) in commands {
            cmd.isEnabled = true
            let t = cmd.addTarget { [weak self] _ in
                Task { @MainActor [weak self] in self?.handle(name) }
                return .success
            }
            tokens.append((name, cmd, t))
        }
        if mode == .media { startSilence() } else { stopSilence() }
    }

    func switchMode(to mode: ProbeMode) { enable(mode: mode) }

    func disable() {
        removeAll()
        stopSilence()
    }

    func targetCount(for name: String) -> Int { tokens.filter { $0.name == name }.count }

    func handle(_ command: String) {
        lastCommand = command
        lastCommandAt = Date()
        let detail = ["mode": mode.rawValue, "micActive": micActive() ? "true" : "false"]
        let s = store
        Task { await s.record("remote.\(command)", detail) }
    }

    private func removeAll() {
        for t in tokens { t.command.removeTarget(t.token) }
        tokens = []
    }

    /// 割り込みのあとに無音ループを作り直す。鳴っていれば true。
    func restartSilence() -> Bool {
        guard mode == .media else { return true }
        stopSilence()
        startSilence()
        return player?.isPlaying ?? !playsSilence
    }

    private func failSilence(_ reason: String) {
        let s = store
        Task { await s.record("remote.silenceFailed", ["reason": reason]) }
    }

    private func startSilence() {
        guard playsSilence, player == nil else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("silence.wav")
        do { try Self.silenceWAV().write(to: url) } catch { return failSilence("write: \(error)") }
        let p: AVAudioPlayer
        do { p = try AVAudioPlayer(contentsOf: url) } catch { return failSilence("init: \(error)") }
        p.numberOfLoops = -1
        p.prepareToPlay()
        if !p.play() { return failSilence("play() returned false") }
        player = p
    }

    private func stopSilence() {
        player?.stop()
        player = nil
    }

    /// -60 dBFS、440 Hz、1 秒、16 bit mono 44.1 kHz の WAV。
    static func silenceWAV() -> Data {
        let rate = 44100
        let amp = 32767.0 * 0.001
        var pcm = Data()
        for i in 0..<rate {
            let v = Int16(amp * sin(2 * Double.pi * 440 * Double(i) / Double(rate)))
            withUnsafeBytes(of: v.littleEndian) { pcm.append(contentsOf: $0) }
        }
        func le32(_ x: Int) -> Data { withUnsafeBytes(of: UInt32(x).littleEndian) { Data($0) } }
        func le16(_ x: Int) -> Data { withUnsafeBytes(of: UInt16(x).littleEndian) { Data($0) } }
        var d = Data("RIFF".utf8)
        d += le32(36 + pcm.count); d += Data("WAVEfmt ".utf8); d += le32(16); d += le16(1); d += le16(1)
        d += le32(rate); d += le32(rate * 2); d += le16(2); d += le16(16)
        d += Data("data".utf8); d += le32(pcm.count); d += pcm
        return d
    }
}
