//! 設定の同期の適用と、控えの世代へ戻す操作の、殻の側。
//!
//! 他の PC から届いた設定を `~/.claude` へ書くのは、サーバではなく、殻の命令と CLI（hangar config）だけである（全体計画の D9）。
//! 殻の命令は、CLI に見立て（`--plan --json`）を出させ、書く先ごとの差分を承諾の窓（approve.rs）に見せて、
//! 承諾されたときだけ同じ CLI の `--yes --json` を走らせる。書く処理の本体は CLI の側（server の sync/config/apply.ts）にあり、
//! ここには結果の文の組み立てと、CLI の呼び出し、返事の読み取りだけがある。
//! 頁（remote）から受け取るのは、戻す世代の名前だけである。

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// CLI が返事を返すまで待つ長さ。適用は数十ファイルの書き込みと DB の更新で、数秒で終わる。
pub const CLI_TIMEOUT: Duration = Duration::from_secs(120);

/// 殻が出す設定の同期の文。言語は殻の頁と同じく `bootfail::page_language` で決め、`words` で引く。
/// 日本語の名前は CLI（packages/cli/src/config.ts の KIND_LABEL）と同じ言い方、英語は UI の辞書（configSyncUi）と同じ言い方にする。
/// 文の中の `{n}` などは、出すときに値へ置き換える。
/// CLI が返す失敗の文（`Failure::message`）は CLI の文なので、ここでは訳さない。
pub struct Words {
    unreadable: &'static str,
    applied: &'static str,
    applied_generation: &'static str,
    restored: &'static str,
    restored_safety: &'static str,
    cannot_start: &'static str,
    cannot_read: &'static str,
    too_long: &'static str,
    /// lib.rs の流れが出す文。
    pub apply_flow_title: &'static str,
    pub restore_flow_title: &'static str,
    pub busy: &'static str,
    pub bad_generation: &'static str,
    pub apply_stopped: &'static str,
    pub restore_stopped: &'static str,
}

// CI の rustfmt は日本語の幅を手元と違って数えるので、文の表は整形を止めて書いたままにする。
#[rustfmt::skip]
const JA: Words = Words {
    unreadable: "設定の同期のコマンドの応答を読み取れませんでした。~/.agent-hangar/desktop.log を確認するか、ターミナルで hangar config apply を実行して確認してください。",
    applied: "適用しました（書き込み {written} 件、削除 {removed} 件、この PC の内容を保持 {kept} 件）。",
    applied_generation: "バックアップの世代 {g} から復元できます。",
    restored: "復元しました（書き戻し {restored} 件、削除 {removed} 件）。",
    restored_safety: "復元前の状態を世代 {g} としてバックアップしました。",
    cannot_start: "設定の同期のコマンドを起動できません: {e}",
    cannot_read: "設定の同期のコマンドの結果を読み取れません: {e}",
    too_long: "設定の同期のコマンドが {s} 秒以内に終了しませんでした。",
    apply_flow_title: "設定の適用",
    restore_flow_title: "設定の復元",
    busy: "設定の確認がすでに表示されています。",
    bad_generation: "世代の名前が正しくありません。",
    apply_stopped: "設定の適用の処理が停止しました。",
    restore_stopped: "設定の復元の処理が停止しました。",
};

#[rustfmt::skip]
const EN: Words = Words {
    unreadable: "Could not read the reply of the settings sync command. Check ~/.agent-hangar/desktop.log, or run hangar config apply in a terminal.",
    applied: "Applied ({written} written, {removed} deleted, {kept} kept as they were on this computer).",
    applied_generation: " You can go back to backup generation {g}.",
    restored: "Restored ({restored} written back, {removed} deleted).",
    restored_safety: " The state before the restore was saved as generation {g}.",
    cannot_start: "Cannot start the settings sync command: {e}",
    cannot_read: "Cannot read the result of the settings sync command: {e}",
    too_long: "The settings sync command did not finish within {s} seconds.",
    apply_flow_title: "Apply settings",
    restore_flow_title: "Restore settings to a generation",
    busy: "A settings confirmation is already open.",
    bad_generation: "The generation name is not valid.",
    apply_stopped: "Applying the settings stopped.",
    restore_stopped: "Restoring the settings stopped.",
};

