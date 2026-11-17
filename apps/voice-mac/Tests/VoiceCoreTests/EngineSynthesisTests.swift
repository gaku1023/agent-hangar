import XCTest
@testable import VoiceCore

final class EngineSynthesisTests: XCTestCase {
    func testBaseURLDefaultsAndOverride() {
        XCTAssertEqual(engineBaseURL(.voicevox, env: [:]).absoluteString, "http://127.0.0.1:50021")
        XCTAssertEqual(engineBaseURL(.aivis, env: [:]).absoluteString, "http://127.0.0.1:10101")
        XCTAssertEqual(
            engineBaseURL(.voicevox, env: ["HANGAR_VOICEVOX_URL": "http://localhost:6000"]).absoluteString,
            "http://localhost:6000")
        XCTAssertEqual(
            engineBaseURL(.aivis, env: ["HANGAR_AIVIS_URL": "http://127.0.0.1:7000/"]).absoluteString,
            "http://127.0.0.1:7000")
    }

    func testBaseURLRejectsForeignHosts() {
        for u in ["http://example.com:50021", "http://192.168.1.5:50021", "http://127.0.0.1.evil.com", "ftp://127.0.0.1", "nonsense", ""] {
            XCTAssertEqual(
                engineBaseURL(.voicevox, env: ["HANGAR_VOICEVOX_URL": u]).absoluteString,
                "http://127.0.0.1:50021", u)
        }
    }

    func testAudioQueryRequest() throws {
        let base = URL(string: "http://127.0.0.1:50021")!
        let r = try XCTUnwrap(audioQueryRequest(base: base, speaker: 3, text: "こんにちは & ね"))
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.timeoutInterval, 10)
        let url = try XCTUnwrap(r.url)
        let comps = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(comps.path, "/audio_query")
        XCTAssertEqual(comps.queryItems?.first { $0.name == "speaker" }?.value, "3")
        XCTAssertEqual(comps.queryItems?.first { $0.name == "text" }?.value, "こんにちは & ね")
        XCTAssertTrue(url.absoluteString.contains("%26"))
        XCTAssertFalse(url.absoluteString.contains(" "))
    }

    func testSpeedScaleOverwrite() throws {
        let q = #"{"speedScale":1.0,"pitchScale":0.1,"accent_phrases":[{"a":1}]}"#
        let out = try XCTUnwrap(rewriteSpeedScale(Data(q.utf8), speed: 1.3))
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: out) as? [String: Any])
        XCTAssertEqual(o["speedScale"] as? Double, 1.3)
        XCTAssertEqual(o["pitchScale"] as? Double, 0.1)
        XCTAssertNotNil(o["accent_phrases"])
        XCTAssertNil(rewriteSpeedScale(Data("[1]".utf8), speed: 1))
        XCTAssertNil(rewriteSpeedScale(Data("nope".utf8), speed: 1))
    }

    func testSynthesisRequest() throws {
        let base = URL(string: "http://127.0.0.1:10101")!
        let body = Data("{}".utf8)
        let r = try XCTUnwrap(synthesisRequest(base: base, speaker: 888753760, body: body))
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.url?.absoluteString, "http://127.0.0.1:10101/synthesis?speaker=888753760")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(r.httpBody, body)
        XCTAssertEqual(r.timeoutInterval, 10)
    }

    private func wav(channels: Int, rate: Int, pcm16: [Int16]) -> Data {
        var d = Data()
        func u32(_ v: Int) { var x = UInt32(v).littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: Int) { var x = UInt16(v).littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append(Data("RIFF".utf8)); u32(36 + pcm16.count * 2); d.append(Data("WAVE".utf8))
        d.append(Data("fmt ".utf8)); u32(16); u16(1); u16(channels); u32(rate)
        u32(rate * channels * 2); u16(channels * 2); u16(16)
        d.append(Data("LIST".utf8)); u32(2); d.append(Data([0, 0]))
        d.append(Data("data".utf8)); u32(pcm16.count * 2)
        for s in pcm16 { u16(Int(UInt16(bitPattern: s))) }
        return d
    }

    func testDecodeWavMonoAndStereo() throws {
        let m = try XCTUnwrap(decodeWav(wav(channels: 1, rate: 24000, pcm16: [0, 16384, -32768])))
        XCTAssertEqual(m.sampleRate, 24000)
        XCTAssertEqual(m.samples, [0, 0.5, -1])
        let s = try XCTUnwrap(decodeWav(wav(channels: 2, rate: 44100, pcm16: [16384, 0, -16384, -16384])))
        XCTAssertEqual(s.sampleRate, 44100)
        XCTAssertEqual(s.samples, [0.25, -0.5])
        XCTAssertNil(decodeWav(Data("not a wav".utf8)))
        XCTAssertNil(decodeWav(Data()))
    }
}
