import XCTest
@testable import VoiceCore

final class KanaPhonemesTests: XCTestCase {
    // 値は misaki（ja、cutlet）の出力から取った。
    func testKanaMatchesMisaki() {
        let cases: [(String, String)] = [
            ("りょうかい", "ɾʲoːkai"),
            ("きっぷ", "kʲiʔpɯ"),
            ("かんぱい", "kampai"),
            ("さんぽ", "sampo"),
            ("まんが", "maŋɡa"),
            ("コンピューター", "kompʲɨːtaː"),
            ("ちょっと", "ʨoʔto"),
            ("ふぁいる", "ɸaiɾɯ"),
            ("しんぶん", "ɕimbɯɴ"),
        ]
        for (kana, want) in cases {
            XCTAssertEqual(kanaToPhonemes(kana), want, kana)
        }
    }

    func testLongVowelsFoldLikePronunciation() {
        XCTAssertEqual(kanaToPhonemes("せってい"), "seʔteː")
        XCTAssertEqual(kanaToPhonemes("とおっ"), "toːʔ")
        XCTAssertEqual(kanaToPhonemes("じゅんちょう"), "ʥɨɲʨoː")
    }

    func testNumbersToKana() {
        XCTAssertEqual(numberToKana("0"), "ぜろ")
        XCTAssertEqual(numberToKana("534"), "ごひゃくさんじゅうよん")
        XCTAssertEqual(numberToKana("1000"), "せん")
        XCTAssertEqual(numberToKana("3800"), "さんぜんはっぴゃく")
        XCTAssertEqual(numberToKana("600"), "ろっぴゃく")
        XCTAssertEqual(numberToKana("12345"), "いちまんにせんさんびゃくよんじゅうご")
    }

    func testSentenceReadsKanjiAndFixesParticles() {
        let p = japaneseToPhonemes("私は駅へ行きます。")
        XCTAssertTrue(p.contains("βa ekʲi e"), p)
        XCTAssertTrue(p.hasSuffix("."), p)
        XCTAssertFalse(p.contains("ha "), p)
    }

    func testSentenceKeepsAsciiAndMapsPunctuation() {
        let p = japaneseToPhonemes("許可の確認が一件来ています。テストの実行を許可しますか？")
        XCTAssertTrue(p.hasPrefix("kʲoka no kakɯɲiɴ ɡa"), p)
        XCTAssertTrue(p.hasSuffix("ka?"), p)
        let q = japaneseToPhonemes("opencode の 534 を見て")
        XCTAssertTrue(q.hasPrefix("opencode no"), q)
        XCTAssertTrue(q.contains("saɲʥɨːjoɴ"), q)
    }

    func testAcronymsAreSpelledAndOtherLatinGoesToEnglishAsPhrases() {
        final class Seen: @unchecked Sendable { var phrases: [String] = [] }
        let seen = Seen()
        let opts = LatinOptions(spellAcronyms: true, english: { phrase in
            seen.phrases.append(phrase)
            return "<" + phrase + ">"
        })
        let p = japaneseToPhonemes("PRのCIが通ったら、Hangar.appとupdate-readmeとREADMEを見て。", latin: opts)
        XCTAssertTrue(p.hasPrefix("pʲiːaːɾɯ no ɕiːai ɡa"), p)
        XCTAssertEqual(seen.phrases, ["Hangar app", "update readme", "readme"])
        XCTAssertTrue(p.contains("<Hangar app> to <update readme> to <readme> o"), p)
    }

    func testLatinStaysAsIsWithoutEnglish() {
        XCTAssertEqual(japaneseToPhonemes("Claude Codeを起動", latin: LatinOptions(spellAcronyms: true)), "Claude Code o kʲidoː")
    }
}
