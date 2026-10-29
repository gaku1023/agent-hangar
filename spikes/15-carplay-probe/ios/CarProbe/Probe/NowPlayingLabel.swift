import Foundation
import MediaPlayer

@MainActor
final class NowPlayingLabel {
    private var timer: Timer?

    func update(title: String, subtitle: String) {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: subtitle,
            MPMediaItemPropertyPlaybackDuration: 3600.0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: 0.0,
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        ]
    }

    /// 10 秒ごとに表示を替える。state は (モード, 最後のボタン) を返す。
    func startTicker(state: @escaping @MainActor () -> (mode: ProbeMode, lastCommand: String)) {
        timer?.invalidate()
        let start = Date()
        let tick: @MainActor () -> Void = { [weak self] in
            let sec = Int(Date().timeIntervalSince(start))
            let s = state()
            self?.update(title: String(format: "Probe %d:%02d", sec / 60, sec % 60),
                         subtitle: "\(s.mode.rawValue) / 最後のボタン: \(s.lastCommand)")
        }
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
            MainActor.assumeIsolated { tick() }
        }
    }

    func stopTicker() { timer?.invalidate(); timer = nil }
}
