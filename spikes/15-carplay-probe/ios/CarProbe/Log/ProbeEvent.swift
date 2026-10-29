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
        e.dateEncodingStrategy = .custom { date, enc in
            var c = enc.singleValueContainer()
            try c.encode(date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
        }
        e.outputFormatting = [.sortedKeys]
        return e
    }
    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let s = try dec.singleValueContainer().decode(String.self)
            return try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(s)
        }
        return d
    }
}
