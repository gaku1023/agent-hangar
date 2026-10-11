//! クラウド同期への参加と、PC の解除と、この PC の参加の解除の、殻の側（0.4.0）。
//!
//! 参加トークンはこのクラウドの全セッションを読み書きできる秘密なので、サーバの HTTP API には載せない（D9）。
//! 画面（127.0.0.1:4177 の頁）は殻の命令に渡し、殻は同梱の CLI（hangar join、hangar cloud revoke、hangar cloud leave）を
//! `--json` で走らせて、最後の 1 行の JSON をそのまま頁へ返す。
//! 参加トークンは CLI の引数に載せず、標準入力で渡す（引数は ps から読める）。
//! 宛先の確認と、別のクラウドへの上書きの承諾は、頁の段（参加トークンを貼る、宛先を確認、参加）で済ませてある。
//! ここには、頁から来た値の形の検査と、CLI の呼び出しと、返事の読み取りだけがある。

use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// CLI が返事を返すまで待つ長さ。参加は Worker への 1 往復（反映待ちの試し直しは 403 では行わない）で、解除も 1 往復である。
pub const CLI_TIMEOUT: Duration = Duration::from_secs(90);

/// 参加トークンの長さの上限。共有の `MAX_JOIN_TOKEN_CHARS`（packages/shared/src/cloud.ts）と同じ値である。
pub const MAX_TOKEN_CHARS: usize = 2048;

/// 走っている間は印を立て、重ねて走らせない。
static BUSY: AtomicBool = AtomicBool::new(false);

/// 失敗の返事。頁は `code` で言い方を選び、`message` は CLI か OS の文をそのまま添える。
pub fn failure(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

/// 参加の見立ての引数。参加トークンは受け取らない（標準入力で渡す）。
pub fn plan_args() -> Vec<&'static str> {
    vec!["join", "--plan", "--json"]
}

/// 参加の引数。参加トークンは受け取らない（標準入力で渡す）。
pub fn join_args(overwrite: bool) -> Vec<&'static str> {
    let mut a = vec!["join", "--yes", "--json"];
    if overwrite {
        a.push("--overwrite");
    }
    a
}

/// この PC の参加の解除の引数。revoke が偽なら、クラウドの一覧ではこの PC を解除しない。
pub fn leave_args(revoke: bool) -> Vec<&'static str> {
    let mut a = vec!["cloud", "leave", "--yes", "--json"];
    if !revoke {
        a.push("--keep-device");
    }
    a
}

/// 参加トークンの形。base64url の字（と、貼るときに混じる空白）だけで、長さに上限を置く。
/// 中身の検査（宛先の形）は CLI が行う。ここでは、引数や制御文字を CLI へ流し込ませないことだけを見る。
pub fn valid_token(token: &str) -> bool {
    let t = token.trim();
    !t.is_empty()
        && token.len() <= MAX_TOKEN_CHARS
        && token.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '=' || c.is_ascii_whitespace()
        })
}

/// 端末 ID の形。共有の `isSafeKeyId`（packages/shared/src/cloud.ts）と同じ物差しで、英数字で始まり、英数字と `.` `_` `-` が 64 字まで。
pub fn valid_device_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    id.len() <= 64 && chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// CLI の標準出力の最後の空でない行を JSON として読む。読めなければ unreadable の失敗にする。
pub fn parse_reply(stdout: &str) -> Value {
    let line = stdout.lines().rev().find(|l| !l.trim().is_empty());
    match line.and_then(|l| serde_json::from_str::<Value>(l.trim()).ok()) {
        Some(v) if v.get("ok").and_then(Value::as_bool).is_some() => v,
        _ => failure("unreadable", ""),
    }
}

/// CLI を走らせ、入力を標準入力へ書いて閉じ、標準出力を返す。待ちすぎたら子を止める。
pub fn run_with_input(
    mut cmd: Command,
    input: Option<&str>,
    timeout: Duration,
) -> Result<String, Value> {
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| failure("cannot-start", &e.to_string()))?;
    if let Some(text) = input {
        if let Some(mut stdin) = child.stdin.take() {
            // 書けなくても（子が先に終わった）、返事は標準出力から読む。
            let _ = stdin.write_all(text.as_bytes());
            let _ = stdin.write_all(b"\n");
        }
    }
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(Err(e)) => Err(failure("cannot-read", &e.to_string())),
        Err(_) => {
            kill_tree(pid);
            Err(failure("timeout", &timeout.as_secs().to_string()))
        }
    }
}

