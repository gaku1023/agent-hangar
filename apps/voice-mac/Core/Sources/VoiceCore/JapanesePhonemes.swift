// 日本語の文を Kokoro の音素の列にする。
// CFStringTokenizer（ロケール ja）で語に分け、語ごとの読みをかなにし、KanaPhonemes で音素にする。
// 語は空白でつなぎ、句読点は misaki の PUNCT_MAP のとおり ASCII の記号にする。
// 英字の語は、続く英字の語ごとにまとめて LatinOptions のとおりに読む。
import Foundation

/// 英字の語の読み方。上から順に試し、どれにも当たらなければそのまま渡す（misaki の ja と同じ）。
public struct LatinOptions: Sendable {
    /// 大文字だけの短い語（PR、CI）と母音の無い語（npm）を、文字の名前で読む（ピーアール）。
    public var spellAcronyms: Bool
    /// 辞書にカタカナの読みがあればそれで読む（Windows → ウインドウズ）。
    public var kanaIfKnown: Bool
    /// 英語の音素にする関数（英字の語のまとまりを受け取る）。nil を返せば次へ。
    public var english: (@Sendable (String) -> String?)?

    public init(spellAcronyms: Bool = false, kanaIfKnown: Bool = false, english: (@Sendable (String) -> String?)? = nil) {
        self.spellAcronyms = spellAcronyms
        self.kanaIfKnown = kanaIfKnown
        self.english = english
    }
}

private let punctMap: [Character: String] = [
    "、": ",", "。": ".", "，": ",", "．": ".",
    "「": "“", "」": "”", "『": "“", "』": "”", "【": "“", "】": "”",
    "《": "“", "》": "”", "〈": "“", "〉": "”", "«": "“", "»": "”",
    "！": "!", "？": "?", "（": "(", "）": ")", "：": ":", "；": ";",
    "〜": "—", "～": "—", "…": "…", "—": "—",
]
private let asciiKeep: Set<Character> = ["!", "?", ",", ".", ":", ";", "(", ")", "\"", "-", "/", "'"]
private let stops: Set<Character> = ["!", "?", ",", ".", ":", ";", ")", "”", "…", "—"]
private let starts: Set<Character> = ["(", "“"]

private let letterNames: [Character: String] = [
    "A": "えー", "B": "びー", "C": "しー", "D": "でぃー", "E": "いー", "F": "えふ", "G": "じー",
    "H": "えいち", "I": "あい", "J": "じぇー", "K": "けー", "L": "える", "M": "えむ", "N": "えぬ",
    "O": "おー", "P": "ぴー", "Q": "きゅー", "R": "あーる", "S": "えす", "T": "てぃー", "U": "ゆー",
    "V": "ぶい", "W": "だぶりゅー", "X": "えっくす", "Y": "わい", "Z": "ぜっと",
]

private func isKana(_ c: Character) -> Bool {
    guard let u = c.unicodeScalars.first, c.unicodeScalars.count == 1 else { return false }
    return (0x3041...0x309F).contains(u.value) || (0x30A0...0x30FF).contains(u.value)
}

private func isLatinWord(_ s: String) -> Bool {
    s.unicodeScalars.contains { $0.isASCII && CharacterSet.letters.contains($0) }
}

/// 文字の名前で読む語か。大文字だけで 4 字まで。
func isAcronym(_ w: String) -> Bool {
    guard !w.isEmpty, w.count <= 4 else { return false }
    return w.allSatisfy { $0.isASCII && $0.isLetter && $0.isUppercase }
}

/// 英字の語を文字の名前のかなにする。
func spellLetters(_ w: String) -> String {
    w.uppercased().compactMap { letterNames[$0] }.joined()
}

/// Latin の転写（ryōkai、too~tsu）をひらがなにする。長音の記号の母音は ー にする。
/// ~tsu は小さい っ（変換がそのまま扱う）。
private func latinToHiragana(_ latin: String) -> String {
    var buf = ""
    var out = ""
    func flush() {
        guard !buf.isEmpty else { return }
        let m = NSMutableString(string: buf)
        CFStringTransform(m, nil, kCFStringTransformLatinHiragana, false)
        out += m as String
        buf = ""
    }
    for c in latin.precomposedStringWithCanonicalMapping {
        switch c {
        case "ā", "ī", "ū", "ē", "ō", "â", "î", "û", "ê", "ô":
            let base = String(c).decomposedStringWithCanonicalMapping.unicodeScalars.first.map { String(Character($0)) } ?? ""
            buf += base
            flush()
            out += "ー"
        default:
            buf.append(c)
        }
    }
    flush()
    return out
}

private func kanaFromLatin(_ latin: String?) -> String? {
    guard let latin, !latin.isEmpty else { return nil }
    let h = latinToHiragana(latin)
    return !h.isEmpty && h.allSatisfy({ isKana($0) }) ? h : nil
}

private struct Piece {
    var text: String
    var isPunct: Bool
}

private struct LatinWord {
    var surface: String
    var transcription: String?
    /// 前の語との間の記号（"-"、"." など。空白だけなら空）。
    var joiner: String
}