/// 言語（`bootfail::page_language` の ja か en）の文の表。en のほかは日本語にする。
pub fn words(lang: &str) -> &'static Words {
    if lang == "en" {
        &EN
    } else {
        &JA
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlanItem {
    pub label: String,
    #[serde(default)]
    pub marks: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Counts {
    #[serde(default)]
    pub create: u32,
    #[serde(default)]
    pub overwrite: u32,
    #[serde(default)]
    pub delete: u32,
    #[serde(default, rename = "conflictRemote")]
    pub conflict_remote: u32,
    #[serde(default, rename = "conflictMine")]
    pub conflict_mine: u32,
}

/// `hangar config apply --plan --json` の `plan`。使う欄だけを読む。
#[derive(Debug, Clone, Deserialize)]
pub struct ApplyPlan {
    /// 指示書の作成時刻（ミリ秒）。確認した指示書にだけ適用するため、`--order` に渡す。
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    pub counts: Counts,
    #[serde(default, rename = "byKind")]
    pub by_kind: HashMap<String, u32>,
    /// 書き込む skills、commands、agents の数。Claude が読んで実行する指示である。
    #[serde(default)]
    pub instructions: u32,
    /// 書き込む項目のうち、フック、コマンド実行、スクリプトの印のあるもの。
    #[serde(default)]
    pub exec: Vec<PlanItem>,
}

/// `hangar config restore <世代> --plan --json` の `plan`。
#[derive(Debug, Clone, Deserialize)]
pub struct RestorePlan {
    pub name: String,
    #[serde(default)]
    pub restore: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

// ---- CLI の返事 ----

/// CLI が ok: false で返した失敗。message はそのまま利用者に見せる文である（CLI の文は日本語だけ）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

/// CLI の標準出力の最後の 1 行（JSON）を読む。`key` は成功のときの中身の名前（plan か result）。
/// ok: false は Failure、JSON として読めないものも Failure にする。読めないときの文は `lang` の言語で書く。
pub fn parse_reply<T: DeserializeOwned>(stdout: &str, key: &str, lang: &str) -> Result<T, Failure> {
    let unreadable = || Failure {
        code: "unreadable".to_string(),
        message: words(lang).unreadable.to_string(),
    };
    let line = stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .ok_or_else(unreadable)?;
    let v: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| unreadable())?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        let inner = v.get(key).cloned().ok_or_else(unreadable)?;
        return serde_json::from_value(inner).map_err(|_| unreadable());
    }
    Err(Failure {
        code: v
            .get("code")
            .and_then(|s| s.as_str())
            .unwrap_or("failed")
            .to_string(),
        message: v
            .get("message")
            .and_then(|s| s.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| unreadable().message),
    })
}

/// `hangar config apply --yes --json` の `result`。
#[derive(Debug, Clone, Deserialize)]
pub struct ApplyResult {
    #[serde(default)]
    pub generation: Option<String>,
    #[serde(default)]
    pub written: u32,
    #[serde(default)]
    pub removed: u32,
    #[serde(default, rename = "keptMine")]
    pub kept_mine: u32,
}

/// `hangar config restore <世代> --yes --json` の `result`。
#[derive(Debug, Clone, Deserialize)]
pub struct RestoreResult {
    #[serde(default)]
    pub restored: Vec<String>,
    #[serde(default)]
    pub removed: Vec<String>,
    #[serde(default)]
    pub safety: Option<String>,
}

/// 頁へ返す結果。status は applied、restored、cancelled、none、failed、busy のどれか。
/// message は画面の知らせにそのまま出せる 1 文で、殻の頁と同じ言語で書く（CLI の失敗の文は CLI のまま）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Outcome {
    pub status: &'static str,
    pub message: String,
    /// 控えた世代の名前（適用したとき）、または戻す前の状態を控えた世代の名前（戻したとき）。
    pub generation: Option<String>,
    /// 理由の鍵（CLI の code。書く先が変わった changed、Windows で使えない windows など）。画面が文を選ぶのに使う。無ければ None。
    pub code: Option<String>,
}

impl Outcome {
    pub fn simple(status: &'static str, message: impl Into<String>) -> Self {
        Outcome {
            status,
            message: message.into(),
            generation: None,
            code: None,
        }
    }

