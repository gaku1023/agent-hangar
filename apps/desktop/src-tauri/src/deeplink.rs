//! `hangar://` の URL を UI のハッシュ経路に変換する。
//! 変換先は shared の `formatRoute` と同じ形で、`#/session/<id>`、`#/project/<id>`、`#/sessions?q=<text>` の三形だけを受ける。
//! 三形以外と `hangar` 以外のスキームは `None` を返し、呼び出し側がログに残して無視する。

use url::Url;

/// 受け付けるディープリンクの長さの上限（バイト）。
/// OS から渡る一件の URL の長さであり、実際に使う形はどれも 100 バイトに満たない
/// （`hangar://session/<ULID>` で 43 バイト、日本語 20 文字の検索語でも 200 バイト前後）。
/// 一方で上限が無いと、生成する JavaScript が入力のおよそ 9 倍まで膨らむ
/// （レビューの実測で 100 万字の検索語から 9MB の JavaScript ができた）。
/// 2048 は、古くからブラウザが URL の実用上の上限として扱ってきた 2KB に合わせた値で、
/// 正しい使い方には 20 倍以上の余裕があり、最悪でも JavaScript は 20KB 程度に収まる。
const MAX_DEEP_LINK_BYTES: usize = 2048;

/// `hangar://` の URL を UI のハッシュ経路に変換する。
/// 受けるのは `hangar://session/<id>`、`hangar://project/<id>`、`hangar://search?q=<text>` の三形だけ。
pub fn deep_link_to_hash(raw: &str) -> Option<String> {
    if raw.len() > MAX_DEEP_LINK_BYTES {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "hangar" {
        return None;
    }
    // 三形に無い部分が付いた URL は、黙って捨てて別の場所へ飛ばすより `None` にして呼び出し側の記録に残す。
    // 利用者情報とポートと断片がこれに当たる。
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return None;
    }
    if url.fragment().is_some() {
        return None;
    }
    // スキームは `url` crate が小文字化するが、非特殊スキームのホストは小文字化されないので自分で揃える。
    let kind = url.host_str()?.to_ascii_lowercase();
    let id = url.path().trim_matches('/');
    match kind.as_str() {
        "session" | "project" => {
            // この二形に問い合わせは無い。
            if id.is_empty() || id.contains('/') || url.query().is_some() {
                return None;
            }
            Some(format!("#/{kind}/{id}"))
        }
        "search" => {
            // この形に経路は無い。
            if !id.is_empty() {
                return None;
            }
            // 受けるのは `q` 一つだけで、他の名前や二つ目が付いた形は受けない。
            let mut pairs = url.query_pairs();
            let q = match (pairs.next(), pairs.next()) {
                (None, _) => String::new(),
                (Some((k, v)), None) if k == "q" => v.into_owned(),
                _ => return None,
            };
            // 空の検索語は `parseRoute` が落とすので、こちらでも落として `#/sessions` に寄せる。
            if q.trim().is_empty() {
                return Some("#/sessions".to_string());
            }
            // `form_urlencoded` は空白を `+` にするが、UI の `URLSearchParams` が空白に戻す。
            // 語そのものの `+` は `%2B` になるので、往復しても崩れない。
            let encoded: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
            Some(format!("#/sessions?q={encoded}"))
        }
        _ => None,
    }
}

/// webview で評価する JS を組み立てる。
/// ハッシュが今と違うときは代入し、同じときは自分で `hashchange` を投げる。
/// ブラウザは同じ値の代入では `hashchange` を発火せず、UI は素の `hashchange` を購読しているので、
/// 投げないと同じディープリンクを二度開いたときに二度目が無反応になる。
pub fn hash_to_js(hash: &str) -> String {
    let lit = js_string_literal(hash);
    format!(
        "(function(){{var h={lit};\
         if(location.hash===h){{window.dispatchEvent(new HashChangeEvent(\"hashchange\",{{oldURL:location.href,newURL:location.href}}));}}\
         else{{location.hash=h;}}}})();"
    )
}

