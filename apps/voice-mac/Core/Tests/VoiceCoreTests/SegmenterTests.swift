import XCTest
@testable import VoiceCore

final class SegmenterTests: XCTestCase {
    let frame = 512
    var framesPerSec: Int { 16000 / frame }  // 31.25

    func frames(_ n: Int, prob: Float, amp: Float = 0.1) -> [([Float], Float)] {
        (0..<n).map { _ in ([Float](repeating: amp, count: 512), prob) }
    }

    func run(_ seg: inout Segmenter, _ input: [([Float], Float)]) -> [SegmenterOutput] {
        input.flatMap { seg.push(frame: $0.0, prob: $0.1) }
    }

    func kinds(_ o: [SegmenterOutput]) -> [String] {
        o.map {
            switch $0 {
            case .speechStart: return "start"
            case .speechEnd: return "end"
            case .segment: return "segment"
            }
        }
    }

    func segmentSamples(_ o: [SegmenterOutput]) -> [[Float]] {
        o.compactMap { if case .segment(let s, _) = $0 { return s } else { return nil } }
    }

    func testSilenceOnlyEmitsNothing() {
        var seg = Segmenter()
        XCTAssertTrue(run(&seg, frames(100, prob: 0.0, amp: 0)).isEmpty)
        XCTAssertTrue(seg.flush().isEmpty)
    }

    func testOneSecondOfSpeechThenSilence() {
        var seg = Segmenter()
        var input = frames(16, prob: 0.0, amp: 0.001)  // 0.5 秒の無音
        input += frames(32, prob: 0.9)                  // 約 1 秒の声
        input += frames(32, prob: 0.0, amp: 0.001)     // 約 1 秒の無音
        let out = run(&seg, input)
        XCTAssertEqual(kinds(out), ["start", "end", "segment"])
        let s = segmentSamples(out)[0]
        // 声 1 秒と前の 300 ms を含む。
        XCTAssertGreaterThanOrEqual(s.count, 16000 + 4800)
        if case .segment(_, let dbfs) = out[2] { XCTAssertEqual(dbfs, -20, accuracy: 1) }
    }

    func testFlushMidSpeechEmitsSegment() {
        var seg = Segmenter()
        var out = run(&seg, frames(20, prob: 0.9))
        XCTAssertEqual(kinds(out), ["start"])
        out = seg.flush()
        XCTAssertEqual(kinds(out), ["end", "segment"])
        XCTAssertGreaterThanOrEqual(segmentSamples(out)[0].count, 20 * 512)
        XCTAssertTrue(seg.flush().isEmpty)
    }

    func testCutsAtThirtySeconds() {
        var seg = Segmenter()
        let out = run(&seg, frames(31 * framesPerSec + 10, prob: 0.9))
        let segs = segmentSamples(out)
        XCTAssertGreaterThanOrEqual(segs.count, 1)
        XCTAssertLessThanOrEqual(segs[0].count, 30 * 16000 + 512)
        XCTAssertGreaterThanOrEqual(segs[0].count, 30 * 16000 - 512)
    }

    func testSingleVoiceFrameDoesNotStart() {
        var seg = Segmenter()
        var input = frames(10, prob: 0.0)
        input += frames(1, prob: 0.9)
        input += frames(40, prob: 0.0)
        XCTAssertTrue(run(&seg, input).isEmpty)
    }

    func testShortSilenceDoesNotCloseSegment() {
        var seg = Segmenter()
        var input = frames(20, prob: 0.9)
        input += frames(10, prob: 0.0)  // 約 320 ms の間
        input += frames(20, prob: 0.9)
        let out = run(&seg, input)
        XCTAssertEqual(kinds(out), ["start"])
    }
}