/// 子を止める。Windows には信号が無いので、孫まで含めてプロセスの木ごと止める。
fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(crate::winjob::CREATE_NO_WINDOW)
            .status();
    }
}

/// 重ねて走らせないよう印を立てて、仕事を走らせる。走っていれば busy の失敗を返す。
pub fn guarded(run: impl FnOnce() -> Value) -> Value {
    if BUSY.swap(true, Ordering::SeqCst) {
        return failure("busy", "");
    }
    let v = run();
    BUSY.store(false, Ordering::SeqCst);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_join_token_is_never_an_argument() {
        assert_eq!(plan_args(), vec!["join", "--plan", "--json"]);
        assert_eq!(join_args(false), vec!["join", "--yes", "--json"]);
        assert_eq!(
            join_args(true),
            vec!["join", "--yes", "--json", "--overwrite"]
        );
    }

    #[test]
    fn leaving_revokes_in_the_cloud_by_default() {
        assert_eq!(leave_args(true), vec!["cloud", "leave", "--yes", "--json"]);
        assert_eq!(
            leave_args(false),
            vec!["cloud", "leave", "--yes", "--json", "--keep-device"]
        );
    }

    #[test]
    fn the_token_shape_is_checked() {
        assert!(valid_token("eyJ1cmwiOiJodHRwczovL2gifQ"));
        assert!(valid_token("eyJ1cm\n wiOiJo"));
        assert!(!valid_token(""));
        assert!(!valid_token("   "));
        assert!(!valid_token("--overwrite;rm"));
        assert!(!valid_token("a\u{0}b"));
        assert!(!valid_token(&"a".repeat(MAX_TOKEN_CHARS + 1)));
    }

    #[test]
    fn the_device_id_shape_is_checked() {
        for ok in ["dev-a", "a.b_c-1", "0198e1c3-7f2a-7b51-9d3e-4f6a8b2c1d0e"] {
            assert!(valid_device_id(ok), "{ok}");
        }
        let long = "x".repeat(65);
        for ng in [
            "",
            "-lead",
            ".lead",
            "a/b",
            "../x",
            "a b",
            "--yes",
            long.as_str(),
        ] {
            assert!(!valid_device_id(ng), "{ng}");
        }
    }

    #[test]
    fn the_reply_is_the_last_json_line() {
        let v = parse_reply("注意\n{\"ok\":true,\"plan\":{\"host\":\"h\"}}\n\n");
        assert_eq!(v["plan"]["host"], "h");
        let f = parse_reply("{\"ok\":false,\"code\":\"forbidden\",\"message\":\"x\"}");
        assert_eq!(f["code"], "forbidden");
        assert_eq!(parse_reply("not json")["code"], "unreadable");
        assert_eq!(parse_reply("{\"x\":1}")["code"], "unreadable");
        assert_eq!(parse_reply("")["code"], "unreadable");
    }

    #[test]
    fn runs_do_not_overlap() {
        let inner = guarded(|| guarded(|| json!({ "ok": true })));
        assert_eq!(inner["code"], "busy");
        assert_eq!(guarded(|| json!({ "ok": true }))["ok"], true);
    }

    #[cfg(unix)]
    #[test]
    fn the_input_goes_to_stdin_and_stdout_is_read() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args([
            "-c",
            "read t; printf '{\"ok\":true,\"got\":\"%s\"}\\n' \"$t\"",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let out = run_with_input(cmd, Some("tok"), Duration::from_secs(10)).unwrap();
        assert_eq!(parse_reply(&out)["got"], "tok");
    }

    #[cfg(unix)]
    #[test]
    fn a_run_that_takes_too_long_is_stopped() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]).stdout(Stdio::piped());
        let e = run_with_input(cmd, None, Duration::from_millis(200)).unwrap_err();
        assert_eq!(e["code"], "timeout");
    }
}
