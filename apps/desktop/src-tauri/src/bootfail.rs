//! 起動の失敗を、頁に出す札の種類と数に直す。
//! サーバが書いた `boot-error.json`（packages/server/src/boot/bootError.ts）を読み、殻が自分で決める失敗
//! （互換の版が合わない別のサーバ、殻のそれ以外の失敗）と合わせて、6 種類のどれかにする。
//! 殻は札の文を書かない。札の文は読み込みの頁の表（loading/boot-fail.js）が種類と数から作る。
//! 殻が書くのは詳細（`detail`）だけで、殻が自分で書く詳細は頁の言語で作る（bootmsg.rs）。

use serde_json::{Map, Value};
use std::path::Path;
use std::time::SystemTime;

/// 札を出せる失敗の種類。loading/boot-fail.js の FAIL_KINDS と同じ並びにする（config.test.ts が突き合わせる）。
pub const KINDS: &[&str] = &[
    "server-exited",
    "port-in-use",
    "db-too-old",
    "db-backup-failed",
    "compat-mismatch",
    "other",
];

/// サーバが `boot-error.json` に書いてよい種類。互換の別のサーバと殻のそれ以外は、サーバが起きる前に殻が決めるので入れない。
const SERVER_KINDS: &[&str] = &[
    "server-exited",
    "port-in-use",
    "db-too-old",
    "db-backup-failed",
];

/// サーバが起動の失敗を書くファイルの名前（`<HANGAR_HOME>/` の直下）。
pub const BOOT_ERROR_FILE: &str = "boot-error.json";

/// 起動の失敗。種類、数やパス、記録（詳細）だけを持つ。
#[derive(Debug, Clone, PartialEq)]
pub struct BootFailure {
    pub kind: &'static str,
    pub params: Map<String, Value>,
    pub detail: String,
}

impl From<String> for BootFailure {
    fn from(detail: String) -> Self {
        BootFailure::other(detail)
    }
}

/// 頁に渡す文字の params の長さの上限（文字数）。
const PARAM_MAX: usize = 512;
/// 頁に渡す詳細の長さの上限（バイト）。例外の文やログの終わりは長いことがあるので、画面へ渡す前に切る。
const DETAIL_MAX: usize = 8 * 1024;
/// params に入れる項目の数の上限。
const PARAMS_MAX: usize = 16;

impl BootFailure {
    fn new(kind: &'static str, params: Map<String, Value>, detail: String) -> Self {
        BootFailure {
            kind,
            params,
            detail: cut_bytes(&detail, DETAIL_MAX),
        }
    }

    /// 殻のそれ以外の失敗（App Translocation、Node が見つからない、頁を移せない、応答が途切れた、など）。
    pub fn other(detail: impl Into<String>) -> Self {
        Self::new("other", Map::new(), detail.into())
    }

    /// サーバが起きない。`boot-error.json` が読めないときの落ち先でもある。
    pub fn server_exited(detail: impl Into<String>) -> Self {
        Self::new("server-exited", Map::new(), detail.into())
    }

    /// 4177 で、互換の版が合わない hangar のサーバが動いている。そのサーバは止めない。
    pub fn compat_mismatch(port: u16, theirs: u64, ours: u64) -> Self {
        let mut params = Map::new();
        params.insert("port".into(), port.into());
        params.insert("theirs".into(), theirs.into());
        params.insert("ours".into(), ours.into());
        Self::new(
            "compat-mismatch",
            params,
            format!("refusing the server on {port} (compat {theirs}, ours {ours})"),
        )
    }

    /// 詳細と文字の params に、同じ変換をかける。入場の鍵を伏せるのに使う。
    pub fn map_text(mut self, f: impl Fn(&str) -> String) -> Self {
        self.detail = f(&self.detail);
        for v in self.params.values_mut() {
            if let Value::String(s) = v {
                *s = f(s);
            }
        }
        self
    }
}

/// 長さをバイトで切る。多バイト文字の途中では切らず、切ったら末尾に「…」を付ける（付けた分も上限に収める）。
fn cut_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max.saturating_sub('…'.len_utf8());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// `boot-error.json` の中身を読む。読めなければ None。
/// 種類はサーバが書いてよい 4 つだけを採り、ほかは「サーバが起きない」に落とす。
pub fn parse_boot_error(text: &str) -> Option<BootFailure> {
    let v: Value = serde_json::from_str(text).ok()?;
    let o = v.as_object()?;
    let kind = o.get("kind")?.as_str()?;
    let detail = o
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let Some(kind) = SERVER_KINDS.iter().find(|k| **k == kind) else {
        return Some(BootFailure::server_exited(detail));
    };
    let mut params = Map::new();
    if let Some(p) = o.get("params").and_then(Value::as_object) {
        for (k, v) in p.iter().take(PARAMS_MAX) {
            match v {
                Value::String(s) => {
                    params.insert(
                        k.clone(),
                        Value::String(s.chars().take(PARAM_MAX).collect()),
                    );
                }
                Value::Number(_) => {
                    params.insert(k.clone(), v.clone());
                }
                _ => {}
            }
        }
    }
    Some(BootFailure::new(kind, params, detail))
}

