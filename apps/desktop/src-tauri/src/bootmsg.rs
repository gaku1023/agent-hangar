//! 殻が自分で書く起動の失敗の詳細（`BootFailure::detail`）の文を、頁の言語で作る。
//! 札の見出しや次にすることは頁の表（loading/boot-fail.js）が作るが、`other` の詳細は殻が書く。
//! 英語の設定でも詳細だけが日本語のまま出ていた（2026-10-11、Windows の実機の確かめで見つけた）ので、ここで日英を持つ。
//! 例外の文（`err`）や OS が返した文は記録なので、言語を替えずにそのまま埋める。
//! Node が見つからないときの文は、調べた場所を並べるので node.rs の `describe_error_in` にある。

/// 殻が書く起動の失敗の詳細。
/// パスは画面に出す形（利用者のホームを `~` に縮めたもの）で渡す。
#[derive(Debug, Clone, PartialEq)]
pub enum Msg {
    /// 起動の手続きの途中で、サーバが応答しなくなった。
    Unresponsive { secs: u64, log: String },
    /// 子を起こしてから、締め切りまでに応答が無かった。
    NoAnswerWithin { secs: u64, log: String },
    /// 入場の鍵（`token`）が読めない。
    TokenUnreadable { file: String, log: String },
    /// メインの窓が見つからない。
    NoWindow,
    /// 入口の URL を組み立てられない。
    BadUrl { err: String },
    /// サーバの画面へ移れない。
    CannotNavigate { port: u16, err: String },
    /// アプリのリソースの場所が分からない。
    NoResourceDir { err: String },
    /// 同梱のサーバが見つからない。
    NoBundledServer { dir: String },
    /// 配布版で `HANGAR_SERVER_DIR` が指された。
    ServerDirDevOnly,
    /// macOS の App Translocation で、読み取り専用の写しから起動された。
    Translocated,
    /// サーバの子を起こせない。
    CannotSpawn { err: String },
    /// 同梱の `manifest.json` が読めない。
    ManifestUnreadable { file: String, err: String },
    /// 同梱の `manifest.json` が壊れている。
    ManifestBroken { file: String, err: String },
}

impl Msg {
    /// 頁の言語（`bootfail::page_language` の ja か en）で文にする。en のほかは日本語にする（UI の既定）。
    pub fn text(&self, lang: &str) -> String {
        if lang == "en" {
            self.en()
        } else {
            self.ja()
        }
    }

    // CI の rustfmt は日本語の幅を手元と違って数えるので、文の表は整形を止めて書いたままにする。
    #[rustfmt::skip]
    fn ja(&self) -> String {
        match self {
            Msg::Unresponsive { secs, log } => {
                format!("サーバが {secs} 秒応答しません。{log} を確認してください。")
            }
            Msg::NoAnswerWithin { secs, log } => {
                format!("サーバが {secs} 秒以内に応答しませんでした。{log} を確認してください。")
            }
            Msg::TokenUnreadable { file, log } => {
                format!("入場の鍵が読めません: {file}\nサーバが鍵を作れたか {log} を確認してください。")
            }
            Msg::NoWindow => "ウィンドウが見つからないので、サーバの画面へ移れません。".to_string(),
            Msg::BadUrl { err } => format!("URL を組み立てられません: {err}"),
            Msg::CannotNavigate { port, err } => {
                format!("サーバの画面（ポート {port}）へ移れません: {err}")
            }
            Msg::NoResourceDir { err } => format!("リソースの場所が分かりません: {err}"),
            Msg::NoBundledServer { dir } => format!("同梱のサーバが見つかりません: {dir}"),
            Msg::ServerDirDevOnly => concat!(
                "HANGAR_SERVER_DIR は開発のときだけ効きます。\n",
                "配布版はアプリの中に同梱したサーバだけを使います。"
            )
            .to_string(),
            Msg::Translocated => concat!(
                "この .app は読み取り専用の写しから起動されています（macOS の App Translocation）。\n",
                "Hangar.app を /Applications へ移してから開き直してください。\n",
                "移さずに使うときは、ダウンロードした Hangar.app に対して次を実行してください。\n",
                "xattr -rd com.apple.quarantine /path/to/Hangar.app"
            )
            .to_string(),
            Msg::CannotSpawn { err } => format!("サーバを起動できません: {err}"),
            Msg::ManifestUnreadable { file, err } => format!("{file} を読めません: {err}"),
            Msg::ManifestBroken { file, err } => format!("{file} が壊れています: {err}"),
        }
    }

