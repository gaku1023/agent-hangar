import XCTest
@testable import CarProbe

final class LaunchForensicsTests: XCTestCase {
    private func fresh() -> UserDefaults {
        let name = "lf-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    func test_detects_unclean_exit() {
        let d = fresh()
        let now = Date(timeIntervalSince1970: 10_000)
        d.set(now.addingTimeInterval(-70).timeIntervalSince1970, forKey: "lastBeat")
        d.set("run-A", forKey: "prevRun")
        let r = LaunchForensics.inspect(defaults: d, now: now)
        XCTAssertEqual(r?["gapSec"], "70")
        XCTAssertEqual(r?["prevRun"], "run-A")
        XCTAssertNotNil(r?["lastBeat"])
        XCTAssertNotNil(r?["lastLockAt"])
    }

    func test_clean_exit_returns_nil() {
        let d = fresh()
        let now = Date(timeIntervalSince1970: 10_000)
        d.set(now.addingTimeInterval(-70).timeIntervalSince1970, forKey: "lastBeat")
        d.set(true, forKey: "cleanExit")
        XCTAssertNil(LaunchForensics.inspect(defaults: d, now: now))
    }

    @MainActor
    func test_beginRun_before_first_tick_reports_old_gap() async throws {
        let d = fresh()
        let dir = FileManager.default.temporaryDirectory.appending(path: "lf-\(UUID().uuidString)")
        let store = EventStore(directory: dir)
        let now = Date(timeIntervalSince1970: 10_000)
        d.set(now.addingTimeInterval(-600).timeIntervalSince1970, forKey: "lastBeat")
        d.set(now.addingTimeInterval(-700).timeIntervalSince1970, forKey: "lastLockAt")
        d.set("run-A", forKey: "prevRun")
        let r = LaunchForensics.beginRun(defaults: d, run: "run-B", store: store, now: now)
        Heartbeat(store: store, defaults: d).tick(now: now)
        XCTAssertEqual(r?["gapSec"], "600")
        XCTAssertEqual(r?["prevRun"], "run-A")
        XCTAssertNil(d.object(forKey: "lastLockAt"))
        XCTAssertEqual(d.string(forKey: "prevRun"), "run-B")
        XCTAssertEqual(d.double(forKey: "lastBeat"), now.timeIntervalSince1970)
    }

    func test_first_install_has_no_prevRunEnded() {
        let d = fresh()
        XCTAssertNil(LaunchForensics.inspect(defaults: d, now: Date()))
    }
}
