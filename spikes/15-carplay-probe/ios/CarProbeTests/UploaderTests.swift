import XCTest
@testable import CarProbe

final class MockTransport: Transport, @unchecked Sendable {
    private let lock = NSLock()
    private var statuses: [Int]
    private(set) var sentSeqs: [Int] = []
    init(statuses: [Int]) { self.statuses = statuses }
    func post(_ body: Data, to: URL, token: String) async throws -> Int {
        let status: Int = lock.withLock { statuses.isEmpty ? 200 : statuses.removeFirst() }
        if status == -1 { throw URLError(.notConnectedToInternet) }
        if (200..<300).contains(status) {
            let evs = try ProbeCoding.decoder().decode([ProbeEvent].self, from: body)
            lock.withLock { sentSeqs += evs.map(\.seq) }
        }
        return status
    }
    var sent: [Int] { lock.withLock { sentSeqs } }
}

final class UploaderTests: XCTestCase {
    func makeStore() -> EventStore {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return EventStore(directory: d)
    }
    let url = URL(string: "https://example.invalid/e")!

    func test_offline_keeps_order() async {
        let store = makeStore()
        for _ in 0..<5 { _ = await store.record("k", [:]) }
        let t = MockTransport(statuses: [-1, -1, 200])
        let up = Uploader(store: store, endpoint: url, token: "t", transport: t)
        await up.flush(); await up.flush(); await up.flush()
        XCTAssertEqual(t.sent, [0, 1, 2, 3, 4])
        let c_store = await store.pending(limit: 10).count; XCTAssertEqual(c_store, 0)
    }

    func test_401_does_not_mark_sent() async {
        let store = makeStore()
        for _ in 0..<3 { _ = await store.record("k", [:]) }
        let t = MockTransport(statuses: [401])
        let up = Uploader(store: store, endpoint: url, token: "bad", transport: t)
        await up.flush()
        let c_store = await store.pending(limit: 10).count; XCTAssertEqual(c_store, 3)
    }

    func test_start_wires_threshold_without_manual_notes() async {
        let store = makeStore()
        let t = MockTransport(statuses: [])
        let up = Uploader(store: store, endpoint: url, token: "t", transport: t)
        await up.start()
        for _ in 0..<20 { _ = await store.record("k", [:]) }
        for _ in 0..<100 where t.sent.count < 20 { try? await Task.sleep(for: .milliseconds(20)) }
        await up.stop()
        XCTAssertEqual(t.sent, Array(0..<20))
    }

    func test_dates_keep_milliseconds() async throws {
        let d = Date(timeIntervalSince1970: 1_700_000_000.123)
        let ev = ProbeEvent(run: UUID(), seq: 0, at: d, kind: "k", detail: [:])
        let back = try ProbeCoding.decoder().decode(ProbeEvent.self, from: ProbeCoding.encoder().encode(ev))
        XCTAssertEqual(back.at.timeIntervalSince1970, d.timeIntervalSince1970, accuracy: 0.0015)
    }

    func test_threshold_triggers_flush_at_20() async {
        let store = makeStore()
        let t = MockTransport(statuses: [])
        let up = Uploader(store: store, endpoint: url, token: "t", transport: t)
        for _ in 0..<19 { _ = await store.record("k", [:]); await up.noteRecorded() }
        XCTAssertEqual(t.sent.count, 0)
        _ = await store.record("k", [:]); await up.noteRecorded()
        XCTAssertEqual(t.sent.count, 20)
    }
}