    #[rustfmt::skip]
    fn en(&self) -> String {
        match self {
            Msg::Unresponsive { secs, log } => {
                format!("The server has not responded for {secs} seconds. Check {log}.")
            }
            Msg::NoAnswerWithin { secs, log } => {
                format!("The server did not respond within {secs} seconds. Check {log}.")
            }
            Msg::TokenUnreadable { file, log } => format!(
                "Cannot read the access token: {file}\nCheck {log} to see whether the server created it."
            ),
            Msg::NoWindow => "The window is missing, so the server page cannot be opened.".to_string(),
            Msg::BadUrl { err } => format!("Cannot build the URL: {err}"),
            Msg::CannotNavigate { port, err } => {
                format!("Cannot open the server page (port {port}): {err}")
            }
            Msg::NoResourceDir { err } => format!("Cannot find the app's resource folder: {err}"),
            Msg::NoBundledServer { dir } => format!("The bundled server is missing: {dir}"),
            Msg::ServerDirDevOnly => concat!(
                "HANGAR_SERVER_DIR works only in development.\n",
                "Release builds use only the server bundled inside the app."
            )
            .to_string(),
            Msg::Translocated => concat!(
                "This .app is running from a read-only copy (macOS App Translocation).\n",
                "Move Hangar.app to /Applications and open it again.\n",
                "To use it without moving it, run this on the downloaded Hangar.app:\n",
                "xattr -rd com.apple.quarantine /path/to/Hangar.app"
            )
            .to_string(),
            Msg::CannotSpawn { err } => format!("Cannot start the server: {err}"),
            Msg::ManifestUnreadable { file, err } => format!("Cannot read {file}: {err}"),
            Msg::ManifestBroken { file, err } => format!("{file} is broken: {err}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_japanese(s: &str) -> bool {
        s.chars()
            .any(|c| matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}' | '\u{ff08}' | '\u{ff09}'))
    }

    fn all() -> Vec<Msg> {
        let log = r"~\.agent-hangar\desktop.log".to_string();
        vec![
            Msg::Unresponsive {
                secs: 30,
                log: log.clone(),
            },
            Msg::NoAnswerWithin {
                secs: 20,
                log: log.clone(),
            },
            Msg::TokenUnreadable {
                file: r"~\.agent-hangar\token".into(),
                log,
            },
            Msg::NoWindow,
            Msg::BadUrl { err: "e".into() },
            Msg::CannotNavigate {
                port: 4177,
                err: "e".into(),
            },
            Msg::NoResourceDir { err: "e".into() },
            Msg::NoBundledServer {
                dir: r"C:\Program Files\Hangar".into(),
            },
            Msg::ServerDirDevOnly,
            Msg::Translocated,
            Msg::CannotSpawn { err: "e".into() },
            Msg::ManifestUnreadable {
                file: "manifest.json".into(),
                err: "e".into(),
            },
            Msg::ManifestBroken {
                file: "manifest.json".into(),
                err: "e".into(),
            },
        ]
    }

    // 英語の設定で、殻の詳細に日本語が混ざらない。
    #[test]
    fn every_detail_has_an_english_text_without_japanese() {
        for m in all() {
            let en = m.text("en");
            assert!(!en.is_empty(), "{m:?}");
            assert!(!has_japanese(&en), "{m:?}: {en}");
        }
    }

    #[test]
    fn every_detail_has_a_japanese_text() {
        for m in all() {
            assert!(has_japanese(&m.text("ja")), "{m:?}");
        }
    }

    // 頁の言語は ja か en だけが来るが、知らない値は UI の既定の日本語にする。
    #[test]
    fn an_unknown_language_falls_back_to_japanese() {
        assert_eq!(Msg::NoWindow.text("fr"), Msg::NoWindow.text("ja"));
    }

    // パスと数と例外の文は、どちらの言語でもそのまま入る。
    #[test]
    fn the_numbers_paths_and_raw_errors_are_kept_in_both_languages() {
        for lang in ["ja", "en"] {
            let t = Msg::Unresponsive {
                secs: 30,
                log: r"~\.agent-hangar\desktop.log".into(),
            }
            .text(lang);
            assert!(t.contains("30"), "{t}");
            assert!(t.contains(r"~\.agent-hangar\desktop.log"), "{t}");
            let t = Msg::CannotSpawn {
                err: "os error 2".into(),
            }
            .text(lang);
            assert!(t.contains("os error 2"), "{t}");
        }
    }
}