/// 文字列を JS のリテラルにする。
/// JSON の文字列は JS の文字列リテラルの部分集合なので `serde_json` に任せられるが、
/// 行区切りの二つの符号位置だけは JSON がそのまま通してしまうので、ここで逃がす。
fn js_string_literal(value: &str) -> String {
    let json = serde_json::to_string(value).unwrap_or_else(|_| "\"#/\"".to_string());
    if json.contains('\u{2028}') || json.contains('\u{2029}') {
        return json
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
    }
    json
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_and_project_map_to_hash_routes() {
        assert_eq!(
            deep_link_to_hash("hangar://session/0192abc"),
            Some("#/session/0192abc".into())
        );
        assert_eq!(
            deep_link_to_hash("hangar://session/0192abc/"),
            Some("#/session/0192abc".into())
        );
        assert_eq!(
            deep_link_to_hash("hangar://project/p1"),
            Some("#/project/p1".into())
        );
    }

    // 検索語の符号化。
    // 実測で `new URLSearchParams("q=a+b").get("q")` と `new URLSearchParams("q=a%20b").get("q")` は
    // どちらも `"a b"` を返し、`"a+b"` が返るのは `q=a%2Bb` のときだけだった（node で確認）。
    // つまり `form_urlencoded` の空白を `+` にする流儀のままで `parseRoute` が元の語に戻せる。
    #[test]
    fn search_maps_to_sessions_with_encoded_query() {
        assert_eq!(
            deep_link_to_hash("hangar://search?q=%E5%8B%95%E7%94%BB"),
            Some("#/sessions?q=%E5%8B%95%E7%94%BB".into())
        );
        assert_eq!(
            deep_link_to_hash("hangar://search?q=a%20b"),
            Some("#/sessions?q=a+b".into())
        );
        assert_eq!(
            deep_link_to_hash("hangar://search?q=a%2Bb"),
            Some("#/sessions?q=a%2Bb".into())
        );
        assert_eq!(
            deep_link_to_hash("hangar://search"),
            Some("#/sessions".into())
        );
        assert_eq!(
            deep_link_to_hash("hangar://search?q="),
            Some("#/sessions".into())
        );
        assert_eq!(
            deep_link_to_hash("hangar://search?q=%20%20"),
            Some("#/sessions".into())
        );
    }

    // ホスト名の綴りは大文字小文字を問わない。
    // スキームは `url` crate が小文字化するが、非特殊スキームのホストは小文字化されないので自分で揃える。
    #[test]
    fn the_kind_is_matched_case_insensitively() {
        assert_eq!(
            deep_link_to_hash("hangar://SESSION/abc"),
            Some("#/session/abc".into())
        );
        assert_eq!(
            deep_link_to_hash("HANGAR://Project/p1"),
            Some("#/project/p1".into())
        );
        assert_eq!(
            deep_link_to_hash("hangar://SeArCh?q=a"),
            Some("#/sessions?q=a".into())
        );
    }

    // 三形に無い部分が付いた URL は、黙って捨てずに `None` にする。
    #[test]
    fn extra_url_parts_are_rejected() {
        // 利用者情報。
        assert_eq!(deep_link_to_hash("hangar://user:pw@session/abc"), None);
        assert_eq!(deep_link_to_hash("hangar://user@session/abc"), None);
        assert_eq!(deep_link_to_hash("hangar://:pw@search?q=a"), None);
        // ポート。
        assert_eq!(deep_link_to_hash("hangar://session:8080/abc"), None);
        assert_eq!(deep_link_to_hash("hangar://search:8080?q=a"), None);
        // 余分な経路。
        assert_eq!(deep_link_to_hash("hangar://search/x?q=a"), None);
        assert_eq!(deep_link_to_hash("hangar://search/x"), None);
        // 余分な問い合わせ。
        assert_eq!(deep_link_to_hash("hangar://session/abc?x=1"), None);
        assert_eq!(deep_link_to_hash("hangar://project/p1?q=a"), None);
        assert_eq!(deep_link_to_hash("hangar://search?q=a&x=1"), None);
        assert_eq!(deep_link_to_hash("hangar://search?x=1"), None);
        assert_eq!(deep_link_to_hash("hangar://search?q=a&q=b"), None);
        // 断片。
        assert_eq!(deep_link_to_hash("hangar://session/abc#frag"), None);
        assert_eq!(deep_link_to_hash("hangar://search?q=a#frag"), None);
        // 経路の区切りだけが付いた形は、三形そのものなので受ける。
        assert_eq!(
            deep_link_to_hash("hangar://search/?q=a"),
            Some("#/sessions?q=a".into())
        );
    }

    // 長すぎるリンクは受けない。
    // 上限はバイト数で見るので、多バイトの文字でも同じところで切れる。
    #[test]
    fn over_long_links_are_rejected() {
        let head = "hangar://search?q=";
        let longest = format!("{head}{}", "a".repeat(MAX_DEEP_LINK_BYTES - head.len()));
        assert_eq!(longest.len(), MAX_DEEP_LINK_BYTES);
        assert!(deep_link_to_hash(&longest).is_some());
        assert_eq!(deep_link_to_hash(&format!("{longest}a")), None);

        // 文字数は上限より少ないが、バイト数では超える形。
        let multibyte = format!("{head}{}", "あ".repeat(MAX_DEEP_LINK_BYTES / 2));
        assert!(multibyte.chars().count() < MAX_DEEP_LINK_BYTES);
        assert!(multibyte.len() > MAX_DEEP_LINK_BYTES);
        assert_eq!(deep_link_to_hash(&multibyte), None);
    }

    #[test]
    fn unknown_shapes_are_rejected() {
        assert_eq!(deep_link_to_hash("hangar://session"), None);
        assert_eq!(deep_link_to_hash("hangar://session/"), None);
        assert_eq!(deep_link_to_hash("hangar://session/a/b"), None);
        assert_eq!(deep_link_to_hash("hangar://settings"), None);
        assert_eq!(deep_link_to_hash("hangar://"), None);
        assert_eq!(deep_link_to_hash("https://session/abc"), None);
        assert_eq!(deep_link_to_hash("not a url"), None);
        assert_eq!(deep_link_to_hash(""), None);
    }

    // 生成した JS から文字列リテラルだけを取り出す。
    // `var h=` と、その代入を閉じる `;` の間がリテラルになる。
    // 区切りはハッシュ自身にも現れうる（`hangar://session/a;if(b` で実際に起きる）ので、
    // 目印は代入より後ろに必ず一度だけ現れる全体で取り、後ろから探す。
    const TERMINATOR: &str = ";if(location.hash===h)";

    fn literal_of(js: &str) -> &str {
        let start = js.find("var h=").expect("no assignment") + "var h=".len();
        let rest = &js[start..];
        let end = rest.rfind(TERMINATOR).expect("no terminator");
        &rest[..end]
    }

    #[test]
    fn hash_to_js_quotes_the_hash_as_a_json_literal() {
        let js = hash_to_js("#/session/abc");
        assert!(js.contains("var h=\"#/session/abc\";"), "{js}");
    }

    // 引用符、バックスラッシュ、改行、行区切りの符号位置が入っても、
    // リテラルが JSON として読み戻せることを確かめる。
    // JSON の文字列は JS の文字列リテラルの部分集合なので、読み戻せれば JS としても同じ値になる。
    #[test]
    fn hash_to_js_survives_quotes_backslashes_and_newlines() {
        for hash in [
            "#/session/a\"b",
            "#/sessions?q=a\\b",
            "#/sessions?q=a\nb",
            "#/sessions?q=a\r\nb",
            "#/sessions?q=</script>",
            "#/sessions?q=a\u{2028}b\u{2029}c",
            "#/sessions?q=\u{0000}",
            "#/sessions?q=動画",
            // 取り出しの目印がハッシュの中に現れる形。
            "#/session/a;if(b",
            "#/session/a;if(location.hash===h){}",
        ] {
            let js = hash_to_js(hash);
            let lit = literal_of(&js);
            let back: String = serde_json::from_str(lit).unwrap_or_else(|e| panic!("{lit}: {e}"));
            assert_eq!(back, hash);
            // 生の改行が混ざるとリテラルが途中で切れる。
            assert!(!lit.contains('\n') && !lit.contains('\r'), "{lit}");
            // 行区切りの符号位置は ES2019 より前の流儀では行末として扱われるので、逃がしておく。
            assert!(
                !lit.contains('\u{2028}') && !lit.contains('\u{2029}'),
                "{lit}"
            );
        }
    }

    // 同じハッシュを二度開いたときに UI が反応しなくなるのを防ぐ。
    // ブラウザは `location.hash` に今と同じ値を代入しても `hashchange` を発火しないので、
    // 同じときは自分で `hashchange` を投げ、違うときだけ代入する形にしてある。
    // 生成物は固定の一文なので、部分文字列ではなく出力の全体を照合する。
    // 部分文字列だけを見る形では、二つの枝を入れ替えた完全な裏返しでも通ってしまう。
    #[test]
    fn hash_to_js_is_exactly_the_expected_program() {
        let expected = concat!(
            "(function(){",
            "var h=\"#/session/abc\";",
            "if(location.hash===h){",
            "window.dispatchEvent(new HashChangeEvent(\"hashchange\",",
            "{oldURL:location.href,newURL:location.href}));",
            "}else{",
            "location.hash=h;",
            "}})();",
        );
        assert_eq!(hash_to_js("#/session/abc"), expected);
    }

    // 生成した JS は一行で、末尾に余計なものが残らない。
    #[test]
    fn hash_to_js_is_a_single_statement() {
        let js = hash_to_js("#/sessions?q=a+b");
        assert!(!js.contains('\n'), "{js}");
        assert!(js.ends_with("})();"), "{js}");
    }
}
