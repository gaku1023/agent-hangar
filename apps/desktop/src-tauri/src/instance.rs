//! 二つ目の起動を、動いている最初の殻へまとめる。
//! Windows と Linux では、スタートメニューやディープリンクからもう一度起こすと、別の殻が立ち上がって窓が 2 つになった。
//! tauri-plugin-single-instance が二つ目の起動を降ろし、渡された引数を最初の側（lib.rs の `second_launch`）へ渡す。
//! macOS は OS が .app を 1 つにまとめるので、プラグインを入れない（Cargo.toml）。
//! ここには、渡された引数をログの 1 行にまとめる純関数だけを置く。

/// Windows のトーストの COM の口が、閉じたアプリを起こすときに付ける印（notify.rs の `server_command`）。
pub const TOAST_FLAG: &str = "-ToastActivated";

/// 二つ目の起動に渡された引数を、ログに残す 1 行にする。
/// 先頭は実行ファイルなので数えない。
/// URL はそのまま書かない（検索語が入ることがある）。数と種類だけを書く。
/// ディープリンクの中身は deep-link のプラグインが最初の側の `on_open_url` へ回し、そこでログに残る。
pub fn describe(args: &[String]) -> String {
    let rest = args.iter().skip(1);
    let mut links = 0;
    let mut toast = false;
    let mut other = 0;
    for a in rest {
        if a.to_ascii_lowercase().starts_with("hangar:") {
            links += 1;
        } else if a == TOAST_FLAG {
            toast = true;
        } else {
            other += 1;
        }
    }
    let mut parts = Vec::new();
    if links > 0 {
        parts.push(format!("deep links {links}"));
    }
    if toast {
        parts.push("toast".to_string());
    }
    if other > 0 {
        parts.push(format!("other args {other}"));
    }
    if parts.is_empty() {
        "second launch handed over".to_string()
    } else {
        format!("second launch handed over ({})", parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_plain_second_launch_says_only_that_it_was_handed_over() {
        assert_eq!(
            describe(&args(&["Hangar.exe"])),
            "second launch handed over"
        );
        assert_eq!(describe(&[]), "second launch handed over");
    }

    // 検索語の入った URL をログへ書かない。数だけを書く。
    #[test]
    fn deep_links_are_counted_without_writing_the_url() {
        let line = describe(&args(&["Hangar.exe", "hangar://search?q=secret"]));
        assert_eq!(line, "second launch handed over (deep links 1)");
        assert!(!line.contains("secret"));
    }

    #[test]
    fn the_toast_flag_and_other_arguments_are_named_apart() {
        assert_eq!(
            describe(&args(&["Hangar.exe", TOAST_FLAG])),
            "second launch handed over (toast)"
        );
        assert_eq!(
            describe(&args(&["Hangar.exe", "HANGAR://session/x", "--foo", "bar"])),
            "second launch handed over (deep links 1, other args 2)"
        );
    }

    // 印の文字は notify.rs がトーストの COM の口に書く行と同じでなければならない。
    #[test]
    fn the_toast_flag_is_the_one_the_toast_registration_writes() {
        let notify = include_str!("notify.rs");
        assert!(notify.contains(&format!("\\\"{{exe}}\\\" {TOAST_FLAG}")));
    }
}
