//! 設定の同期の適用と、控えの世代へ戻す操作の、殻の側。
//!
//! 他の PC から届いた設定を `~/.claude` へ書くのは、サーバではなく、殻の命令と CLI（hangar config）だけである（全体計画の D9）。
//! 殻の命令は、CLI に見立て（`--plan --json`）を出させ、その件数と種類をネイティブの確認に見せて、
//! 承諾されたときだけ同じ CLI の `--yes --json` を走らせる。書く処理の本体は CLI の側（server の sync/config/apply.ts）にあり、
//! ここには確認の文の組み立てと、CLI の呼び出し、返事の読み取りだけがある。
//! 確認の文は、どの画面から呼ばれても同じで、画面が値を差し込めない。頁（remote）から受け取るのは、戻す世代の名前だけである。

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// CLI が返事を返すまで待つ長さ。適用は数十ファイルの書き込みと DB の更新で、数秒で終わる。
pub const CLI_TIMEOUT: Duration = Duration::from_secs(120);

/// 確認に並べる、実行される内容を含む項目の数の上限。
const LISTED_EXEC: usize = 5;
/// 確認に並べる、戻す先のファイルの数の上限。
const LISTED_FILES: usize = 8;

/// 種類の並べ方と名前。CLI（packages/cli/src/config.ts の KIND_LABEL）と同じ言い方にする。
const KINDS: &[(&str, &str)] = &[
    ("claude-md", "CLAUDE.md"),
    ("settings", "settings.json の鍵"),
    ("keybindings", "keybindings.json"),
    ("skills", "スキル"),
    ("commands", "コマンド"),
    ("agents", "エージェント"),
    ("memory", "メモリ"),
];

