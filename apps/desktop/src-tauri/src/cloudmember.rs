//! クラウド同期への参加と、PC の解除と、この PC の参加の解除の、殻の側。
//!
//! 新しい PC の参加は参加コードで行う（E2E の作り直し）。
//! 画面（127.0.0.1:4177 の頁）は殻の命令に渡し、殻は同梱の CLI（hangar cloud join-check、join-request、join-poll、
//! hangar cloud revoke、hangar cloud leave）を `--json` で走らせて、最後の 1 行の JSON をそのまま頁へ返す。
//! 参加コードは CLI の引数に載せず、標準入力で渡す（引数は ps から読める）。ログにも失敗の文にも載せない。
//! 1 回の命令は Worker への短い問い合わせで済ませる。承認を待つ間の問い合わせ（join-poll）の間隔は頁が決める。
//! 宛先の確認と、別のクラウドへの上書きの承諾は、頁の段で済ませてある。
//! ここには、頁から来た値の形の検査と、CLI の呼び出しと、返事の読み取りだけがある。

use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// CLI が返事を返すまで待つ長さ。参加の命令はどれも Worker への数回の問い合わせ（1 回 30 秒まで）で、解除は 1 往復である。
pub const CLI_TIMEOUT: Duration = Duration::from_secs(90);

/// 接続先の URL の長さの上限。
pub const MAX_JOIN_URL_CHARS: usize = 512;

/// 参加コードの長さの上限。区切りや空白を混ぜて貼られても通る長さにしてある。
pub const MAX_JOIN_CODE_CHARS: usize = 36;

/// 走っている間は印を立て、重ねて走らせない。
static BUSY: AtomicBool = AtomicBool::new(false);

/// 失敗の返事。頁は `code` で言い方を選び、`message` は CLI か OS の文をそのまま添える。
pub fn failure(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

/// 接続先の確認の引数。URL は秘密ではないので引数に載せる。
pub fn join_check_args(url: &str) -> Vec<&str> {
    vec!["cloud", "join-check", url, "--json"]
}

/// 参加のリクエストの引数。参加コードは受け取らない（標準入力で渡す）。
/// overwrite が真なら、別のクラウドへの参加（cloud.json の上書き）を CLI に許す。
pub fn join_request_args(url: &str, overwrite: bool) -> Vec<&str> {
    let mut a = vec!["cloud", "join-request", url, "--json"];
    if overwrite {
        a.push("--overwrite");
    }
    a
}

/// 承認の問い合わせの引数。CLI は Worker に 1 回だけ問い合わせて返る。
pub fn join_poll_args() -> Vec<&'static str> {
    vec!["cloud", "join-poll", "--json"]
}

/// この PC の参加の解除の引数。revoke が偽なら、クラウドの一覧ではこの PC を解除しない。
pub fn leave_args(revoke: bool) -> Vec<&'static str> {
    let mut a = vec!["cloud", "leave", "--yes", "--json"];
    if !revoke {
        a.push("--keep-device");
    }
    a
}

/// 接続先の URL の形。`https://` で始まり、ホストがあり、空白と制御文字を含まず、512 字まで。
/// 中身の検査（origin の形にそろえる、Worker が応えるか）は CLI が行う。ここでは、引数や制御文字を CLI へ流し込ませないことだけを見る。
pub fn valid_join_url(url: &str) -> bool {
    url.len() <= MAX_JOIN_URL_CHARS
        && url.len() > "https://".len()
        && url.starts_with("https://")
        && url.chars().all(|c| c.is_ascii_graphic())
}

/// 参加コードの形。ASCII の英数字と `-` と空白（貼るときに混じる）だけで、36 字まで。
/// 全角の字は受けない。頁は送る前に共有の `normalizeJoinCode`（packages/shared/src/e2e/joinCode.ts）で半角にそろえる。
/// 字の並びの検査（8 字、使える字）は CLI が行い、形が違えば Worker に送らずに `invalid-code` を返す。
pub fn valid_join_code(code: &str) -> bool {
    !code.trim().is_empty()
        && code.len() <= MAX_JOIN_CODE_CHARS
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ' ')
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
    fn the_join_commands_build_their_arguments() {
        assert_eq!(
            join_check_args("https://h.workers.dev"),
            vec!["cloud", "join-check", "https://h.workers.dev", "--json"]
        );
        assert_eq!(
            join_request_args("https://h.workers.dev", false),
            vec!["cloud", "join-request", "https://h.workers.dev", "--json"]
        );
        assert_eq!(
            join_request_args("https://h.workers.dev", true),
            vec![
                "cloud",
                "join-request",
                "https://h.workers.dev",
                "--json",
                "--overwrite"
            ]
        );
        assert_eq!(join_poll_args(), vec!["cloud", "join-poll", "--json"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_join_code_goes_to_stdin_and_never_to_the_arguments() {
        let code = "k7qm-2xfd";
        let args = join_request_args("https://h.workers.dev", true);
        assert!(args.iter().all(|a| !a.contains(code)));
        // 偽の CLI は、引数の全部と標準入力の 1 行を返す。コードは標準入力の側にだけ現れる。
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("read t; printf '{\"ok\":true,\"argv\":\"%s\",\"stdin\":\"%s\"}\\n' \"$*\" \"$t\"")
            .arg("cli")
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let reply = parse_reply(&run_with_input(cmd, Some(code), Duration::from_secs(10)).unwrap());
        assert_eq!(reply["stdin"], code);
        assert!(!reply["argv"].as_str().unwrap().contains(code));
        assert!(reply["argv"].as_str().unwrap().contains("join-request"));
    }

    #[test]
    fn the_join_url_shape_is_checked() {
        for ok in [
            "https://h.workers.dev",
            "https://hangar-x.example.workers.dev/",
            "https://h.example:8443/path",
        ] {
            assert!(valid_join_url(ok), "{ok}");
        }
        let long = format!("https://{}", "a".repeat(MAX_JOIN_URL_CHARS));
        for ng in [
            "",
            "https://",
            "http://h.workers.dev",
            "HTTPS://h.workers.dev",
            "h.workers.dev",
            "--overwrite",
            "https://h.workers.dev --overwrite",
            "https://h.workers.dev\n--overwrite",
            "https://h\u{0}.dev",
            long.as_str(),
        ] {
            assert!(!valid_join_url(ng), "{ng}");
        }
        assert!(valid_join_url(&format!(
            "https://{}",
            "a".repeat(MAX_JOIN_URL_CHARS - 8)
        )));
    }

    #[test]
    fn the_join_code_shape_is_checked() {
        for ok in [
            "k7qm-2xfd",
            "K7QM-2XFD",
            "K7QM2XFD",
            " k7qm 2xfd ",
            "k7qm - 2xfd",
        ] {
            assert!(valid_join_code(ok), "{ok}");
        }
        let long = "a".repeat(MAX_JOIN_CODE_CHARS + 1);
        for ng in [
            "",
            "   ",
            "k7qm_2xfd",
            "k7qm\n2xfd",
            "k7qm\t2xfd",
            "k7qm;rm",
            "k7qm\u{0}2xfd",
            "Ｋ７ＱＭ－２ＸＦＤ",
            long.as_str(),
        ] {
            assert!(!valid_join_code(ng), "{ng:?}");
        }
        assert!(valid_join_code(&"a".repeat(MAX_JOIN_CODE_CHARS)));
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
