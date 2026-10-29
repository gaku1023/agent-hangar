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
}