    pub fn applied(r: &ApplyResult, lang: &str) -> Self {
        let w = words(lang);
        let mut message = w
            .applied
            .replace("{written}", &r.written.to_string())
            .replace("{removed}", &r.removed.to_string())
            .replace("{kept}", &r.kept_mine.to_string());
        if let Some(g) = &r.generation {
            message.push_str(&w.applied_generation.replace("{g}", g));
        }
        Outcome {
            status: "applied",
            message,
            generation: r.generation.clone(),
            code: None,
        }
    }

    pub fn restored(r: &RestoreResult, lang: &str) -> Self {
        let w = words(lang);
        let mut message = w
            .restored
            .replace("{restored}", &r.restored.len().to_string())
            .replace("{removed}", &r.removed.len().to_string());
        if let Some(g) = &r.safety {
            message.push_str(&w.restored_safety.replace("{g}", g));
        }
        Outcome {
            status: "restored",
            message,
            generation: r.safety.clone(),
            code: None,
        }
    }

    /// 失敗。指示書が無いのは失敗ではなく、まだ選んでいないだけなので none にする。
    pub fn failure(f: &Failure) -> Self {
        let status = if f.code == "no-order" {
            "none"
        } else {
            "failed"
        };
        Outcome {
            code: Some(f.code.clone()),
            ..Outcome::simple(status, f.message.clone())
        }
    }
}

/// 戻す世代の名前として受け取れるか。`yyyyMMdd-HHmmss`（数字 8 桁、ハイフン、数字 6 桁）だけにする。
/// 頁から来る値なので、パスの区切りや引数に見える形を CLI へ渡さない。
pub fn valid_generation_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 15
        && b[8] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 8 || c.is_ascii_digit())
}

// ---- CLI の呼び出し ----

/// `node cli.mjs <引数>` のコマンド。サーバの子と同じに、受け継いだ Claude Code の印を外し、hangar の置き場を殻の値で入れる。
/// パスはサーバの子と同じに、Windows の verbatim の接頭辞を外してから渡す（`paths::plain`）。
pub fn cli_command(node: &Path, server_dir: &Path, hangar_home: &Path, args: &[&str]) -> Command {
    use crate::paths::plain;
    let node = plain(node);
    let path = crate::server::augmented_path(
        std::env::var("PATH").ok().as_deref(),
        &crate::paths::user_home(),
        node.parent(),
    );
    let mut cmd = Command::new(node);
    for name in crate::server::INHERITED_ENV_DROPPED {
        cmd.env_remove(name);
    }
    cmd.arg(plain(server_dir).join("cli.mjs"))
        .args(args)
        .env("PATH", path)
        .env("HANGAR_HOME", plain(hangar_home))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 窓を持たない殻から起こすと、命令ごとに黒いコンソールの窓が開く。
        cmd.creation_flags(crate::winjob::CREATE_NO_WINDOW);
    }
    cmd
}