fn mark_name(mark: &str) -> &str {
    match mark {
        "hooks" => "フック",
        "shell" => "シェルのコマンド実行",
        "script" => "スクリプト",
        other => other,
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

/// ネイティブの確認に出す文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Confirm {
    pub title: String,
    pub body: String,
    pub ok: &'static str,
    pub cancel: &'static str,
    /// 実行される内容を含むときは警告の見た目で出す。
    pub warn: bool,
}

fn counts_line(c: &Counts) -> String {
    let mut parts = Vec::new();
    for (n, word) in [
        (c.create, "新規"),
        (c.overwrite, "上書き"),
        (c.delete, "削除"),
        (c.conflict_remote, "競合で相手を採る"),
        (c.conflict_mine, "競合で手元を残す"),
    ] {
        if n > 0 {
            parts.push(format!("{word} {n} 件"));
        }
    }
    parts.join("、")
}

fn kinds_line(by_kind: &HashMap<String, u32>) -> String {
    KINDS
        .iter()
        .filter_map(|(key, name)| {
            by_kind
                .get(*key)
                .filter(|n| **n > 0)
                .map(|n| format!("{name} {n}"))
        })
        .collect::<Vec<_>>()
        .join("、")
}

/// 適用の確認の文。件数、種類、実行される指示とフックやコマンド実行を含む項目、控えと戻し方の順に並べる。
pub fn apply_confirm(plan: &ApplyPlan) -> Confirm {
    let mut body = String::from(
        "他の PC から届いた設定を、このパソコンの Claude Code の設定フォルダ（~/.claude）に書きます。\n",
    );
    body.push_str(&format!("\n{}", counts_line(&plan.counts)));
    let kinds = kinds_line(&plan.by_kind);
    if !kinds.is_empty() {
        body.push_str(&format!("\n種類: {kinds}"));
    }
    let warn = plan.instructions > 0 || !plan.exec.is_empty();
    if warn {
        body.push_str(&format!(
            "\n\n注意: Claude が読んで実行する指示（スキル、コマンド、エージェント）を {} 件書きます。",
            plan.instructions
        ));
    }
    if !plan.exec.is_empty() {
        body.push_str("\nこのうち、フックやコマンドの実行を含むもの:");
        for item in plan.exec.iter().take(LISTED_EXEC) {
            let marks: Vec<&str> = item.marks.iter().map(|m| mark_name(m)).collect();
            body.push_str(&format!("\n  {}（{}）", item.label, marks.join("、")));
        }
        if plan.exec.len() > LISTED_EXEC {
            body.push_str(&format!("\n  ほか {} 件", plan.exec.len() - LISTED_EXEC));
        }
    }
    body.push_str("\n\n書く前に、元の中身を控えの世代に取ります。あとから設定の「この世代に戻す」で戻せます。");
    Confirm {
        title: "他の PC の設定を適用しますか".to_string(),
        body,
        ok: "適用する",
        cancel: "やめる",
        warn,
    }
}

/// 世代へ戻す確認の文。
pub fn restore_confirm(plan: &RestorePlan) -> Confirm {
    let mut body = format!("控えの世代 {} の時点へ戻します。", plan.name);
    let list = |body: &mut String, head: &str, files: &[String]| {
        if files.is_empty() {
            return;
        }
        body.push_str(&format!("\n\n{head}"));
        for f in files.iter().take(LISTED_FILES) {
            body.push_str(&format!("\n  {f}"));
        }
        if files.len() > LISTED_FILES {
            body.push_str(&format!("\n  ほか {} 件", files.len() - LISTED_FILES));
        }
    };
    list(&mut body, "書き戻すファイル:", &plan.restore);
    list(
        &mut body,
        "その時点で無かったので消すファイル:",
        &plan.remove,
    );
    body.push_str("\n\nその世代のあとで手元で変えた内容も、世代の時点へ戻ります。戻す前の状態は新しい世代に控えるので、戻しも取り消せます。");
    Confirm {
        title: "この世代へ戻しますか".to_string(),
        body,
        ok: "戻す",
        cancel: "やめる",
        warn: false,
    }
}

// ---- CLI の返事 ----

/// CLI が ok: false で返した失敗。message はそのまま利用者に見せる日本語の文である。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

/// CLI の標準出力の最後の 1 行（JSON）を読む。`key` は成功のときの中身の名前（plan か result）。
/// ok: false は Failure、JSON として読めないものも Failure にする。
pub fn parse_reply<T: DeserializeOwned>(stdout: &str, key: &str) -> Result<T, Failure> {
    let unreadable = || {
        Failure {
        code: "unreadable".to_string(),
        message: "設定の同期の命令の返事を読めませんでした。~/.agent-hangar/desktop.log か、端末で hangar config apply を確かめてください。".to_string(),
    }
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
/// message は画面の知らせにそのまま出せる日本語の 1 文である。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Outcome {
    pub status: &'static str,
    pub message: String,
    /// 控えた世代の名前（適用したとき）、または戻す前の状態を控えた世代の名前（戻したとき）。
    pub generation: Option<String>,
}

impl Outcome {
    pub fn simple(status: &'static str, message: impl Into<String>) -> Self {
        Outcome {
            status,
            message: message.into(),
            generation: None,
        }
    }

    pub fn applied(r: &ApplyResult) -> Self {
        let mut message = format!(
            "適用しました（書き込み {} 件、削除 {} 件、手元を残す {} 件）。",
            r.written, r.removed, r.kept_mine
        );
        if let Some(g) = &r.generation {
            message.push_str(&format!("控えの世代 {g} から戻せます。"));
        }
        Outcome {
            status: "applied",
            message,
            generation: r.generation.clone(),
        }
    }

    pub fn restored(r: &RestoreResult) -> Self {
        let mut message = format!(
            "戻しました（書き戻し {} 件、消去 {} 件）。",
            r.restored.len(),
            r.removed.len()
        );
        if let Some(g) = &r.safety {
            message.push_str(&format!("戻す前の状態を世代 {g} に控えました。"));
        }
        Outcome {
            status: "restored",
            message,
            generation: r.safety.clone(),
        }
    }

    /// 失敗。指示書が無いのは失敗ではなく、まだ選んでいないだけなので none にする。
    pub fn failure(f: &Failure) -> Self {
        let status = if f.code == "no-order" {
            "none"
        } else {
            "failed"
        };
        Outcome::simple(status, f.message.clone())
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
pub fn cli_command(node: &Path, server_dir: &Path, hangar_home: &Path, args: &[&str]) -> Command {
    let path = crate::server::augmented_path(
        std::env::var("PATH").ok().as_deref(),
        &crate::paths::user_home(),
    );
    let mut cmd = Command::new(node);
    for name in crate::server::INHERITED_ENV_DROPPED {
        cmd.env_remove(name);
    }
    cmd.arg(server_dir.join("cli.mjs"))
        .args(args)
        .env("PATH", path)
        .env("HANGAR_HOME", hangar_home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// CLI を走らせて、標準出力を返す。失敗の終了コードでも、標準出力に JSON の返事があるので、そのまま返す。
/// 起こせない、待ちすぎ、のときだけ Err。待ちすぎたら子を止める。
pub fn run_cli(mut cmd: Command, timeout: Duration) -> Result<String, String> {
    let child = cmd
        .spawn()
        .map_err(|e| format!("設定の同期の命令を起こせません: {e}"))?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(Err(e)) => Err(format!("設定の同期の命令の結果を読めません: {e}")),
        Err(_) => {
            // 子を止めれば、待っているスレッドも終わる。
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            Err(format!(
                "設定の同期の命令が {} 秒以内に終わりませんでした。",
                timeout.as_secs()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(json: &str) -> ApplyPlan {
        // 試験の文は createdAt を省くので、足して読む。
        let mut v: serde_json::Value = serde_json::from_str(json).unwrap();
        v["createdAt"] = serde_json::json!(1_700_000_000_000u64);
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn the_apply_confirm_shows_counts_and_kinds_in_a_fixed_order() {
        let c = apply_confirm(&plan(
            r#"{"counts":{"create":2,"overwrite":1,"delete":0,"conflictRemote":1,"conflictMine":0},
                "byKind":{"skills":2,"claude-md":1,"commands":1,"settings":3},"instructions":0,"exec":[]}"#,
        ));
        assert!(c
            .body
            .contains("新規 2 件、上書き 1 件、競合で相手を採る 1 件"));
        // 0 件のものは出さない。
        assert!(!c.body.contains("削除"));
        assert!(!c.body.contains("手元を残す"));
        assert!(c
            .body
            .contains("種類: CLAUDE.md 1、settings.json の鍵 3、スキル 2、コマンド 1"));
        assert_eq!(c.title, "他の PC の設定を適用しますか");
        assert_eq!((c.ok, c.cancel), ("適用する", "やめる"));
        // 指示もフックも無ければ、警告にしない。控えと戻し方は必ず添える。
        assert!(!c.warn);
        assert!(!c.body.contains("注意"));
        assert!(c.body.contains("控えの世代"));
        assert!(c.body.contains("戻せます"));
    }

    #[test]
    fn instructions_and_hooks_make_it_a_warning_that_names_them() {
        let c = apply_confirm(&plan(
            r#"{"counts":{"create":3},"byKind":{"skills":2,"commands":1},"instructions":3,
                "exec":[{"label":"skills/a/SKILL.md","marks":["hooks"]},{"label":"commands/b.md","marks":["shell","script"]}]}"#,
        ));
        assert!(c.warn);
        assert!(c.body.contains(
            "Claude が読んで実行する指示（スキル、コマンド、エージェント）を 3 件書きます"
        ));
        assert!(c.body.contains("フックやコマンドの実行を含むもの:"));
        assert!(c.body.contains("skills/a/SKILL.md（フック）"));
        assert!(c
            .body
            .contains("commands/b.md（シェルのコマンド実行、スクリプト）"));
    }

    #[test]
    fn instructions_without_marks_still_warn_but_list_nothing() {
        let c = apply_confirm(&plan(
            r#"{"counts":{"create":1},"byKind":{"agents":1},"instructions":1,"exec":[]}"#,
        ));
        assert!(c.warn);
        assert!(c.body.contains("1 件書きます"));
        assert!(!c.body.contains("フックやコマンドの実行を含むもの"));
    }

    #[test]
    fn a_long_exec_list_is_cut_with_the_remaining_count() {
        let exec: Vec<String> = (1..=8)
            .map(|i| format!(r#"{{"label":"skills/s{i}/SKILL.md","marks":["hooks"]}}"#))
            .collect();
        let c = apply_confirm(&plan(&format!(
            r#"{{"counts":{{"create":8}},"byKind":{{"skills":8}},"instructions":8,"exec":[{}]}}"#,
            exec.join(",")
        )));
        assert!(c.body.contains("skills/s5/SKILL.md"));
        assert!(!c.body.contains("skills/s6/SKILL.md"));
        assert!(c.body.contains("ほか 3 件"));
    }

    #[test]
    fn the_restore_confirm_lists_files_and_says_it_can_be_undone() {
        let c = restore_confirm(&RestorePlan {
            name: "20261010-120000".to_string(),
            restore: (1..=10).map(|i| format!("commands/c{i}.md")).collect(),
            remove: vec!["skills/x/SKILL.md".to_string()],
        });
        assert!(c
            .body
            .contains("控えの世代 20261010-120000 の時点へ戻します"));
        assert!(c.body.contains("書き戻すファイル:\n  commands/c1.md"));
        assert!(c.body.contains("ほか 2 件"));
        assert!(c
            .body
            .contains("その時点で無かったので消すファイル:\n  skills/x/SKILL.md"));
        assert!(c.body.contains("取り消せます"));
        assert_eq!((c.ok, c.cancel, c.warn), ("戻す", "やめる", false));
    }

    #[test]
    fn replies_are_read_from_the_last_json_line() {
        let ok: Result<ApplyPlan, Failure> = parse_reply("ログ\n{\"ok\":true,\"plan\":{\"createdAt\":42,\"counts\":{\"create\":1},\"byKind\":{}}}\n", "plan");
        let ok = ok.unwrap();
        assert_eq!((ok.created_at, ok.counts.create), (42, 1));
        let failed: Result<ApplyPlan, Failure> = parse_reply(
            "{\"ok\":false,\"code\":\"no-order\",\"message\":\"適用の指示書がありません\"}\n",
            "plan",
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
            let r: Result<ApplyPlan, Failure> = parse_reply(bad, "plan");
            assert_eq!(r.unwrap_err().code, "unreadable", "{bad}");
        }
    }

    #[test]
    fn outcomes_read_naturally_and_a_missing_order_is_not_a_failure() {
        let applied = Outcome::applied(&ApplyResult {
            generation: Some("20261010-120000".to_string()),
            written: 2,
            removed: 1,
            kept_mine: 0,
        });
        assert_eq!(applied.status, "applied");
        assert!(applied.message.contains("書き込み 2 件、削除 1 件"));
        assert!(applied.message.contains("20261010-120000"));
        assert_eq!(applied.generation.as_deref(), Some("20261010-120000"));
        let restored = Outcome::restored(&RestoreResult {
            restored: vec!["a".into()],
            removed: vec![],
            safety: Some("20261010-120100".to_string()),
        });
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
        assert_eq!(
            args,
            ["/s/server/cli.mjs", "config", "apply", "--plan", "--json"]
        );
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
            )
            .unwrap();
            let r: Result<ApplyPlan, Failure> = parse_reply(&out, "plan");
            assert_eq!(r.unwrap_err().code, "no-order");
        }

        #[test]
        fn a_cli_that_takes_too_long_is_stopped() {
            let dir = tempfile::tempdir().unwrap();
            let node = fake_node(dir.path(), "sleep 30");
            let err = run_cli(
                cli_command(&node, dir.path(), dir.path(), &[]),
                Duration::from_millis(300),
            )
            .unwrap_err();
            assert!(err.contains("以内に終わりませんでした"));
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
            )
            .unwrap_err();
            assert!(err.contains("起こせません"));
        }
    }
}
