//! ターミナルに出たリンクを既定のブラウザで開く（UI の runtime/terminalLinks.ts）。
//!
//! 頁は修飾キー付きのクリックで URL を渡してくる。殻は http と https だけを開き、file: などは開かない。
//! 頁の側でも同じ線を引いているが、殻の命令は頁からなら何でも渡せるので、ここでも断る。
//! 開き方はログを開く形（logfile.rs の `open_command_on`）とそろえ、cmd.exe の start を通さない。

use std::ffi::OsString;

/// 開いてよい URL なら整えた形を返す。http と https のほかと、読めないものは断る。
/// 整えた形（`Url::as_str`）は空白や制御文字を % で包むので、そのまま引数に渡せる。
pub fn openable(url: &str) -> Option<String> {
    let parsed = tauri::Url::parse(url).ok()?;
    match parsed.scheme() {
        "http" | "https" => Some(parsed.as_str().to_owned()),
        _ => None,
    }
}

/// URL を開くコマンド。OS を引数で決める形（試験がどちらの形も見るため）。
pub fn link_command_on(windows: bool, url: &str) -> (&'static str, Vec<OsString>) {
    if windows {
        return (
            "rundll32.exe",
            vec![
                OsString::from("url.dll,FileProtocolHandler"),
                OsString::from(url),
            ],
        );
    }
    ("/usr/bin/open", vec![OsString::from(url)])
}

/// リンクを開く。断った URL と、開けなかったときは理由を返す。
pub fn open_link(url: &str) -> Result<(), String> {
    let url = openable(url).ok_or_else(|| "http と https のほかのリンクは開きません".to_owned())?;
    let (program, args) = link_command_on(cfg!(windows), &url);
    let status = std::process::Command::new(program)
        .args(&args)
        .status()
        .map_err(|e| format!("リンクを開けません: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("リンクを開けません（{status}）"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_are_opened() {
        assert_eq!(
            openable("https://example.com/a b").as_deref(),
            Some("https://example.com/a%20b")
        );
        assert_eq!(
            openable("http://127.0.0.1:4177/x").as_deref(),
            Some("http://127.0.0.1:4177/x")
        );
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "hangar://session/1",
            "mailto:a@b.c",
            "-a Calculator",
            "",
        ] {
            assert_eq!(openable(bad), None, "{bad}");
        }
    }

    #[test]
    fn macos_uses_open_and_windows_uses_the_url_handler() {
        let (p, a) = link_command_on(false, "https://example.com/");
        assert_eq!(p, "/usr/bin/open");
        assert_eq!(a, vec![OsString::from("https://example.com/")]);
        let (p, a) = link_command_on(true, "https://example.com/");
        assert_eq!(p, "rundll32.exe");
        assert_eq!(
            a,
            vec![
                OsString::from("url.dll,FileProtocolHandler"),
                OsString::from("https://example.com/")
            ]
        );
    }
}