/// CLI を走らせて、標準出力を返す。失敗の終了コードでも、標準出力に JSON の返事があるので、そのまま返す。
/// 起こせない、待ちすぎ、のときだけ Err で、その文は `lang` の言語で書く。待ちすぎたら子を止める。
pub fn run_cli(mut cmd: Command, timeout: Duration, lang: &str) -> Result<String, String> {
    let w = words(lang);
    let child = cmd
        .spawn()
        .map_err(|e| w.cannot_start.replace("{e}", &e.to_string()))?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(Err(e)) => Err(w.cannot_read.replace("{e}", &e.to_string())),
        Err(_) => {
            // 子を止めれば、待っているスレッドも終わる。
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            // Windows には信号が無い。孫まで含めて、プロセスの木ごと止める。
            // taskkill も窓の無いコンソールで起こす。
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .creation_flags(crate::winjob::CREATE_NO_WINDOW)
                    .status();
            }
            Err(w.too_long.replace("{s}", &timeout.as_secs().to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_are_read_from_the_last_json_line() {
        // 前置きの行（ログ）があっても、最後の JSON の行を読む。
        let reply = r#"log
{"ok":true,"plan":{"createdAt":42,"counts":{"create":1},"byKind":{}}}
"#;
        let ok: Result<ApplyPlan, Failure> = parse_reply(reply, "plan", "ja");
        let ok = ok.unwrap();
        assert_eq!((ok.created_at, ok.counts.create), (42, 1));
        let failed: Result<ApplyPlan, Failure> = parse_reply(
            "{\"ok\":false,\"code\":\"no-order\",\"message\":\"適用の指示書がありません\"}\n",
            "plan",
            "ja",
        );
        assert_eq!(
            failed.unwrap_err(),
            Failure {
                code: "no-order".to_string(),
                message: "適用の指示書がありません".to_string()
            }
        );
        for bad in [
            "",
            "\n\n",
            "not json",
            "{\"ok\":true}",
            "{\"ok\":true,\"plan\":3}",
        ] {
            let r: Result<ApplyPlan, Failure> = parse_reply(bad, "plan", "ja");
            assert_eq!(r.unwrap_err().code, "unreadable", "{bad}");
        }
    }

    #[test]
    fn outcomes_read_naturally_and_a_missing_order_is_not_a_failure() {
        let applied = Outcome::applied(
            &ApplyResult {
                generation: Some("20261010-120000".to_string()),
                written: 2,
                removed: 1,
                kept_mine: 0,
            },
            "ja",
        );
        assert_eq!(applied.status, "applied");
        assert!(applied.message.contains("書き込み 2 件、削除 1 件"));
        assert!(applied.message.contains("20261010-120000"));
        assert_eq!(applied.generation.as_deref(), Some("20261010-120000"));
        let restored = Outcome::restored(
            &RestoreResult {
                restored: vec!["a".into()],
                removed: vec![],
                safety: Some("20261010-120100".to_string()),
            },
            "ja",
        );
        assert_eq!(restored.status, "restored");
        assert!(restored.message.contains("20261010-120100"));
        assert_eq!(
            Outcome::failure(&Failure {
                code: "no-order".into(),
                message: "m".into()
            })
            .status,
            "none"
        );
        assert_eq!(
            Outcome::failure(&Failure {
                code: "stale".into(),
                message: "m".into()
            })
            .status,
            "failed"
        );
    }

    fn has_japanese(s: &str) -> bool {
        s.chars().any(|c| {
            matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}' | '\u{ff08}' | '\u{ff09}' | '\u{3001}')
        })
    }

    // 英語の設定（と英語の OS で入れたばかりの状態）では、確認のダイアログも結果の文も英語で出す。
    #[test]
    fn the_outcomes_are_english_in_english() {
        let applied = Outcome::applied(
            &ApplyResult {
                generation: Some("20261010-120000".to_string()),
                written: 2,
                removed: 1,
                kept_mine: 0,
            },
            "en",
        );
        assert_eq!(applied.message, "Applied (2 written, 1 deleted, 0 kept as they were on this computer). You can go back to backup generation 20261010-120000.");
        let restored = Outcome::restored(
            &RestoreResult {
                restored: vec!["a".into()],
                removed: vec![],
                safety: Some("20261010-120100".to_string()),
            },
            "en",
        );
        assert!(!has_japanese(&restored.message), "{}", restored.message);
        let r: Result<ApplyPlan, Failure> = parse_reply("not json", "plan", "en");
        assert!(!has_japanese(&r.unwrap_err().message));
        for w in [
            words("en").busy,
            words("en").bad_generation,
            words("en").apply_flow_title,
        ] {
            assert!(!has_japanese(w), "{w}");
        }
    }

    #[test]
    fn only_a_timestamp_name_is_accepted_for_a_generation() {
        assert!(valid_generation_name("20261010-120000"));
        for bad in [
            "",
            "removed",
            "../x",
            "20261010-12000",
            "20261010_120000",
            "2026101a-120000",
            "20261010-1200000",
            "-rf",
            "20261010-120000 ",
        ] {
            assert!(!valid_generation_name(bad), "{bad}");
        }
    }

    #[test]
    fn the_cli_runs_with_the_shell_values_and_without_inherited_claude_marks() {
        let cmd = cli_command(
            Path::new("/n/node"),
            Path::new("/s/server"),
            Path::new("/h/home"),
            &["config", "apply", "--plan", "--json"],
        );
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        // 区切りは OS に従う（Windows では \）。
        let cli = Path::new("/s/server")
            .join("cli.mjs")
            .to_string_lossy()
            .into_owned();
        assert_eq!(args, [cli.as_str(), "config", "apply", "--plan", "--json"]);
        let envs: Vec<_> = cmd.get_envs().collect();
        for name in crate::server::INHERITED_ENV_DROPPED {
            assert!(
                envs.iter()
                    .any(|(k, v)| *k == std::ffi::OsStr::new(name) && v.is_none()),
                "{name}"
            );
        }
        assert!(envs
            .iter()
            .any(|(k, v)| *k == std::ffi::OsStr::new("HANGAR_HOME")
                && *v == Some(std::ffi::OsStr::new("/h/home"))));
    }

    // 設定の同期の命令も、同梱の置き場（resource_dir の下）の cli.mjs を Node に渡す。
    // サーバと同じく、verbatim の形を外して渡す（Node 22.20 以降はその形の主スクリプトを読めない）。
    #[cfg(windows)]
    #[test]
    fn the_cli_gets_plain_paths_on_windows() {
        let cmd = cli_command(
            Path::new("node"),
            Path::new(r"\\?\C:\Users\me\AppData\Local\Hangar\server"),
            Path::new(r"\\?\C:\Users\me\.agent-hangar"),
            &["config", "apply"],
        );
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(
            args[0],
            std::ffi::OsStr::new(r"C:\Users\me\AppData\Local\Hangar\server\cli.mjs")
        );
        assert!(cmd
            .get_envs()
            .any(|(k, v)| k == std::ffi::OsStr::new("HANGAR_HOME")
                && v == Some(std::ffi::OsStr::new(r"C:\Users\me\.agent-hangar"))));
    }

    // 実物の Node に、verbatim の置き場から cli.mjs を走らせる。
    #[cfg(windows)]
    #[test]
    fn node_runs_the_cli_from_a_verbatim_resource_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let verbatim = tmp.path().canonicalize().unwrap();
        assert!(
            verbatim.to_string_lossy().starts_with(r"\\?\"),
            "{verbatim:?}"
        );
        std::fs::write(
            verbatim.join("cli.mjs"),
            "console.log(JSON.stringify({ ok: true, main: process.argv[1] }));\n",
        )
        .unwrap();
        let out = run_cli(
            cli_command(Path::new("node"), &verbatim, tmp.path(), &[]),
            Duration::from_secs(30),
            "ja",
        )
        .unwrap();
        assert!(out.contains("\"ok\":true"), "{out}");
        assert!(!out.contains(r"\\\\?\\"), "{out}");
    }

    #[cfg(unix)]
    mod run {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// node の代わりに置く、決まった返事を返すスクリプト。
        fn fake_node(dir: &Path, body: &str) -> std::path::PathBuf {
            let p = dir.join("node");
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        }

        #[test]
        fn stdout_is_returned_even_when_the_cli_exits_with_failure() {
            let dir = tempfile::tempdir().unwrap();
            let node = fake_node(
                dir.path(),
                r#"echo '{"ok":false,"code":"no-order","message":"m"}'; exit 1"#,
            );
            let out = run_cli(
                cli_command(&node, dir.path(), dir.path(), &["config", "apply"]),
                Duration::from_secs(10),
                "ja",
            )
            .unwrap();
            let r: Result<ApplyPlan, Failure> = parse_reply(&out, "plan", "ja");
            assert_eq!(r.unwrap_err().code, "no-order");
        }

        #[test]
        fn a_cli_that_takes_too_long_is_stopped() {
            let dir = tempfile::tempdir().unwrap();
            let node = fake_node(dir.path(), "sleep 30");
            let err = run_cli(
                cli_command(&node, dir.path(), dir.path(), &[]),
                Duration::from_millis(300),
                "ja",
            )
            .unwrap_err();
            assert!(err.contains("以内に終了しませんでした"));
        }

        #[test]
        fn a_cli_that_takes_too_long_is_reported_in_english() {
            let dir = tempfile::tempdir().unwrap();
            let node = fake_node(dir.path(), "sleep 30");
            let err = run_cli(
                cli_command(&node, dir.path(), dir.path(), &[]),
                Duration::from_millis(300),
                "en",
            )
            .unwrap_err();
            assert!(err.contains("did not finish within 0 seconds"), "{err}");
        }

        #[test]
        fn a_missing_node_is_reported() {
            let err = run_cli(
                cli_command(
                    Path::new("/nonexistent/node"),
                    Path::new("/s"),
                    Path::new("/h"),
                    &[],
                ),
                Duration::from_secs(1),
                "ja",
            )
            .unwrap_err();
            assert!(err.contains("起動できません"));
        }
    }
}
