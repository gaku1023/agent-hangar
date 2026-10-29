import Foundation

protocol Transport: Sendable {
    /// HTTP ステータスを返す。通信できなければ throw。
    func post(_ body: Data, to: URL, token: String) async throws -> Int
}

struct URLSessionTransport: Transport {
    func post(_ body: Data, to: URL, token: String) async throws -> Int {
        var req = URLRequest(url: to)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 10
        let (_, res) = try await URLSession.shared.data(for: req)
        return (res as? HTTPURLResponse)?.statusCode ?? 0
    }
}

actor Uploader {
    static let threshold = 20
    static let interval: Duration = .seconds(5)

    private let store: EventStore
    private let endpoint: URL
    private let token: String
    private let transport: Transport
    private var recordedSinceFlush = 0
    private var flushing = false
    private var timer: Task<Void, Never>?

    init(store: EventStore, endpoint: URL, token: String, transport: Transport) {
        self.store = store; self.endpoint = endpoint; self.token = token; self.transport = transport
    }

    /// 5 秒ごとの flush と、record 20 件ごとの flush をつなぐ。
    func start() async {
        await store.setObserver { [weak self] in
            guard let self else { return }
            Task { await self.noteRecorded() }
        }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Uploader.interval)
                await self?.flush()
            }
        }
    }

    func stop() { timer?.cancel(); timer = nil }

    func noteRecorded() async {
        recordedSinceFlush += 1
        if recordedSinceFlush >= Uploader.threshold { await flush() }
    }

    func flush() async {
        guard !flushing else { return }
        flushing = true
        defer { flushing = false }
        recordedSinceFlush = 0
        while true {
            let batch = await store.pending(limit: 100)
            if batch.isEmpty { return }
            guard let body = try? ProbeCoding.encoder().encode(batch),
                  let status = try? await transport.post(body, to: endpoint, token: token),
                  (200..<300).contains(status) else { return }
            var maxSeq: [UUID: Int] = [:]
            for e in batch { maxSeq[e.run] = max(maxSeq[e.run] ?? -1, e.seq) }
            for (run, s) in maxSeq { await store.markSent(upTo: s, run: run) }
        }
    }
}