/// 更新の時刻が、子を起こした時刻以後か。それより古いファイルは前の起動のものなので捨てる。
pub fn is_fresh(modified: SystemTime, child_started: SystemTime) -> bool {
    modified >= child_started
}

/// 置き場の `boot-error.json` を、今の子の失敗として読む。無い、読めない、子の起動より古い、のどれかなら None。
pub fn read_boot_error(home: &Path, child_started: SystemTime) -> Option<BootFailure> {
    let file = home.join(BOOT_ERROR_FILE);
    let modified = std::fs::metadata(&file).and_then(|m| m.modified()).ok()?;
    if !is_fresh(modified, child_started) {
        return None;
    }
    parse_boot_error(&std::fs::read_to_string(&file).ok()?)
}

/// 子が死んだときの失敗。`boot-error.json` が使えればその種類、使えなければ「サーバが起きない」にする。
/// 詳細が空のときは、ログの終わりの数行（`log_tail`）を詳細にする。
pub fn for_dead_server(
    home: &Path,
    child_started: Option<SystemTime>,
    log_tail: impl FnOnce() -> String,
) -> BootFailure {
    match child_started.and_then(|t| read_boot_error(home, t)) {
        Some(mut f) => {
            if f.detail.is_empty() {
                f.detail = cut_bytes(&log_tail(), DETAIL_MAX);
            }
            f
        }
        None => BootFailure::server_exited(log_tail()),
    }
}

/// ログの終わりの `max_lines` 行。ファイルが無ければ空。大きなファイルは終わりだけを読む。
pub fn log_tail(file: &Path, max_lines: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};
    // 終わりの数行に要る長さより十分大きく取る。1 行が長いログでも、DETAIL_MAX に収まる分は読める。
    const WINDOW: u64 = 64 * 1024;
    let Ok(mut f) = std::fs::File::open(file) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(WINDOW);
    let mut bytes = Vec::new();
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    // 途中から読んだときの最初の行は半端なので捨てる。
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let from = lines.len().saturating_sub(max_lines);
    lines[from..].join("\n")
}

/// 利用者のホームで始まるパスを `~` に縮める。画面と命令に、ユーザー名の入ったパスを出さないためである。
/// 区切りは `/` と、Windows の `\` の両方を読み、縮めた後もパスの区切りのまま残す（`~\.agent-hangar`）。
pub fn tilde(path: &str, home: &Path) -> String {
    let home = home.to_string_lossy();
    let home = home.trim_end_matches(['/', '\\']);
    if home.is_empty() {
        return path.to_string();
    }
    match path.strip_prefix(home) {
        Some("") => "~".to_string(),
        Some(rest) if rest.starts_with(['/', '\\']) => format!("~{rest}"),
        _ => path.to_string(),
    }
}

/// パスに使われる文字か。ホームの前後がこれなら、もっと長いパスの一部なので縮めない。
fn is_path_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '\\' | '~')
}

/// 文の中でホームから始まるパスを、すべて `~` に縮める。
/// Node の「調べた場所」、設定ファイルの場所、サーバが書く `params` の `file` と `dir`、例外の文に、ユーザー名を出さないためである。
/// ホームの前がパスの文字でなく、後ろが区切り（`/` か `\\`）か、パスの文字でないときだけ縮める。
/// `/Users/ab` や `/mnt/Users/a` のような、別の人のホームや途中の一致は縮めない。
pub fn shorten_home(text: &str, home: &Path) -> String {
    let home = home.to_string_lossy();
    let home = home.trim_end_matches(['/', '\\']);
    if home.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(home) {
        let before = rest[..i].chars().next_back();
        let after = rest[i + home.len()..].chars().next();
        let starts = before.map_or(true, |c| !is_path_char(c));
        let ends = after.map_or(true, |c| matches!(c, '/' | '\\') || !is_path_char(c));
        out.push_str(&rest[..i]);
        out.push_str(if starts && ends { "~" } else { home });
        rest = &rest[i + home.len()..];
    }
    out.push_str(rest);
    out
}

/// 頁に渡す、失敗のほかの材料。
#[derive(Debug, Clone, PartialEq)]
pub struct Env {
    pub lang: &'static str,
    pub version: String,
    pub os: String,
    pub home: String,
    /// パスの区切り（`std::path::MAIN_SEPARATOR_STR`）。頁は置き場の名前とファイルの名前をこれでつなぐ。
    pub sep: &'static str,
}

