import XCTest
@testable import VoiceCore

final class ProtocolTests: XCTestCase {
    func testDecodesEveryCommand() {
        XCTAssertEqual(decodeLine(#"{"cmd":"listen","on":true}"#), .listen(on: true))
        XCTAssertEqual(decodeLine(#"{"cmd":"listen","on":false}"#), .listen(on: false))
        XCTAssertEqual(decodeLine(#"{"cmd":"hints","context":"a,b"}"#), .hints(context: "a,b"))
        XCTAssertEqual(decodeLine(#"{"cmd":"flush"}"#), .flush)
        XCTAssertEqual(
            decodeLine(#"{"cmd":"speak","id":"s1","text":"こんにちは","voice":"os:x","speed":1.2}"#),
            .speak(id: "s1", text: "こんにちは", voice: "os:x", speed: 1.2))
        XCTAssertEqual(decodeLine(#"{"cmd":"stopSpeaking"}"#), .stopSpeaking)
        XCTAssertEqual(decodeLine(#"{"cmd":"prepare"}"#), .prepare)
        XCTAssertEqual(decodeLine(#"{"cmd":"quit"}"#), .quit)
        XCTAssertEqual(decodeLine(#"{"cmd":"voices"}"#), .voices)
    }

    func testVoicesEventEncodes() throws {
        let j = try json(.voices(os: [VoiceInfo(id: "com.apple.voice.compact.ja-JP.Kyoko", name: "Kyoko")]))
        XCTAssertEqual(j["ev"] as? String, "voices")
        let os = try XCTUnwrap(j["os"] as? [[String: String]])
        XCTAssertEqual(os, [["id": "com.apple.voice.compact.ja-JP.Kyoko", "name": "Kyoko"]])
    }

    func testUnknownOrBrokenIsNil() {
        XCTAssertNil(decodeLine(#"{"cmd":"dance"}"#))
        XCTAssertNil(decodeLine("{not json"))
        XCTAssertNil(decodeLine(""))
        XCTAssertNil(decodeLine(#"{"cmd":"listen"}"#))
    }

    private func json(_ e: Event) throws -> [String: Any] {
        let line = encodeLine(e)
        XCTAssertFalse(line.contains("\n"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    }

    func testEncodesEvents() throws {
        XCTAssertEqual(try json(.ready(version: "1")) as NSDictionary, ["ev": "ready", "version": "1"])
        XCTAssertEqual(
            try json(.models(state: .downloading, progress: 0.5, message: nil)) as NSDictionary,
            ["ev": "models", "state": "downloading", "progress": 0.5])
        XCTAssertEqual(
            try json(.models(state: .failed, progress: 0, message: "x")) as NSDictionary,
            ["ev": "models", "state": "failed", "progress": 0, "message": "x"])
        XCTAssertEqual(try json(.vad(speech: true)) as NSDictionary, ["ev": "vad", "speech": true])
        XCTAssertEqual(
            try json(.segment(id: "a", text: "改行\nあり", dbfs: -20.5, ms: 1200)) as NSDictionary,
            ["ev": "segment", "id": "a", "text": "改行\nあり", "dbfs": -20.5, "ms": 1200])
        XCTAssertEqual(try json(.flushed) as NSDictionary, ["ev": "flushed"])
        XCTAssertEqual(
            try json(.speaking(id: "s", state: .stopped)) as NSDictionary,
            ["ev": "speaking", "id": "s", "state": "stopped"])
        XCTAssertEqual(
            try json(.micUsers(bundles: ["a.b"])) as NSDictionary, ["ev": "micUsers", "bundles": ["a.b"]])
        XCTAssertEqual(
            try json(.error(code: "c", message: "m")) as NSDictionary,
            ["ev": "error", "code": "c", "message": "m"])
    }
}
