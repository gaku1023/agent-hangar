import Foundation
import AVFoundation
import Observation

enum ProbeMode: String { case media, call }

struct AudioPort: Equatable, Sendable {
    let type: String
    let name: String
    let channels: Int
}

struct AudioRouteSnapshot: Equatable, Sendable {
    var inputs: [AudioPort]
    var outputs: [AudioPort]
    var sampleRate: Double
    var reason: String

    var hasCar: Bool { outputs.contains { $0.type == AVAudioSession.Port.carAudio.rawValue } }

    var detail: [String: String] {
        func fmt(_ ps: [AudioPort]) -> String { ps.map { "\($0.type):\($0.name):\($0.channels)" }.joined(separator: ",") }
        return ["inputs": fmt(inputs), "outputs": fmt(outputs), "sampleRate": String(Int(sampleRate)), "reason": reason]
    }

    static func current(reason: String) -> AudioRouteSnapshot {
        let s = AVAudioSession.sharedInstance()
        func map(_ ps: [AVAudioSessionPortDescription]) -> [AudioPort] {
            ps.map { AudioPort(type: $0.portType.rawValue, name: $0.portName, channels: $0.channels?.count ?? 0) }
        }
        return AudioRouteSnapshot(inputs: map(s.currentRoute.inputs), outputs: map(s.currentRoute.outputs),
                                  sampleRate: s.sampleRate, reason: reason)
    }
}

/// 机用スイッチの判断。車の経路があるときは設定に関わらず上書きを外す。
func deskSpeakerOverride(setting: Bool, hasCar: Bool) -> AVAudioSession.PortOverride {
    (setting && !hasCar) ? .speaker : .none
}

@MainActor @Observable
final class AudioProbe {
    private(set) var carConnected = false
    typealias Scheduler = @MainActor (TimeInterval, @escaping @MainActor @Sendable () -> Void) -> Void

    private let store: EventStore
    private let center: NotificationCenter
    private let schedule: Scheduler
    private var tokens: [NSObjectProtocol] = []
    private var previous: AudioRouteSnapshot?
    private var interruptionGeneration = 0
    private var resumed = false

    init(store: EventStore, center: NotificationCenter = .default,
         schedule: @escaping Scheduler = { delay, work in
             Task { try? await Task.sleep(for: .seconds(delay)); work() }
         }) {
        self.store = store
        self.center = center
        self.schedule = schedule
    }

    func activate(mode: ProbeMode) throws {
        let s = AVAudioSession.sharedInstance()
        // 車の経路に任せるため、allowBluetoothHFP と defaultToSpeaker は付けない。
        try s.setCategory(.playAndRecord, mode: .default, options: [])
        try s.setActive(true)
        startObserving()
        record("mode", ["mode": mode.rawValue])
        handleRoute(.current(reason: "activate"))
        applyDeskSpeaker()
    }

    /// 机用スイッチ。ON のときだけ出力をスピーカーに上書きする。カテゴリとオプションは触らない。
    func applyDeskSpeaker() {
        let on = UserDefaults.standard.bool(forKey: "deskSpeaker")
        let car = AudioRouteSnapshot.current(reason: "deskSpeaker").hasCar
        var ok = true
        var err = ""
        do { try AVAudioSession.sharedInstance().overrideOutputAudioPort(deskSpeakerOverride(setting: on, hasCar: car)) } catch { ok = false; err = "\(error)" }
        var d = ["on": "\(on)", "ok": "\(ok)", "error": err]
        if car { d["ignoredForCar"] = "true" }
        record("deskSpeaker", d)
    }

    /// 割り込みが終わったら呼ぶ。復帰の試みはアプリ側が行う。
    var onInterruptionEnded: (@MainActor (Bool) -> Void)?

    func deactivate() {
        previous = nil
        interruptionGeneration += 1
        tokens.forEach { center.removeObserver($0) }
        tokens = []
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// アプリ側の音が再び鳴ったときに呼ぶ。
    func markResumed() { resumed = true }

    func startObserving() {
        guard tokens.isEmpty else { return }
        tokens.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { @Sendable [weak self] n in
            let t = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            let o = AVAudioSession.InterruptionOptions(rawValue: (n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0)
            Task { @MainActor in self?.handleInterruption(t, o) }
        })
        tokens.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { @Sendable [weak self] n in
            let r = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
            Task { @MainActor in
                self?.handleRoute(.current(reason: "reason\(r)"))
                // 経路が変わると上書きが外れる。ON のときだけ、スピーカーでなければ掛け直す(自己ループ防止)。
                if UserDefaults.standard.bool(forKey: "deskSpeaker"),
                   !AudioRouteSnapshot.current(reason: "deskSpeaker").hasCar,
                   !AVAudioSession.sharedInstance().currentRoute.outputs.contains(where: { $0.portType == .builtInSpeaker }) {
                    self?.applyDeskSpeaker()
                }
            }
        })
        tokens.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { @Sendable [weak self] _ in
            Task { @MainActor in self?.record("mediaReset", [:]) }
        })
    }

    func handleInterruption(_ type: AVAudioSession.InterruptionType?, _ options: AVAudioSession.InterruptionOptions) {
        switch type {
        case .began:
            interruptionGeneration += 1
            record("interruption.began", [:])
        case .ended:
            let should = options.contains(.shouldResume)
            resumed = false
            record("interruption.ended", ["shouldResume": String(should)])
            let gen = interruptionGeneration
            schedule(3) { [weak self] in
                guard let self, self.interruptionGeneration == gen, !self.resumed else { return }
                self.record("interruption.noResume", [:])
            }
            onInterruptionEnded?(should)
        default: break
        }
    }

    func handleRoute(_ snap: AudioRouteSnapshot) {
        let was = previous?.hasCar ?? false
        record("route", snap.detail)
        if snap.hasCar && !was { record("carplay.connected", snap.detail) }
        if !snap.hasCar && was { record("carplay.disconnected", snap.detail) }
        previous = snap
        carConnected = snap.hasCar
    }

    private func record(_ kind: String, _ detail: [String: String]) {
        let s = store
        Task { await s.record(kind, detail) }
    }
}