/// 頁に渡す JSON。種類、数、詳細、言語、版、OS、置き場の名前、パスの区切り。
pub fn payload(f: &BootFailure, env: &Env) -> String {
    payload_value(f, env).to_string()
}

/// 同上。起動画面が問い合わせたとき（lib.rs の `boot_state`）に、そのまま返せる形。
pub fn payload_value(f: &BootFailure, env: &Env) -> Value {
    serde_json::json!({
        "kind": f.kind,
        "params": f.params,
        "detail": f.detail,
        "lang": env.lang,
        "version": env.version,
        "os": env.os,
        "home": env.home,
        "sep": env.sep,
    })
}

/// 頁の失敗の口（__hangarBootFail）を呼ぶ式。決まった式に JSON だけを埋める。
/// 口の名前は loading/boot.js と同じにする（config.test.ts が突き合わせる）。
pub fn fail_js(f: &BootFailure, env: &Env) -> String {
    format!(
        "window.__hangarBootFail && window.__hangarBootFail({})",
        payload(f, env)
    )
}

/// 設定ファイル（settings.json）の `language`。ja か en のときだけ返す。
pub fn language_from_settings(text: &str) -> Option<&'static str> {
    let v: Value = serde_json::from_str(text).ok()?;
    match v.get("language")?.as_str()? {
        "ja" => Some("ja"),
        "en" => Some("en"),
        _ => None,
    }
}

/// 言語の名前（`ja-JP`、`ja_JP.UTF-8` など）を ja か en に寄せる。日本語以外は英語にする（画面の辞書は 2 つだけである）。
fn language_of_tag(tag: &str) -> &'static str {
    if tag.to_ascii_lowercase().starts_with("ja") {
        "ja"
    } else {
        "en"
    }
}

/// macOS の `defaults read -g AppleLanguages` の出力から、先頭の言語を ja か en に寄せる。
pub fn language_from_apple_languages(out: &str) -> Option<&'static str> {
    let first = out
        .split(|c: char| matches!(c, '(' | ')' | ',' | '"') || c.is_whitespace())
        .find(|t| !t.is_empty())?;
    Some(language_of_tag(first))
}

/// `LC_ALL`、`LC_MESSAGES`、`LANG` の値（`ja_JP.UTF-8` など）から言語を決める。
pub fn language_from_locale(v: &str) -> Option<&'static str> {
    let v = v.trim();
    if v.is_empty() || v == "C" || v == "POSIX" {
        return None;
    }
    Some(language_of_tag(v))
}

/// 頁の言語を決める。設定ファイルを読めればその `language`、読めなければ OS の言語、それも無ければ日本語（UI の既定）。
/// 設定ファイルに `language` が無い（利用者がまだ選んでいない）ときも、OS の言語に従う。
pub fn choose_language(settings: Option<&str>, os: Option<&'static str>) -> &'static str {
    settings
        .and_then(language_from_settings)
        .or(os)
        .unwrap_or("ja")
}

/// Windows の表示言語の並び（NUL で区切った名前、`ja-JP\0en-US\0\0`）から、先頭の言語を ja か en に寄せる。
pub fn language_from_ui_languages(names: &str) -> Option<&'static str> {
    let first = names.split('\0').find(|t| !t.is_empty())?;
    Some(language_of_tag(first))
}

/// Windows の表示言語の並び。利用者が設定で選んだ順に、名前を NUL で区切って返す。
#[cfg(windows)]
fn windows_ui_languages() -> Option<String> {
    use windows_sys::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let mut count = 0u32;
    let mut len = 0u32;
    // 1 回目で長さを訊き、2 回目で読む。
    let ok = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            std::ptr::null_mut(),
            &mut len,
        )
    };
    if ok == 0 || len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    let ok = unsafe {
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, buf.as_mut_ptr(), &mut len)
    };
    (ok != 0).then(|| String::from_utf16_lossy(&buf))
}

/// OS の言語。macOS は `defaults read -g AppleLanguages`（.app は LANG を持たない）、
/// Windows は表示言語の並び（GUI のアプリも LANG を持たない）、ほかは環境変数。
fn os_language() -> Option<&'static str> {
    #[cfg(windows)]
    if let Some(l) = windows_ui_languages()
        .as_deref()
        .and_then(language_from_ui_languages)
    {
        return Some(l);
    }
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
            .ok()?;
        return language_from_apple_languages(&String::from_utf8_lossy(&out.stdout));
    }
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find_map(|v| language_from_locale(&v))
}

