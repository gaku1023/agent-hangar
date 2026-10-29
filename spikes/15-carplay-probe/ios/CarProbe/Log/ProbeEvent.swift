import Foundation

struct ProbeEvent: Codable, Sendable {
    let run: UUID
    let seq: Int
    let at: Date
    let kind: String
    let detail: [String: String]
}

enum ProbeCoding {
    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }
    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
