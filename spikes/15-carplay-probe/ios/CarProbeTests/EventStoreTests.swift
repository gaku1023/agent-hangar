import XCTest
@testable import CarProbe

final class EventStoreTests: XCTestCase {
    func tempDir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func test_seq_is_monotonic_and_persisted() async {
        let dir = tempDir()
        let s1 = EventStore(directory: dir)
        for i in 0..<3 { _ = await s1.record("k", ["i": "\(i)"]) }
        let s2 = EventStore(directory: dir)
        let p = await s2.pending(limit: 10)
        XCTAssertEqual(p.map(\.seq), [0, 1, 2])
    }

    func test_markSent_hides_sent_events() async {
        let dir = tempDir()
        let s = EventStore(directory: dir)
        var run: UUID!
        for _ in 0..<3 { run = await s.record("k", [:]).run }
        await s.markSent(upTo: 1, run: run)
        let p_s = await s.pending(limit: 10).map(\.seq); XCTAssertEqual(p_s, [2])
        // 作り直しても送信済みの印は残る
        let s2 = EventStore(directory: dir)
        let p_s2 = await s2.pending(limit: 10).map(\.seq); XCTAssertEqual(p_s2, [2])
    }

    func test_pending_spans_older_runs_in_order() async {
        let dir = tempDir()
        let s1 = EventStore(directory: dir)
        _ = await s1.record("a", [:]); _ = await s1.record("a", [:])
        let s2 = EventStore(directory: dir)
        _ = await s2.record("b", [:])
        let p = await s2.pending(limit: 10)
        XCTAssertEqual(p.map(\.kind), ["a", "a", "b"])
        XCTAssertEqual(p.map(\.seq), [0, 1, 0])
    }
}
