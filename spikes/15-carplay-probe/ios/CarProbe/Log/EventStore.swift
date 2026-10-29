import Foundation

actor EventStore {
    private let directory: URL
    private let run = UUID()
    private var seq = 0
    private var observer: (@Sendable () -> Void)?

    init(directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func setObserver(_ f: @escaping @Sendable () -> Void) { observer = f }

    private func eventsURL(_ run: UUID) -> URL { directory.appendingPathComponent("events-\(run.uuidString).jsonl") }
    private func sentURL(_ run: UUID) -> URL { directory.appendingPathComponent("sent-\(run.uuidString).txt") }

    @discardableResult
    func record(_ kind: String, _ detail: [String: String]) -> ProbeEvent {
        let ev = ProbeEvent(run: run, seq: seq, at: Date(), kind: kind, detail: detail)
        seq += 1
        if var line = try? ProbeCoding.encoder().encode(ev) {
            line.append(0x0A)
            let url = eventsURL(run)
            if let h = try? FileHandle(forWritingTo: url) {
                defer { try? h.close() }
                _ = try? h.seekToEnd()
                try? h.write(contentsOf: line)
            } else {
                try? line.write(to: url)
            }
        }
        observer?()
        return ev
    }

    private func sentUpTo(_ run: UUID) -> Int {
        guard let s = try? String(contentsOf: sentURL(run), encoding: .utf8),
              let n = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return -1 }
        return n
    }

    private func load(_ url: URL) -> [ProbeEvent] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        let dec = ProbeCoding.decoder()
        return text.split(separator: "\n").compactMap { try? dec.decode(ProbeEvent.self, from: Data($0.utf8)) }
    }

    /// 古い run から順に、未送信の分を seq の昇順で返す。
    func pending(limit: Int) -> [ProbeEvent] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let runs = files
            .filter { $0.lastPathComponent.hasPrefix("events-") && $0.pathExtension == "jsonl" }
            .map { load($0).sorted { $0.seq < $1.seq } }
            .filter { !$0.isEmpty }
            .sorted { ($0[0].at, $0[0].run.uuidString) < ($1[0].at, $1[0].run.uuidString) }
        var out: [ProbeEvent] = []
        for evs in runs {
            let sent = sentUpTo(evs[0].run)
            for e in evs where e.seq > sent {
                out.append(e)
                if out.count >= limit { return out }
            }
        }
        return out
    }

    func markSent(upTo seq: Int, run: UUID) {
        guard seq > sentUpTo(run) else { return }
        try? "\(seq)".write(to: sentURL(run), atomically: true, encoding: .utf8)
    }

    func exportURL() -> URL { eventsURL(run) }
}
