import XCTest
@testable import VoiceCore

final class MicUsersTests: XCTestCase {
    func testExcludesSelfCoreSpeechAndIdle() {
        let procs = [
            AudioProcessInfo(pid: 10, bundleID: "com.example.hangar-voice", runningInput: true),
            AudioProcessInfo(pid: 11, bundleID: "com.apple.CoreSpeech", runningInput: true),
            AudioProcessInfo(pid: 12, bundleID: "us.zoom.xos", runningInput: true),
            AudioProcessInfo(pid: 13, bundleID: "com.apple.Music", runningInput: false),
        ]
        XCTAssertEqual(micUserBundles(procs, selfPID: 10), ["us.zoom.xos"])
    }

    func testNoBundleFallsBackToPidAndResultIsSortedUnique() {
        let procs = [
            AudioProcessInfo(pid: 30, bundleID: "com.b", runningInput: true),
            AudioProcessInfo(pid: 31, bundleID: nil, runningInput: true),
            AudioProcessInfo(pid: 32, bundleID: "", runningInput: true),
            AudioProcessInfo(pid: 33, bundleID: "com.a", runningInput: true),
            AudioProcessInfo(pid: 34, bundleID: "com.a", runningInput: true),
        ]
        XCTAssertEqual(micUserBundles(procs, selfPID: 1), ["com.a", "com.b", "pid:31", "pid:32"])
    }

    func testChangeGateEmitsFirstAndChangesOnly() {
        var g = ChangeGate<[String]>()
        XCTAssertEqual(g.update([]), [])
        XCTAssertNil(g.update([]))
        XCTAssertEqual(g.update(["a"]), ["a"])
        XCTAssertNil(g.update(["a"]))
        XCTAssertEqual(g.update([]), [])
    }
}

final class FramerTests: XCTestCase {
    func testSplitsIntoFixedFramesAndKeepsRemainder() {
        var f = Framer(size: 4)
        XCTAssertEqual(f.push([1, 2, 3]), [])
        XCTAssertEqual(f.push([4, 5, 6, 7, 8, 9]), [[1, 2, 3, 4], [5, 6, 7, 8]])
        XCTAssertEqual(f.push([10, 11, 12]), [[9, 10, 11, 12]])
        XCTAssertEqual(f.push([]), [])
    }
}

final class VoiceSpecTests: XCTestCase {
    func testParsesOsAndKokoro() {
        XCTAssertEqual(
            VoiceSpec("os:com.apple.voice.compact.ja-JP.Kyoko"),
            .os(identifier: "com.apple.voice.compact.ja-JP.Kyoko"))
        XCTAssertEqual(VoiceSpec("kokoro:jf_alpha"), .kokoro(voice: "jf_alpha"))
        XCTAssertEqual(VoiceSpec("voicevox:3"), .voicevox(style: 3))
        XCTAssertEqual(VoiceSpec("aivis:888753760"), .aivis(style: 888753760))
        XCTAssertEqual(VoiceSpec("voicevox:0"), .voicevox(style: 0))
        for bad in ["voicevox:x", "voicevox:", "voicevox:-1", "voicevox:+1", "aivis:1.5", "aivis:"] {
            XCTAssertNil(VoiceSpec(bad), bad)
        }
        XCTAssertNil(VoiceSpec("os:"))
        XCTAssertNil(VoiceSpec("Kyoko"))
    }

    func testOsRateScalesDefaultAndClamps() {
        XCTAssertEqual(osSpeechRate(speed: 1.0), 0.5, accuracy: 1e-6)
        XCTAssertEqual(osSpeechRate(speed: 1.2), 0.6, accuracy: 1e-6)
        XCTAssertEqual(osSpeechRate(speed: 5), 1.0, accuracy: 1e-6)
        XCTAssertEqual(osSpeechRate(speed: -1), 0.0, accuracy: 1e-6)
    }
}

final class OptionsTests: XCTestCase {
    func testParsesFlags() {
        XCTAssertEqual(Options.parse([]), Options(inputFile: nil, speakToDir: nil))
        XCTAssertEqual(
            Options.parse(["--input-file", "a.wav", "--speak-to-file", "/tmp/o"]),
            Options(inputFile: "a.wav", speakToDir: "/tmp/o"))
    }

    func testMissingValueOrUnknownFlagIsNil() {
        XCTAssertNil(Options.parse(["--input-file"]))
        XCTAssertNil(Options.parse(["--nope"]))
    }
}
