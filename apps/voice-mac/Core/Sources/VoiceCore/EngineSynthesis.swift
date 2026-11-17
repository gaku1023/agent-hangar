import Foundation

// VOICEVOX 互換エンジン（VOICEVOX、AivisSpeech）への合成の要求と、返った WAV の読み取り。
// 通信そのものは hangar-voice の Speaker が行い、ここは純粋な部品だけを持つ。

public enum EngineKind: Equatable {
    case voicevox, aivis

    public var defaultBase: String {
        switch self {
        case .voicevox: return "http://127.0.0.1:50021"
        case .aivis: return "http://127.0.0.1:10101"
        }
    }

    public var envName: String {
        switch self {
        case .voicevox: return "HANGAR_VOICEVOX_URL"
        case .aivis: return "HANGAR_AIVIS_URL"
        }
    }
}

/// HTTP の待ちを諦める秒数。
public let engineTimeout: TimeInterval = 10

/// エンジンの口。環境変数で替えられるが、ホストが 127.0.0.1 か localhost 以外なら既定へ戻す。
public func engineBaseURL(_ kind: EngineKind, env: [String: String]) -> URL {
    let fallback = URL(string: kind.defaultBase)!
    guard var raw = env[kind.envName], !raw.isEmpty else { return fallback }
    while raw.hasSuffix("/") { raw.removeLast() }
    guard let u = URL(string: raw), let scheme = u.scheme, scheme == "http" || scheme == "https",
        let host = u.host, host == "127.0.0.1" || host == "localhost"
    else { return fallback }
    return u
}

private func endpoint(_ base: URL, _ path: String, _ items: [URLQueryItem]) -> URL? {
    guard var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
    c.path = path
    c.queryItems = items
    // URLComponents は query 内の & や = を符号化しないので、値の側を自分で符号化する。
    var allowed = CharacterSet.urlQueryAllowed
    allowed.remove(charactersIn: "&=+#")
    c.percentEncodedQuery = items.map { i in
        let v = (i.value ?? "").addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        return "\(i.name)=\(v)"
    }.joined(separator: "&")
    return c.url
}

/// `POST /audio_query?speaker=N&text=…`
public func audioQueryRequest(base: URL, speaker: Int, text: String) -> URLRequest? {
    guard let url = endpoint(
        base, "/audio_query",
        [URLQueryItem(name: "speaker", value: String(speaker)), URLQueryItem(name: "text", value: text)])
    else { return nil }
    var r = URLRequest(url: url, timeoutInterval: engineTimeout)
    r.httpMethod = "POST"
    return r
}

/// audio_query の応答の `speedScale` を速さで上書きする。オブジェクトでなければ nil。
public func rewriteSpeedScale(_ query: Data, speed: Double) -> Data? {
    guard var o = (try? JSONSerialization.jsonObject(with: query)) as? [String: Any] else { return nil }
    o["speedScale"] = speed
    return try? JSONSerialization.data(withJSONObject: o)
}

/// `POST /synthesis?speaker=N`（本文は書き換えた audio_query の JSON）
public func synthesisRequest(base: URL, speaker: Int, body: Data) -> URLRequest? {
    guard let url = endpoint(base, "/synthesis", [URLQueryItem(name: "speaker", value: String(speaker))])
    else { return nil }
    var r = URLRequest(url: url, timeoutInterval: engineTimeout)
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = body
    return r
}

/// WAV（PCM 16 bit か 32 bit float）をモノラルの Float にする。読めなければ nil。
public func decodeWav(_ d: Data) -> (samples: [Float], sampleRate: Int)? {
    let b = [UInt8](d)
    guard b.count >= 12, String(decoding: b[0..<4], as: UTF8.self) == "RIFF",
        String(decoding: b[8..<12], as: UTF8.self) == "WAVE"
    else { return nil }
    func u16(_ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }
    func u32(_ i: Int) -> Int { u16(i) | u16(i + 2) << 16 }
    var format = 0, channels = 0, rate = 0, bits = 0
    var data: Range<Int>?
    var i = 12
    while i + 8 <= b.count {
        let id = String(decoding: b[i..<(i + 4)], as: UTF8.self)
        let size = u32(i + 4)
        let start = i + 8
        let end = min(start + size, b.count)
        if id == "fmt ", end - start >= 16 {
            format = u16(start); channels = u16(start + 2); rate = u32(start + 4); bits = u16(start + 14)
            if format == 0xFFFE, end - start >= 26 { format = u16(start + 24) }
        } else if id == "data" {
            data = start..<end
            break
        }
        i = start + size + (size & 1)
    }
    guard let data, channels > 0, rate > 0 else { return nil }
    let bytesPer = bits / 8
    guard (format == 1 && bits == 16) || (format == 3 && bits == 32) else { return nil }
    let frames = data.count / (bytesPer * channels)
    var out = [Float](repeating: 0, count: frames)
    for f in 0..<frames {
        var sum: Float = 0
        for c in 0..<channels {
            let p = data.lowerBound + (f * channels + c) * bytesPer
            if bits == 16 {
                sum += Float(Int16(truncatingIfNeeded: u16(p))) / 32768
            } else {
                sum += Float(bitPattern: UInt32(truncatingIfNeeded: u32(p)))
            }
        }
        out[f] = sum / Float(channels)
    }
    return (out, rate)
}
