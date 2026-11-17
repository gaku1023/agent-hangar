// かな → Kokoro の音素。
// 表と、っ・ん・小さいかなの扱いは misaki（https://github.com/hexgrad/misaki、Apache 2.0）の
// misaki/cutlet.py の HEPBURN と Cutlet._get_single_mapping を移したもの。
// cutlet.py 自体は cutlet（https://github.com/polm/cutlet、MIT）を misaki が手直ししたもの。
// misaki は辞書（unidic）の発音形から読むので、長音（とう → とー）は辞書が済ませている。
// こちらは CFStringTokenizer の読み（りょうかい）から作るので、長音への寄せを足してある。
import Foundation

private let hepburn: [String: String] = {
    var t: [String: String] = [
        "ぁ": "a", "あ": "a", "ぃ": "i", "い": "i", "ぅ": "ɯ", "う": "ɯ", "ぇ": "e", "え": "e", "ぉ": "o", "お": "o",
        "か": "ka", "が": "ɡa", "き": "kʲi", "ぎ": "ɡʲi", "く": "kɯ", "ぐ": "ɡɯ", "け": "ke", "げ": "ɡe", "こ": "ko", "ご": "ɡo",
        "さ": "sa", "ざ": "ʣa", "し": "ɕi", "じ": "ʥi", "す": "sɨ", "ず": "zɨ", "せ": "se", "ぜ": "ʣe", "そ": "so", "ぞ": "ʣo",
        "た": "ta", "だ": "da", "ち": "ʨi", "ぢ": "ʥi", "つ": "ʦɨ", "づ": "zɨ", "て": "te", "で": "de", "と": "to", "ど": "do",
        "な": "na", "に": "ɲi", "ぬ": "nɯ", "ね": "ne", "の": "no",
        "は": "ha", "ば": "ba", "ぱ": "pa", "ひ": "çi", "び": "bʲi", "ぴ": "pʲi", "ふ": "ɸɯ", "ぶ": "bɯ", "ぷ": "pɯ",
        "へ": "he", "べ": "be", "ぺ": "pe", "ほ": "ho", "ぼ": "bo", "ぽ": "po",
        "ま": "ma", "み": "mʲi", "む": "mɯ", "め": "me", "も": "mo",
        "ゃ": "ja", "や": "ja", "ゅ": "jɯ", "ゆ": "jɯ", "ょ": "jo", "よ": "jo",
        "ら": "ɾa", "り": "ɾʲi", "る": "ɾɯ", "れ": "ɾe", "ろ": "ɾo",
        "ゎ": "βa", "わ": "βa", "ゐ": "i", "ゑ": "e", "を": "o", "ゔ": "vɯ", "ゕ": "ka", "ゖ": "ke",
        "ヷ": "va", "ヸ": "vʲi", "ヹ": "ve", "ヺ": "vo",
    ]
    let digraphs: [String: String] = [
        "いぇ": "je", "うぃ": "βi", "うぇ": "βe", "うぉ": "βo",
        "きぇ": "kʲe", "きゃ": "kʲa", "きゅ": "kʲɨ", "きょ": "kʲo",
        "ぎゃ": "ɡʲa", "ぎゅ": "ɡʲɨ", "ぎょ": "ɡʲo",
        "くぁ": "kᵝa", "くぃ": "kᵝi", "くぇ": "kᵝe", "くぉ": "kᵝo",
        "ぐぁ": "ɡᵝa", "ぐぃ": "ɡᵝi", "ぐぇ": "ɡᵝe", "ぐぉ": "ɡᵝo",
        "しぇ": "ɕe", "しゃ": "ɕa", "しゅ": "ɕɨ", "しょ": "ɕo",
        "じぇ": "ʥe", "じゃ": "ʥa", "じゅ": "ʥɨ", "じょ": "ʥo",
        "ちぇ": "ʨe", "ちゃ": "ʨa", "ちゅ": "ʨɨ", "ちょ": "ʨo",
        "ぢゃ": "ʥa", "ぢゅ": "ʥɨ", "ぢょ": "ʥo",
        "つぁ": "ʦa", "つぃ": "ʦʲi", "つぇ": "ʦe", "つぉ": "ʦo",
        "てぃ": "tʲi", "てゅ": "tʲɨ", "でぃ": "dʲi", "でゅ": "dʲɨ", "とぅ": "tɯ", "どぅ": "dɯ",
        "にぇ": "ɲe", "にゃ": "ɲa", "にゅ": "ɲɨ", "にょ": "ɲo",
        "ひぇ": "çe", "ひゃ": "ça", "ひゅ": "çɨ", "ひょ": "ço",
        "びゃ": "bʲa", "びゅ": "bʲɨ", "びょ": "bʲo", "ぴゃ": "pʲa", "ぴゅ": "pʲɨ", "ぴょ": "pʲo",
        "ふぁ": "ɸa", "ふぃ": "ɸʲi", "ふぇ": "ɸe", "ふぉ": "ɸo", "ふゅ": "ɸʲɨ", "ふょ": "ɸʲo",
        "みゃ": "mʲa", "みゅ": "mʲɨ", "みょ": "mʲo", "りゃ": "ɾʲa", "りゅ": "ɾʲɨ", "りょ": "ɾʲo",
        "ゔぁ": "va", "ゔぃ": "vʲi", "ゔぇ": "ve", "ゔぉ": "vo", "ゔゅ": "bʲɨ", "ゔょ": "bʲo",
    ]
    t.merge(digraphs) { a, _ in a }
    return t
}()