/// 置き場の設定ファイルと OS から、頁の言語を決める。
pub fn page_language(home: &Path) -> &'static str {
    let settings = std::fs::read_to_string(home.join("settings.json")).ok();
    // 設定ファイルの言語が決まれば、OS には聞かない（失敗の最中に外のコマンドを呼ばない）。
    if let Some(l) = settings.as_deref().and_then(language_from_settings) {
        return l;
    }
    choose_language(settings.as_deref(), os_language())
}

/// OS の名前と版の文。
pub fn os_label_from(name: &str, version: Option<&str>) -> String {
    match version.map(str::trim) {
        Some(v) if !v.is_empty() => format!("{name} {v}"),
        _ => name.to_string(),
    }
}

/// `/etc/os-release` の `PRETTY_NAME`。
pub fn pretty_name(os_release: &str) -> Option<String> {
    os_release
        .lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim().trim_matches('"').to_string())
        .filter(|v| !v.is_empty())
}

/// Windows の名前と版（「Windows 11 24H2 (build 26100)」など）。
/// 登録簿の製品名（ProductName）は Windows 11 でも「Windows 10」のままなので使わず、ビルド番号で 11 か 10 かを決める。
/// ビルド番号が読めなければ、版を付けずに「Windows」とだけ言う。
pub fn windows_label(build: Option<&str>, display: Option<&str>) -> String {
    let Some(n) = build.and_then(|b| b.trim().parse::<u32>().ok()) else {
        return "Windows".to_string();
    };
    let name = if n >= 22000 {
        "Windows 11"
    } else {
        "Windows 10"
    };
    let version = match display.map(str::trim) {
        Some(d) if !d.is_empty() => format!("{d} (build {n})"),
        _ => format!("(build {n})"),
    };
    os_label_from(name, Some(&version))
}

/// `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` の文字列の値。
#[cfg(windows)]
fn windows_current_version(name: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let wide = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let key = wide("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
    let value = wide(name);
    let mut buf = vec![0u16; 256];
    let mut size = (buf.len() * 2) as u32;
    let r = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut core::ffi::c_void,
            &mut size,
        )
    };
    if r != ERROR_SUCCESS {
        return None;
    }
    let chars = (size as usize / 2).min(buf.len());
    Some(
        String::from_utf16_lossy(&buf[..chars])
            .trim_end_matches('\0')
            .to_string(),
    )
}

