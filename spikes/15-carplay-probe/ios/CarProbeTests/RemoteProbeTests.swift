import XCTest
import MediaPlayer
@testable import CarProbe

@MainActor
final class RemoteProbeTests: XCTestCase {
    private func makeStore() -> EventStore {
        EventStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("rp-\(UUID().uuidString)"))
    }

    func test_switching_mode_removes_previous_handlers() {
        let probe = RemoteProbe(store: makeStore(), playsSilence: false)
        probe.enable(mode: .media)
        probe.switchMode(to: .call)
        probe.switchMode(to: .media)
        XCTAssertEqual(probe.targetCount(for: "nextTrack"), 1)
        probe.disable()
        XCTAssertEqual(probe.targetCount(for: "nextTrack"), 0)
    }

    func test_command_is_recorded_with_mode() async {
        let store = makeStore()
        let probe = RemoteProbe(store: store, micActive: { true }, playsSilence: false)
        probe.enable(mode: .media)
        probe.handle("nextTrack")
        var ev: ProbeEvent?
        for _ in 0..<200 {
            ev = await store.pending(limit: 100).first { $0.kind == "remote.nextTrack" }
            if ev != nil { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(ev?.detail["mode"], "media")
        XCTAssertEqual(ev?.detail["micActive"], "true")
        XCTAssertEqual(probe.lastCommand, "nextTrack")
        probe.disable()
    }
}
