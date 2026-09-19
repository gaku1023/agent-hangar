//! `hangar://` の URL を UI のハッシュ経路に変換する。
//! 変換先は shared の `formatRoute` と同じ形で、`#/session/<id>`、`#/project/<id>`、`#/sessions?q=<text>` の三形だけを受ける。
//! 三形以外と `hangar` 以外のスキームは `None` を返し、呼び出し側がログに残して無視する。

use url::Url;

/// `hangar://` の URL を UI のハッシュ経路に変換する。
/// 受けるのは `hangar://session/<id>`、`hangar://project/<id>`、`hangar://search?q=<text>` の三形だけ。
pub fn deep_link_to_hash(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "hangar" {
        return None;
    }
    let kind = url.host_str()?;
    let id = url.path().trim_matches('/');
    match kind {
        "session" | "project" => {
            if id.is_empty() || id.contains('/') {
                return None;
            }
            Some(format!("#/{kind}/{id}"))
        }
        "search" => {
            let q = url
                .query_pairs()
                .find(|(k, _)| k == "q")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
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
    // `var h=` と、その行を閉じる `;` の間がリテラルになる。
    fn literal_of(js: &str) -> &str {
        let start = js.find("var h=").expect("no assignment") + "var h=".len();
        let rest = &js[start..];
        let end = rest.find(";if(").expect("no terminator");
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
    // 同じときは自分で `hashchange` を投げる形にしてある。
    #[test]
    fn hash_to_js_dispatches_hashchange_when_the_hash_is_unchanged() {
        let js = hash_to_js("#/session/abc");
        assert!(js.contains("location.hash==="), "{js}");
        assert!(js.contains("new HashChangeEvent(\"hashchange\""), "{js}");
        assert!(js.contains("location.hash=h"), "{js}");
    }

    // 生成した JS は一行で、末尾に余計なものが残らない。
    #[test]
    fn hash_to_js_is_a_single_statement() {
        let js = hash_to_js("#/sessions?q=a+b");
        assert!(!js.contains('\n'), "{js}");
        assert!(js.ends_with("})();"), "{js}");
    }
}