private let sutegana: Set<Character> = ["ゃ", "ゅ", "ょ", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ"]

/// カタカナをひらがなに寄せる（ー はそのまま）。
func toHiragana(_ s: String) -> String {
    var out = ""
    for u in s.unicodeScalars {
        if (0x30A1...0x30F6).contains(u.value), let h = Unicode.Scalar(u.value - 0x60) {
            out.unicodeScalars.append(h)
        } else {
            out.unicodeScalars.append(u)
        }
    }
    return out
}

/// 辞書の発音形と同じく、伸ばす母音を ー に寄せる。
/// お段＋う・お、う段＋う、え段＋い。
private func foldLongVowels(_ hira: [Character]) -> [Character] {
    var out: [Character] = []
    var lastVowel: Character?
    for (i, c) in hira.enumerated() {
        let prev = i > 0 ? hira[i - 1] : nil
        if let v = lastVowel, prev != nil, prev != "っ", prev != "ん", prev != "ー" {
            let fold = (v == "o" && (c == "う" || c == "お")) || (v == "ɯ" && c == "う") || (v == "ɨ" && c == "う")
                || (v == "e" && c == "い")
            if fold {
                out.append("ー")
                continue
            }
        }
        out.append(c)
        if let p = hepburn[String(c)] {
            // 小さいかなは前と合わさって母音を決める。
            lastVowel = p.last
            if sutegana.contains(c), let pc = prev, let d = hepburn[String(pc) + String(c)] {
                lastVowel = d.last
            }
        } else if c != "ー" {
            lastVowel = nil
        }
    }
    return out
}

private func singleMapping(_ pk: Character?, _ kk: Character, _ nk: Character?) -> String {
    if let pk, let d = hepburn[String(pk) + String(kk)] { return d }
    if let nk, hepburn[String(kk) + String(nk)] != nil { return "" }
    if let nk, sutegana.contains(nk) {
        if kk == "っ" { return "" }
        guard let a = hepburn[String(kk)], let b = hepburn[String(nk)] else { return "" }
        return String(a.dropLast()) + b
    }
    if sutegana.contains(kk) { return "" }
    if kk == "ー" { return "ː" }
    if kk == "っ" { return "ʔ" }
    if kk == "ん" {
        if let nk, let t = hepburn[String(nk)], let f = t.first {
            if "mpb".contains(f) { return "m" }
            if "kɡ".contains(f) { return "ŋ" }
            if t.hasPrefix("ɲ") || t.hasPrefix("ʨ") || t.hasPrefix("ʥ") { return "ɲ" }
            if "ntdɾz".contains(f) { return "n" }
        }
        return "ɴ"
    }
    return hepburn[String(kk)] ?? ""
}

/// かな（ひらがなでもカタカナでもよい）の 1 語を Kokoro の音素にする。表に無い字は落とす。
public func kanaToPhonemes(_ kana: String) -> String {
    let hira = foldLongVowels(Array(toHiragana(kana)))
    var out = ""
    for (i, c) in hira.enumerated() {
        let pk = i > 0 ? hira[i - 1] : nil
        let nk = i + 1 < hira.count ? hira[i + 1] : nil
        out += singleMapping(pk, c, nk)
    }
    return out
}

/// 数字の並びをかなの読みにする（兆まで）。数字でなければ nil。
public func numberToKana(_ digits: String) -> String? {
    guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
    let trimmed = digits.drop { $0 == "0" }
    if trimmed.isEmpty { return "ぜろ" }
    guard trimmed.count <= 16, let n = UInt64(trimmed) else { return nil }
    let ones = ["", "いち", "に", "さん", "よん", "ご", "ろく", "なな", "はち", "きゅう"]
    func under10000(_ v: Int) -> String {
        var s = ""
        let th = v / 1000, h = (v / 100) % 10, t = (v / 10) % 10, o = v % 10
        switch th {
        case 0: break
        case 1: s += "せん"
        case 3: s += "さんぜん"
        case 8: s += "はっせん"
        default: s += ones[th] + "せん"
        }
        switch h {
        case 0: break
        case 1: s += "ひゃく"
        case 3: s += "さんびゃく"
        case 6: s += "ろっぴゃく"
        case 8: s += "はっぴゃく"
        default: s += ones[h] + "ひゃく"
        }
        switch t {
        case 0: break
        case 1: s += "じゅう"
        default: s += ones[t] + "じゅう"
        }
        s += ones[o]
        return s
    }
    let units = ["", "まん", "おく", "ちょう"]
    var parts: [String] = []
    var v = n
    var i = 0
    while v > 0 {
        let chunk = Int(v % 10000)
        if chunk > 0 { parts.insert(under10000(chunk) + units[i], at: 0) }
        v /= 10000
        i += 1
    }
    return parts.joined()
}