/// 今の OS の名前と版（「macOS 15.1」など）。失敗の札の下端に出す。
pub fn os_label() -> String {
    if cfg!(target_os = "macos") {
        let version = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
        return os_label_from("macOS", version.as_deref());
    }
    if cfg!(target_os = "linux") {
        return std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|t| pretty_name(&t))
            .unwrap_or_else(|| "Linux".to_string());
    }
    #[cfg(windows)]
    {
        windows_label(
            windows_current_version("CurrentBuildNumber").as_deref(),
            windows_current_version("DisplayVersion").as_deref(),
        )
    }
    #[cfg(not(windows))]
    std::env::consts::OS.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }
    fn write(dir: &Path, text: &str) -> std::path::PathBuf {
        let p = dir.join(BOOT_ERROR_FILE);
        std::fs::write(&p, text).unwrap();
        p
    }
    fn set_mtime(p: &Path, t: SystemTime) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(p)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }
    const GOOD: &str = r#"{"kind":"port-in-use","params":{"port":4177,"host":"127.0.0.1"},"detail":"listen EADDRINUSE"}"#;

    #[test]
    fn the_six_kinds_are_the_four_the_server_writes_plus_the_two_the_shell_decides() {
        assert_eq!(KINDS.len(), 6);
        for k in SERVER_KINDS {
            assert!(KINDS.contains(k));
        }
        assert!(KINDS.contains(&"compat-mismatch") && KINDS.contains(&"other"));
    }

    #[test]
    fn a_server_written_failure_is_read_with_its_kind_params_and_detail() {
        let f = parse_boot_error(GOOD).unwrap();
        assert_eq!(f.kind, "port-in-use");
        assert_eq!(
            f.params,
            obj(serde_json::json!({"port": 4177, "host": "127.0.0.1"}))
        );
        assert_eq!(f.detail, "listen EADDRINUSE");
    }

    #[test]
    fn each_kind_the_server_writes_is_taken_as_it_is() {
        for k in SERVER_KINDS {
            let f = parse_boot_error(&format!(r#"{{"kind":"{k}","params":{{}},"detail":"d"}}"#))
                .unwrap();
            assert_eq!(f.kind, *k);
        }
    }

    // サーバは、互換の別のサーバと殻のそれ以外の失敗を決めない。ファイルがそう名乗っても、殻は採らない。
    #[test]
    fn a_kind_only_the_shell_may_decide_or_an_unknown_kind_falls_to_server_exited() {
        for k in ["compat-mismatch", "other", "weird", ""] {
            let f = parse_boot_error(&format!(
                r#"{{"kind":"{k}","params":{{"port":1}},"detail":"d"}}"#
            ))
            .unwrap();
            assert_eq!(f.kind, "server-exited", "{k}");
            assert_eq!(f.detail, "d");
            assert!(f.params.is_empty());
        }
    }

    #[test]
    fn a_file_that_is_not_a_failure_is_not_read() {
        for text in [
            "",
            "not json",
            "[]",
            "null",
            r#"{"params":{},"detail":"d"}"#,
            r#"{"kind":7}"#,
        ] {
            assert_eq!(parse_boot_error(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_missing_detail_or_params_is_empty() {
        let f = parse_boot_error(r#"{"kind":"db-too-old"}"#).unwrap();
        assert_eq!(
            (f.kind, f.detail.as_str(), f.params.is_empty()),
            ("db-too-old", "", true)
        );
    }

    // 頁へは文字と数だけを渡す。入れ子や真偽値は捨て、長い文字は切る。
    #[test]
    fn params_keep_only_strings_and_numbers_and_long_ones_are_cut() {
        let long = "x".repeat(2000);
        let text = format!(
            r#"{{"kind":"db-too-old","params":{{"a":"s","b":3,"c":true,"d":null,"e":{{"x":1}},"f":[1],"g":"{long}"}},"detail":"d"}}"#
        );
        let f = parse_boot_error(&text).unwrap();
        assert_eq!(
            f.params.keys().cloned().collect::<Vec<_>>(),
            ["a", "b", "g"]
        );
        assert_eq!(f.params["g"].as_str().unwrap().chars().count(), 512);
    }

    #[test]
    fn a_long_detail_is_cut_on_a_character_boundary() {
        let detail = "あ".repeat(5000);
        let f = parse_boot_error(&format!(
            r#"{{"kind":"server-exited","params":{{}},"detail":"{detail}"}}"#
        ))
        .unwrap();
        assert!(f.detail.len() <= 8 * 1024);
        assert!(f.detail.chars().all(|c| c == 'あ' || c == '…'));
        assert!(f.detail.ends_with('…'));
        let short = parse_boot_error(GOOD).unwrap();
        assert_eq!(short.detail, "listen EADDRINUSE");
    }

    #[test]
    fn a_file_older_than_the_child_is_stale() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(is_fresh(t, t));
        assert!(is_fresh(t + Duration::from_secs(1), t));
        assert!(!is_fresh(t - Duration::from_millis(1), t));
    }

    #[test]
    fn the_file_is_read_only_when_it_is_newer_than_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let started = SystemTime::now();
        assert_eq!(read_boot_error(dir.path(), started), None, "no file");
        let p = write(dir.path(), GOOD);
        set_mtime(&p, started + Duration::from_secs(2));
        assert_eq!(
            read_boot_error(dir.path(), started).unwrap().kind,
            "port-in-use"
        );
        set_mtime(&p, started - Duration::from_secs(2));
        assert_eq!(read_boot_error(dir.path(), started), None, "stale");
        write(dir.path(), "garbage");
        set_mtime(&p, started + Duration::from_secs(2));
        assert_eq!(read_boot_error(dir.path(), started), None, "unreadable");
    }

    #[test]
    fn a_dead_server_with_a_fresh_file_takes_its_kind() {
        let dir = tempfile::tempdir().unwrap();
        let started = SystemTime::now() - Duration::from_secs(5);
        write(dir.path(), GOOD);
        let f = for_dead_server(dir.path(), Some(started), || {
            unreachable!("the file has a detail")
        });
        assert_eq!(
            (f.kind, f.detail.as_str()),
            ("port-in-use", "listen EADDRINUSE")
        );
    }

    #[test]
    fn a_file_without_a_detail_borrows_the_end_of_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let started = SystemTime::now() - Duration::from_secs(5);
        write(
            dir.path(),
            r#"{"kind":"db-too-old","params":{"found":3},"detail":""}"#,
        );
        let f = for_dead_server(dir.path(), Some(started), || "log line".to_string());
        assert_eq!((f.kind, f.detail.as_str()), ("db-too-old", "log line"));
        assert_eq!(f.params["found"], 3);
    }

    // 古いファイルは前の起動のもの。今の子の死に使うと、無関係な理由を見せる。
    #[test]
    fn a_dead_server_without_a_usable_file_is_server_exited_with_the_log_tail() {
        let dir = tempfile::tempdir().unwrap();
        let started = SystemTime::now();
        let p = write(dir.path(), GOOD);
        set_mtime(&p, started - Duration::from_secs(60));
        for s in [Some(started), None] {
            let f = for_dead_server(dir.path(), s, || "tail".to_string());
            assert_eq!(
                (f.kind, f.detail.as_str(), f.params.is_empty()),
                ("server-exited", "tail", true)
            );
        }
        let none = tempfile::tempdir().unwrap();
        assert_eq!(
            for_dead_server(none.path(), Some(started), || "t".into()).kind,
            "server-exited"
        );
    }

    #[test]
    fn the_log_tail_is_the_last_lines_and_empty_without_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("desktop.log");
        assert_eq!(log_tail(&p, 3), "");
        std::fs::write(&p, "a\nb\nc\nd\ne\n").unwrap();
        assert_eq!(log_tail(&p, 3), "c\nd\ne");
        assert_eq!(log_tail(&p, 99), "a\nb\nc\nd\ne");
        std::fs::write(&p, "").unwrap();
        assert_eq!(log_tail(&p, 3), "");
    }

    // 大きなログは終わりだけを読む。読み始めの半端な行は捨てる。
    #[test]
    fn a_big_log_is_read_from_the_end_and_the_cut_first_line_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("desktop.log");
        let body: String = (0..20000).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&p, &body).unwrap();
        assert_eq!(log_tail(&p, 2), "line 19998\nline 19999");
        let wide = (0..9000)
            .map(|_| "あ".repeat(10) + "\n")
            .collect::<String>();
        std::fs::write(&p, &wide).unwrap();
        assert!(log_tail(&p, 5000).lines().all(|l| l == "あ".repeat(10)));
    }

    #[test]
    fn a_path_under_the_home_is_shortened_to_a_tilde_only_at_a_boundary() {
        let home = Path::new("/Users/a");
        assert_eq!(tilde("/Users/a/.agent-hangar/x", home), "~/.agent-hangar/x");
        assert_eq!(tilde("/Users/a", home), "~");
        assert_eq!(tilde("/Users/ab/x", home), "/Users/ab/x");
        assert_eq!(tilde("/elsewhere/x", home), "/elsewhere/x");
        assert_eq!(tilde("relative", home), "relative");
        assert_eq!(tilde("/Users/a/x", Path::new("/")), "/Users/a/x");
    }

    // Windows のホームは \ で区切る。縮めた後も区切りを混ぜない（`\.agent-hangar/desktop.log` と出ていた）。
    #[test]
    fn a_windows_path_under_the_home_is_shortened_with_its_own_separator() {
        let home = Path::new(r"C:\Users\a");
        assert_eq!(tilde(r"C:\Users\a\.agent-hangar", home), r"~\.agent-hangar");
        assert_eq!(tilde(r"C:\Users\a", home), "~");
        assert_eq!(tilde(r"C:\Users\ab\x", home), r"C:\Users\ab\x");
        assert_eq!(tilde(r"C:\Users\a\x", Path::new(r"C:\Users\a\")), r"~\x");
    }

    // 詳細の中のパス（Node の「調べた場所」や設定ファイル、サーバの例外の文）も、ホームを ~ に縮めてユーザー名を出さない。
    #[test]
    fn the_home_is_shortened_wherever_it_starts_a_path_in_the_text() {
        let home = Path::new("/Users/a");
        let text = "Node 22 (arm64) was not found.\nRun nvm install 22, or set nodePath in /Users/a/.agent-hangar/settings.json to its location.\nPlaces checked:\n  /opt/homebrew/bin/node: not found\n  /Users/a/.nvm/versions/node/v24.1.0/bin/node: v24 arm64 (needs 22 arm64)";
        let got = shorten_home(text, home);
        assert!(got.contains("in ~/.agent-hangar/settings.json to"), "{got}");
        assert!(
            got.contains("  ~/.nvm/versions/node/v24.1.0/bin/node: v24"),
            "{got}"
        );
        assert!(got.contains("/opt/homebrew/bin/node"), "{got}");
        assert!(!got.contains("/Users/a"), "{got}");
        assert_eq!(shorten_home("open '/Users/a/x.db'", home), "open '~/x.db'");
        assert_eq!(shorten_home("/Users/a", home), "~");
    }

    #[test]
    fn the_home_is_shortened_in_windows_text_with_its_own_separator() {
        let home = Path::new(r"C:\Users\a");
        let text = r"  C:\Users\a\AppData\Local\Programs\nodejs\node.exe: not found
  C:\Program Files\nodejs\node.exe: not found";
        let got = shorten_home(text, home);
        assert!(
            got.starts_with(r"  ~\AppData\Local\Programs\nodejs\node.exe"),
            "{got}"
        );
        assert!(got.contains(r"C:\Program Files\nodejs\node.exe"), "{got}");
    }

    // 別の人のホーム（/Users/ab）や、途中に同じ並びがあるだけのパスは縮めない。
    #[test]
    fn only_the_home_itself_is_shortened_not_a_longer_name_or_a_deeper_match() {
        let home = Path::new("/Users/a");
        assert_eq!(shorten_home("/Users/ab/x", home), "/Users/ab/x");
        assert_eq!(shorten_home("/mnt/Users/a/x", home), "/mnt/Users/a/x");
        assert_eq!(shorten_home("/Users/a.bak/x", home), "/Users/a.bak/x");
        // ホームが読めず / に落ちたときは何も縮めない。
        assert_eq!(shorten_home("/Users/a/x", Path::new("/")), "/Users/a/x");
    }

    // サーバが書く params の file と dir も同じく縮める（macOS でも縮めていなかった）。
    #[test]
    fn the_paths_the_server_writes_into_params_are_shortened_too() {
        let f = parse_boot_error(r#"{"kind":"db-backup-failed","params":{"file":"/Users/a/.agent-hangar/backups/db/hangar-1.db","dir":"/Users/a/.agent-hangar/backups/db"},"detail":"copy /Users/a/.agent-hangar/hangar.db failed"}"#)
            .unwrap()
            .map_text(|s| shorten_home(s, Path::new("/Users/a")));
        assert_eq!(f.params["file"], "~/.agent-hangar/backups/db/hangar-1.db");
        assert_eq!(f.params["dir"], "~/.agent-hangar/backups/db");
        assert_eq!(f.detail, "copy ~/.agent-hangar/hangar.db failed");
        let f = parse_boot_error(r#"{"kind":"db-too-old","params":{"file":"C:\\Users\\a\\.agent-hangar\\hangar.db","found":3},"detail":""}"#)
            .unwrap()
            .map_text(|s| shorten_home(s, Path::new(r"C:\Users\a")));
        assert_eq!(f.params["file"], r"~\.agent-hangar\hangar.db");
        assert_eq!(f.params["found"], 3);
    }

    #[test]
    fn the_compat_mismatch_names_both_versions_and_the_port_and_writes_the_log_line() {
        let f = BootFailure::compat_mismatch(4177, 14, 16);
        assert_eq!(f.kind, "compat-mismatch");
        assert_eq!(
            f.params,
            obj(serde_json::json!({"port": 4177, "theirs": 14, "ours": 16}))
        );
        assert_eq!(f.detail, "refusing the server on 4177 (compat 14, ours 16)");
    }

    #[test]
    fn the_shells_own_failures_are_other_and_a_string_converts_to_one() {
        let f: BootFailure = "細かい理由".to_string().into();
        assert_eq!(
            (f.kind, f.detail.as_str(), f.params.is_empty()),
            ("other", "細かい理由", true)
        );
        assert_eq!(BootFailure::server_exited("x").kind, "server-exited");
    }

    #[test]
    fn map_text_reaches_the_detail_and_string_params_but_not_numbers() {
        let mut f = parse_boot_error(r#"{"kind":"db-too-old","params":{"file":"/x/SECRET/db","found":3},"detail":"open /x/SECRET/db"}"#).unwrap();
        f = f.map_text(|s| s.replace("SECRET", "***"));
        assert_eq!(f.detail, "open /x/***/db");
        assert_eq!(f.params["file"], "/x/***/db");
        assert_eq!(f.params["found"], 3);
    }

    fn env() -> Env {
        Env {
            lang: "ja",
            version: "0.1.0".into(),
            os: "macOS 15.1".into(),
            home: "~/.agent-hangar".into(),
            sep: "/",
        }
    }

    #[test]
    fn the_payload_carries_the_kind_numbers_detail_language_version_os_home_and_separator() {
        let f = BootFailure::compat_mismatch(4177, 14, 16);
        let v: Value = serde_json::from_str(&payload(&f, &env())).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "compat-mismatch",
                "params": {"port": 4177, "theirs": 14, "ours": 16},
                "detail": "refusing the server on 4177 (compat 14, ours 16)",
                "lang": "ja", "version": "0.1.0", "os": "macOS 15.1", "home": "~/.agent-hangar",
                "sep": "/"
            })
        );
    }

    // 殻が評価するのは決まった式に JSON を埋めたものだけ。詳細に何が入っていても、式の形は崩れない。
    #[test]
    fn the_script_is_a_fixed_call_with_one_json_argument() {
        let f = BootFailure::other("line1\nline2 \"q\" </script> ');alert(1);//");
        let js = fail_js(&f, &env());
        let head = "window.__hangarBootFail && window.__hangarBootFail(";
        assert!(js.starts_with(head) && js.ends_with(')'));
        assert!(!js.contains('\n'));
        let arg = &js[head.len()..js.len() - 1];
        let v: Value = serde_json::from_str(arg).unwrap();
        assert_eq!(v["detail"], "line1\nline2 \"q\" </script> ');alert(1);//");
    }

    #[test]
    fn the_language_comes_from_the_settings_file_only_when_it_is_ja_or_en() {
        assert_eq!(
            language_from_settings(r#"{"language":"en","x":1}"#),
            Some("en")
        );
        assert_eq!(language_from_settings(r#"{"language":"ja"}"#), Some("ja"));
        for t in [
            r#"{"language":"fr"}"#,
            r#"{"language":3}"#,
            r#"{}"#,
            "not json",
            "",
            "[]",
        ] {
            assert_eq!(language_from_settings(t), None, "{t:?}");
        }
    }

    #[test]
    fn the_os_language_is_the_first_apple_language() {
        assert_eq!(
            language_from_apple_languages("(\n    \"ja-JP\",\n    \"en-US\"\n)\n"),
            Some("ja")
        );
        assert_eq!(
            language_from_apple_languages("(\n    \"en-JP\",\n    \"ja-JP\"\n)\n"),
            Some("en")
        );
        assert_eq!(
            language_from_apple_languages("(\n    \"fr-FR\"\n)\n"),
            Some("en")
        );
        assert_eq!(
            language_from_apple_languages("(\n    ja,\n    en\n)\n"),
            Some("ja")
        );
        assert_eq!(language_from_apple_languages("()\n"), None);
        assert_eq!(language_from_apple_languages(""), None);
    }

    #[test]
    fn the_locale_variable_decides_ja_or_en_and_c_decides_nothing() {
        assert_eq!(language_from_locale("ja_JP.UTF-8"), Some("ja"));
        assert_eq!(language_from_locale("en_US.UTF-8"), Some("en"));
        assert_eq!(language_from_locale("de_DE.UTF-8"), Some("en"));
        assert_eq!(language_from_locale("C"), None);
        assert_eq!(language_from_locale("POSIX"), None);
        assert_eq!(language_from_locale(""), None);
    }

    #[test]
    fn the_settings_language_beats_the_os_and_the_os_beats_the_default() {
        assert_eq!(
            choose_language(Some(r#"{"language":"en"}"#), Some("ja")),
            "en"
        );
        assert_eq!(
            choose_language(Some(r#"{"language":"ja"}"#), Some("en")),
            "ja"
        );
        assert_eq!(choose_language(None, Some("en")), "en");
        assert_eq!(choose_language(Some("not json"), Some("en")), "en");
        assert_eq!(choose_language(Some("{}"), Some("en")), "en");
        assert_eq!(choose_language(None, None), "ja");
    }

    #[test]
    fn the_page_language_reads_settings_json_in_the_given_home() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{"language":"en"}"#).unwrap();
        assert_eq!(page_language(dir.path()), "en");
        std::fs::write(dir.path().join("settings.json"), r#"{"language":"ja"}"#).unwrap();
        assert_eq!(page_language(dir.path()), "ja");
    }

    #[test]
    fn the_os_label_joins_name_and_version() {
        assert_eq!(os_label_from("macOS", Some("15.1\n")), "macOS 15.1");
        assert_eq!(os_label_from("macOS", Some("")), "macOS");
        assert_eq!(os_label_from("macOS", None), "macOS");
        assert_eq!(
            pretty_name("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n").as_deref(),
            Some("Ubuntu 24.04 LTS")
        );
        assert_eq!(pretty_name("NAME=x\n"), None);
        assert!(!os_label().is_empty());
    }

    // Windows の言語は、表示言語の並び（GetUserPreferredUILanguages の名前の並び）の先頭で決める。
    #[test]
    fn windows_ui_languages_pick_the_first_name() {
        assert_eq!(language_from_ui_languages("ja-JP\0en-US\0\0"), Some("ja"));
        assert_eq!(language_from_ui_languages("en-US\0ja-JP\0\0"), Some("en"));
        assert_eq!(language_from_ui_languages("fr-FR\0"), Some("en"));
        assert_eq!(language_from_ui_languages("\0\0"), None);
        assert_eq!(language_from_ui_languages(""), None);
    }

    // Windows の版。登録簿の製品名は Windows 11 でも「Windows 10」のままなので、ビルド番号（22000 から 11）で決める。
    #[test]
    fn windows_label_names_11_from_the_build_number() {
        assert_eq!(
            windows_label(Some("26100"), Some("24H2")),
            "Windows 11 24H2 (build 26100)"
        );
        assert_eq!(
            windows_label(Some("19045"), Some("22H2")),
            "Windows 10 22H2 (build 19045)"
        );
        assert_eq!(
            windows_label(Some("22000"), None),
            "Windows 11 (build 22000)"
        );
        assert_eq!(windows_label(None, Some("24H2")), "Windows");
        assert_eq!(windows_label(Some("x"), None), "Windows");
    }
}
