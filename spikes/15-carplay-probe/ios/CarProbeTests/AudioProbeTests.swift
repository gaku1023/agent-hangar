import XCTest
import AVFoundation
@testable import CarProbe

@MainActor
final class AudioProbeTests: XCTestCase {
    private var dir: URL!

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ap-\(UUID().uuidString)")
    }

    private func eventually(_ store: EventStore, _ kind: String, count: Int = 1) async -> [ProbeEvent] {
        for _ in 0..<200 {
            let evs = await store.pending(limit: 100).filter { $0.kind == kind }
            if evs.count >= count { return evs }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await store.pending(limit: 100).filter { $0.kind == kind }
    }

    func test_interruption_ended_without_markResumed_logs_noResume_even_with_shouldResume() async {
        let store = EventStore(directory: dir)
        let center = NotificationCenter()
        var scheduled: [@MainActor @Sendable () -> Void] = []
        let probe = AudioProbe(store: store, center: center) { _, work in scheduled.append(work) }
        probe.startObserving()
        center.post(name: AVAudioSession.interruptionNotification, object: nil, userInfo: [
            AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
            AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue])
        let ended = await eventually(store, "interruption.ended")
        XCTAssertEqual(ended.first?.detail["shouldResume"], "true")
        scheduled.forEach { $0() }
        let nr = await eventually(store, "interruption.noResume")
        XCTAssertEqual(nr.count, 1)
    }

    func test_markResumed_within_window_suppresses_noResume() async {
        let store = EventStore(directory: dir)
        let center = NotificationCenter()
        var scheduled: [@MainActor @Sendable () -> Void] = []
        let probe = AudioProbe(store: store, center: center) { _, work in scheduled.append(work) }
        probe.startObserving()
        center.post(name: AVAudioSession.interruptionNotification, object: nil, userInfo: [
            AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
            AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue])
        _ = await eventually(store, "interruption.ended")
        probe.markResumed()
        scheduled.forEach { $0() }
        try? await Task.sleep(for: .milliseconds(100))
        let nr = await store.pending(limit: 100).filter { $0.kind == "interruption.noResume" }
        XCTAssertTrue(nr.isEmpty)
    }

    func test_interruption_without_resume_is_logged() async {
        let store = EventStore(directory: dir)
        let center = NotificationCenter()
        var scheduled: [(TimeInterval, @MainActor @Sendable () -> Void)] = []
        let probe = AudioProbe(store: store, center: center) { delay, work in scheduled.append((delay, work)) }
        probe.startObserving()
        func post(_ type: AVAudioSession.InterruptionType, _ opts: AVAudioSession.InterruptionOptions = []) {
            center.post(name: AVAudioSession.interruptionNotification, object: nil, userInfo: [
                AVAudioSessionInterruptionTypeKey: type.rawValue,
                AVAudioSessionInterruptionOptionKey: opts.rawValue,
            ])
        }
        post(.began)
        _ = await eventually(store, "interruption.began")
        post(.ended)
        let ended = await eventually(store, "interruption.ended")
        XCTAssertEqual(ended.first?.detail["shouldResume"], "false")
        XCTAssertEqual(scheduled.first?.0, 3)
        scheduled.forEach { $0.1() }
        let nr = await eventually(store, "interruption.noResume")
        XCTAssertEqual(nr.count, 1)
    }

    func test_carplay_port_change_logs_connected() async {
        let store = EventStore(directory: dir)
        let probe = AudioProbe(store: store, center: NotificationCenter()) { _, _ in }
        let phone = AudioRouteSnapshot(inputs: [.init(type: "MicrophoneBuiltIn", name: "iPhone Mic", channels: 1)],
                                       outputs: [.init(type: "Speaker", name: "Speaker", channels: 2)],
                                       sampleRate: 48000, reason: "initial")
        let car = AudioRouteSnapshot(inputs: [.init(type: "CarAudio", name: "CarPlay", channels: 1)],
                                     outputs: [.init(type: "CarAudio", name: "CarPlay", channels: 2)],
                                     sampleRate: 16000, reason: "newDeviceAvailable")
        probe.handleRoute(phone)
        probe.handleRoute(car)
        probe.handleRoute(phone)
        let c = await eventually(store, "carplay.connected")
        let d = await eventually(store, "carplay.disconnected")
        let r = await eventually(store, "route", count: 3)
        XCTAssertEqual(c.count, 1)
        XCTAssertEqual(d.count, 1)
        XCTAssertEqual(r.count, 3)
        XCTAssertEqual(r.first?.detail["sampleRate"], "48000")
    }
}