/// 続く英字の語のまとまりを音素にする。
private func latinRunPhonemes(_ run: [LatinWord], _ opts: LatinOptions) -> [String] {
    var out: [String] = []
    var englishBuf: [LatinWord] = []
    func flushEnglish() {
        guard !englishBuf.isEmpty else { return }
        defer { englishBuf.removeAll() }
        if let english = opts.english {
            // 語の間の記号（update-readme、Hangar.app）は空白にする。記号のままだと間が空く。
            // 大文字だけの長い語（README）は、1 字ずつ読まれないよう小文字にする。
            let phrase = englishBuf.map { w in
                w.surface.count > 4 && w.surface.allSatisfy({ $0.isUppercase }) ? w.surface.lowercased() : w.surface
            }.joined(separator: " ")
            if let p = english(phrase), !p.isEmpty {
                out.append(p)
                return
            }
        }
        for w in englishBuf { out.append(w.surface) }
    }
    for w in run {
        if opts.spellAcronyms, isAcronym(w.surface) {
            flushEnglish()
            out.append(kanaToPhonemes(spellLetters(w.surface)))
            continue
        }
        if opts.kanaIfKnown, let t = w.transcription, t.lowercased() != w.surface.lowercased(),
            let h = kanaFromLatin(t)
        {
            flushEnglish()
            out.append(kanaToPhonemes(h))
            continue
        }
        englishBuf.append(w)
    }
    flushEnglish()
    return out
}

/// 日本語の文を Kokoro の音素の列にする。
public func japaneseToPhonemes(_ text: String, latin opts: LatinOptions = LatinOptions()) -> String {
    let s = text.precomposedStringWithCompatibilityMapping as NSString
    let cf = s as CFString
    let length = CFStringGetLength(cf)
    guard length > 0 else { return "" }
    let tok = CFStringTokenizerCreate(
        nil, cf, CFRangeMake(0, length), kCFStringTokenizerUnitWord, Locale(identifier: "ja") as CFLocale)
    var pieces: [Piece] = []
    var run: [LatinWord] = []

    func flushRun() {
        guard !run.isEmpty else { return }
        for p in latinRunPhonemes(run, opts) { pieces.append(Piece(text: p, isPunct: false)) }
        run.removeAll()
    }
    func addGap(_ gap: String) {
        for c in gap {
            if let p = punctMap[c] {
                pieces.append(Piece(text: p, isPunct: true))
            } else if asciiKeep.contains(c) {
                pieces.append(Piece(text: String(c), isPunct: true))
            }
        }
    }

    var cursor = 0
    while CFStringTokenizerAdvanceToNextToken(tok) != [] {
        let r = CFStringTokenizerGetCurrentTokenRange(tok)
        let gap = r.location > cursor ? s.substring(with: NSRange(location: cursor, length: r.location - cursor)) : ""
        cursor = r.location + r.length
        let surface = s.substring(with: NSRange(location: r.location, length: r.length))
        let latin = CFStringTokenizerCopyCurrentTokenAttribute(tok, kCFStringTokenizerAttributeLatinTranscription) as? String

        if isLatinWord(surface) {
            // 英字の語どうしの間が空白か、語の中の記号（- . / '）だけなら、同じまとまりに入れる。
            let joiner = gap.trimmingCharacters(in: .whitespaces)
            if !run.isEmpty, joiner.allSatisfy({ "-./'".contains($0) }), joiner.count <= 1 {
                run.append(LatinWord(surface: surface, transcription: latin, joiner: joiner))
            } else {
                flushRun()
                addGap(gap)
                run.append(LatinWord(surface: surface, transcription: latin, joiner: ""))
            }
            continue
        }
        flushRun()
        addGap(gap)
        var h: String
        if surface.allSatisfy({ isKana($0) }) {
            h = toHiragana(surface)
        } else if let k = numberToKana(surface) {
            h = k
        } else if let k = kanaFromLatin(latin) {
            h = k
        } else {
            // 読めない記号などは句読点として扱えるものだけ残す。
            addGap(surface)
            continue
        }
        // 助詞の「は」「へ」は「わ」「え」と読む。語に分けたとき 1 字で出る。
        if surface == "は" { h = "わ" } else if surface == "へ" { h = "え" }
        let p = kanaToPhonemes(h)
        if !p.isEmpty { pieces.append(Piece(text: p, isPunct: false)) }
    }
    flushRun()
    addGap(cursor < length ? s.substring(from: cursor) : "")

    // 句読点の前は詰め、後に空白。開きの記号の後は詰める。促音（ʔ）の前後は詰める（misaki と同じ）。
    var out = ""
    var glueNext = true
    for p in pieces {
        if p.isPunct, let c = p.text.first {
            if stops.contains(c) {
                while out.hasSuffix(" ") { out.removeLast() }
                out += p.text + " "
            } else if starts.contains(c) {
                if !out.isEmpty, !out.hasSuffix(" ") { out += " " }
                out += p.text
            } else {
                out += p.text
            }
            glueNext = true
            continue
        }
        if !glueNext, !out.hasSuffix("ʔ"), !p.text.hasPrefix("ʔ") { out += " " }
        out += p.text
        glueNext = false
    }
    return out.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
}
