import SwiftUI
import AVFoundation
import Speech
import UIKit

@MainActor
@Observable
final class ProbeModel {
    static let shared = ProbeModel()

    let store: EventStore
    let uploader: Uploader?
    let audio: AudioProbe
    let heartbeat: Heartbeat
    let remote: RemoteProbe
    let call: CallProbe
    let label = NowPlayingLabel()
    let speech: SpeechProbe
    var runId = "…"
    var appActive = true
    private var busy = false

    var mode: ProbeMode = .media
    var running = false
    var micOn = true
    var events: [ProbeEvent] = []
    var pendingCount = 0
    var status = "停止中"
    var autoStart: Bool {
        get { UserDefaults.standard.object(forKey: "autoStartOnLaunch") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "autoStartOnLaunch") }
    }

    private var micRunning = false
    private var asked = false
    private var refresh: Task<Void, Never>?

    private init() {
        let dir = URL.documentsDirectory.appending(path: "events")
        let store = EventStore(directory: dir)
        self.store = store
        if let url = SinkConfig.url {
            uploader = Uploader(store: store, endpoint: url.path().count > 1 ? url : url.appending(path: "e"), token: SinkConfig.token, transport: URLSessionTransport())
        } else { uploader = nil }
        audio = AudioProbe(store: store)
        heartbeat = Heartbeat(store: store)
        remote = RemoteProbe(store: store)
        call = CallProbe(store: store)
        speech = SpeechProbe(store: store, speaker: Speaker(store: store))
        Task { [weak self] in
            let name = await store.exportURL().lastPathComponent
            let rid = String(name.replacingOccurrences(of: "events-", with: "").prefix(8))
            self?.runId = rid
            // 前回の判定を済ませてから最初の心拍を打つ。順序が逆だと gapSec が 0 になる。
            _ = LaunchForensics.beginRun(defaults: .standard, run: rid, store: store)
            self?.heartbeat.start()
        }
        audio.onInterruptionEnded = { [weak self] should in
            Task { await self?.resumeAfterInterruption(shouldResume: should) }
        }
        Task { await store.record("launch", ["autoStart": "\(UserDefaults.standard.object(forKey: "autoStartOnLaunch") as? Bool ?? true)"]) }
        if let u = uploader { Task { await u.start() } }
        NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { @Sendable _ in
            LaunchForensics.markCleanExit(defaults: .standard)
        }
        refresh = Task { [weak self] in
            while !Task.isCancelled {
                if self?.appActive ?? true { await self?.reload() }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func reload() async {
        let url = await store.exportURL()
        if let text = try? String(contentsOf: url, encoding: .utf8) {
            let dec = ProbeCoding.decoder()
            events = text.split(separator: "\n").suffix(50).compactMap { try? dec.decode(ProbeEvent.self, from: Data($0.utf8)) }.reversed()
        }
        pendingCount = await store.pending(limit: 100_000).count
    }

    func start() async {
        guard !running, !busy else { return }
        busy = true
        defer { busy = false }
        await doStart()
    }

    private func doStart() async {
        guard !running else { return }
        await requestPermissions()
        do { try audio.activate(mode: mode) } catch {
            let m = "\(error)"; Task { await store.record("audio.error", ["error": m]) }
        }
        running = true
        status = "動作中"
        remote.micActive = { [weak self] in self?.micRunning ?? false }
        remote.enable(mode: mode)
        label.startTicker { [weak self] in
            guard let self else { return (.media, "-") }
            let c = self.call.lastCommand, r = self.remote
            let callNewer = (c.at ?? .distantPast) > (r.lastCommandAt ?? .distantPast)
            return (self.mode, callNewer ? c.name : r.lastCommand)
        }
        if mode == .call { call.startCall() }
        if micOn { await startMic() }
    }

    func stop() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await doStop()
    }

    private func doStop() async {
        guard running else { return }
        await stopMic()
        call.endCall()
        remote.disable()
        label.stopTicker()
        audio.deactivate()
        call.resetLastCommand()
        remote.resetLastCommand()
        running = false
        status = "停止中"
        await uploader?.flush()
    }

    func switchMode(_ m: ProbeMode) async {
        guard m != mode, !busy else { return }
        busy = true
        defer { busy = false }
        let was = running
        if was { await doStop() }
        mode = m
        if was { await doStart() }
    }

    func toggleMic() async {
        micOn.toggle()
        guard running else { return }
        if micOn { await startMic() } else { await stopMic() }
    }

    private func startMic() async {
        guard !micRunning else { return }
        micRunning = true
        await speech.start()
        speech.startTicker()
    }

    private func stopMic() async {
        guard micRunning else { return }
        await speech.stop()
        micRunning = false
    }

    private func requestPermissions() async {
        guard !asked else { return }
        asked = true
        let mic = await AVAudioApplication.requestRecordPermission()
        await store.record("permission.microphone", ["granted": "\(mic)"])
        // シミュレータでは応答が返らないことがあるので、20 秒で見切る。
        let sp: String = await withCheckedContinuation { c in
            let once = Once(c)
            SFSpeechRecognizer.requestAuthorization { @Sendable status in once.resume("\(status.rawValue)") }
            Task { try? await Task.sleep(for: .seconds(20)); once.resume("timeout") }
        }
        await store.record("permission.speech", ["status": sp])
    }

    /// 割り込み後に、音を実際に戻す。戻せたときだけ markResumed する。
    func resumeAfterInterruption(shouldResume: Bool) async {
        guard running else { return }
        var ok = true
        var err = ""
        do { try AVAudioSession.sharedInstance().setActive(true) } catch { ok = false; err = "\(error)" }
        audio.applyDeskSpeaker()
        if mode == .media, !remote.restartSilence() { ok = false; err += " silence" }
        if micOn { await stopMic(); await startMic() }
        await store.record("interruption.resumeAttempt", ["shouldResume": "\(shouldResume)", "ok": "\(ok)", "error": err])
        if ok { audio.markResumed() }
    }

    func flush() async { await uploader?.flush() }
}

private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var c: CheckedContinuation<String, Never>?
    init(_ c: CheckedContinuation<String, Never>) { self.c = c }
    func resume(_ v: String) {
        lock.lock(); let x = c; c = nil; lock.unlock()
        x?.resume(returning: v)
    }
}
