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

/// 種類の並べ方。名前は `Words::kinds` に同じ順で持つ。
const KIND_KEYS: [&str; 7] = [
    "claude-md",
    "settings",
    "keybindings",
    "skills",
    "commands",
    "agents",
    "memory",
];

/// 殻が出す設定の同期の文。言語は殻の頁と同じく `bootfail::page_language` で決め、`words` で引く。
/// 日本語の名前は CLI（packages/cli/src/config.ts の KIND_LABEL）と同じ言い方、英語は UI の辞書（configSyncUi）と同じ言い方にする。
/// 文の中の `{n}` などは、出すときに値へ置き換える。
/// CLI が返す失敗の文（`Failure::message`）は CLI の文なので、ここでは訳さない。
pub struct Words {
    kinds: [&'static str; 7],
    /// フック、コマンド実行、スクリプトの印の名前。
    marks: [&'static str; 3],
    /// 新規、上書き、削除、競合で相手を採る、競合で手元を残す。
    counts: [&'static str; 5],
    /// 件数の 1 つ。`{word}` と `{n}`。
    count: &'static str,
    sep: &'static str,
    /// 項目の後ろに印を添える括弧。
    open: &'static str,
    close: &'static str,
    apply_lead: &'static str,
    kinds_line: &'static str,
    /// 実行される指示の件数。1 件のときと、ほか。
    caution: [&'static str; 2],
    exec_head: &'static str,
    more: &'static str,
    apply_backup: &'static str,
    apply_title: &'static str,
    apply_ok: &'static str,
    cancel: &'static str,
    restore_lead: &'static str,
    restore_files: &'static str,
    restore_remove: &'static str,
    restore_note: &'static str,
    restore_title: &'static str,
    restore_ok: &'static str,
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
    pub apply_cancelled: &'static str,
    pub restore_cancelled: &'static str,
    pub bad_generation: &'static str,
    pub apply_stopped: &'static str,
    pub restore_stopped: &'static str,
}

// CI の rustfmt は日本語の幅を手元と違って数えるので、文の表は整形を止めて書いたままにする。
#[rustfmt::skip]
const JA: Words = Words {
    kinds: ["CLAUDE.md", "settings.json の鍵", "keybindings.json", "スキル", "コマンド", "エージェント", "メモリ"],
    marks: ["フック", "シェルのコマンド実行", "スクリプト"],
    counts: ["新規", "上書き", "削除", "競合で相手を採る", "競合で手元を残す"],
    count: "{word} {n} 件",
    sep: "、",
    open: "（",
    close: "）",
    apply_lead: "他の PC から届いた設定を、このパソコンの Claude Code の設定フォルダ（~/.claude）に書きます。\n",
    kinds_line: "種類: {kinds}",
    caution: [
        "注意: Claude が読んで実行する指示（スキル、コマンド、エージェント）を {n} 件書きます。",
        "注意: Claude が読んで実行する指示（スキル、コマンド、エージェント）を {n} 件書きます。",
    ],
    exec_head: "このうち、フックやコマンドの実行を含むもの:",
    more: "ほか {n} 件",
    apply_backup: "書く前に、元の中身を控えの世代に取ります。あとから設定の「この世代に戻す」で戻せます。",
    apply_title: "他の PC の設定を適用しますか",
    apply_ok: "適用する",
    cancel: "やめる",
    restore_lead: "控えの世代 {name} の時点へ戻します。",
    restore_files: "書き戻すファイル:",
    restore_remove: "その時点で無かったので消すファイル:",
    restore_note: "その世代のあとで手元で変えた内容も、世代の時点へ戻ります。戻す前の状態は新しい世代に控えるので、戻しも取り消せます。",
    restore_title: "この世代へ戻しますか",
    restore_ok: "戻す",
    unreadable: "設定の同期の命令の返事を読めませんでした。~/.agent-hangar/desktop.log か、端末で hangar config apply を確かめてください。",
    applied: "適用しました（書き込み {written} 件、削除 {removed} 件、手元を残す {kept} 件）。",
    applied_generation: "控えの世代 {g} から戻せます。",
    restored: "戻しました（書き戻し {restored} 件、消去 {removed} 件）。",
    restored_safety: "戻す前の状態を世代 {g} に控えました。",
    cannot_start: "設定の同期の命令を起こせません: {e}",
    cannot_read: "設定の同期の命令の結果を読めません: {e}",
    too_long: "設定の同期の命令が {s} 秒以内に終わりませんでした。",
    apply_flow_title: "設定の適用",
    restore_flow_title: "設定を世代へ戻す",
    busy: "設定の確認がすでに出ています。",
    apply_cancelled: "適用しませんでした。指示書はそのまま残しています。",
    restore_cancelled: "戻しませんでした。",
    bad_generation: "世代の名前が正しくありません。",
    apply_stopped: "設定の適用の処理が止まりました。",
    restore_stopped: "設定を戻す処理が止まりました。",
};

#[rustfmt::skip]
const EN: Words = Words {
    kinds: ["CLAUDE.md", "settings.json keys", "keybindings.json", "skills", "commands", "agents", "memory"],
    marks: ["hooks", "shell commands", "script"],
    counts: ["New", "Overwrite", "Delete", "Conflict, take the other computer's", "Conflict, keep this computer's"],
    count: "{word}: {n}",
    sep: ", ",
    open: " (",
    close: ")",
    apply_lead: "Writes the settings that came from other computers to the Claude Code settings folder (~/.claude) on this computer.\n",
    kinds_line: "Kinds: {kinds}",
    caution: [
        "Caution: this writes {n} instruction that Claude reads and runs (skills, commands and agents).",
        "Caution: this writes {n} instructions that Claude reads and runs (skills, commands and agents).",
    ],
    exec_head: "Of these, the ones with hooks or commands that run:",
    more: "and {n} more",
    apply_backup: "Before writing, the current contents are saved as a backup generation. You can go back with Restore this generation in Settings.",
    apply_title: "Apply settings from other computers?",
    apply_ok: "Apply",
    cancel: "Cancel",
    restore_lead: "Restores the files to backup generation {name}.",
    restore_files: "Files to write back:",
    restore_remove: "Files to delete because they did not exist then:",
    restore_note: "Changes made on this computer after that generation are reverted too. The current state is saved as a new generation first, so the restore can be undone.",
    restore_title: "Restore this generation?",
    restore_ok: "Restore",
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
    apply_cancelled: "Not applied. The order is kept as it is.",
    restore_cancelled: "Not restored.",
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

fn mark_name<'a>(w: &Words, mark: &'a str) -> &'a str {
    match mark {
        "hooks" => w.marks[0],
        "shell" => w.marks[1],
        "script" => w.marks[2],
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

fn counts_line(w: &Words, c: &Counts) -> String {
    let mut parts = Vec::new();
    let all = [
        c.create,
        c.overwrite,
        c.delete,
        c.conflict_remote,
        c.conflict_mine,
    ];
    for (n, word) in all.into_iter().zip(w.counts) {
        if n > 0 {
            parts.push(
                w.count
                    .replace("{word}", word)
                    .replace("{n}", &n.to_string()),
            );
        }
    }
    parts.join(w.sep)
}

fn kinds_line(w: &Words, by_kind: &HashMap<String, u32>) -> String {
    KIND_KEYS
        .iter()
        .zip(w.kinds)
        .filter_map(|(key, name)| {
            by_kind
                .get(*key)
                .filter(|n| **n > 0)
                .map(|n| format!("{name} {n}"))
        })
        .collect::<Vec<_>>()
        .join(w.sep)
}

/// 適用の確認の文。件数、種類、実行される指示とフックやコマンド実行を含む項目、控えと戻し方の順に並べる。
pub fn apply_confirm(plan: &ApplyPlan, lang: &str) -> Confirm {
    let w = words(lang);
    let mut body = String::from(w.apply_lead);
    body.push_str(&format!("\n{}", counts_line(w, &plan.counts)));
    let kinds = kinds_line(w, &plan.by_kind);
    if !kinds.is_empty() {
        body.push('\n');
        body.push_str(&w.kinds_line.replace("{kinds}", &kinds));
    }
    let warn = plan.instructions > 0 || !plan.exec.is_empty();
    if warn {
        let caution = w.caution[usize::from(plan.instructions != 1)];
        body.push_str("\n\n");
        body.push_str(&caution.replace("{n}", &plan.instructions.to_string()));
    }
    if !plan.exec.is_empty() {
        body.push('\n');
        body.push_str(w.exec_head);
        for item in plan.exec.iter().take(LISTED_EXEC) {
            let marks: Vec<&str> = item.marks.iter().map(|m| mark_name(w, m)).collect();
            let marks = marks.join(w.sep);
            body.push_str(&format!("\n  {}{}{marks}{}", item.label, w.open, w.close));
        }
        if plan.exec.len() > LISTED_EXEC {
            let rest = (plan.exec.len() - LISTED_EXEC).to_string();
            body.push_str(&format!("\n  {}", w.more.replace("{n}", &rest)));
        }
    }
    body.push_str("\n\n");
    body.push_str(w.apply_backup);
    Confirm {
        title: w.apply_title.to_string(),
        body,
        ok: w.apply_ok,
        cancel: w.cancel,
        warn,
    }
}

/// 世代へ戻す確認の文。
pub fn restore_confirm(plan: &RestorePlan, lang: &str) -> Confirm {
    let w = words(lang);
    let mut body = w.restore_lead.replace("{name}", &plan.name);
    let list = |body: &mut String, head: &str, files: &[String]| {
        if files.is_empty() {
            return;
        }
        body.push_str(&format!("\n\n{head}"));
        for f in files.iter().take(LISTED_FILES) {
            body.push_str(&format!("\n  {f}"));
        }
        if files.len() > LISTED_FILES {
            let rest = (files.len() - LISTED_FILES).to_string();
            body.push_str(&format!("\n  {}", w.more.replace("{n}", &rest)));
        }
    };
    list(&mut body, w.restore_files, &plan.restore);
    list(&mut body, w.restore_remove, &plan.remove);
    body.push_str("\n\n");
    body.push_str(w.restore_note);
    Confirm {
        title: w.restore_title.to_string(),
        body,
        ok: w.restore_ok,
        cancel: w.cancel,
        warn: false,
    }
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
}

impl Outcome {
    pub fn simple(status: &'static str, message: impl Into<String>) -> Self {
        Outcome {
            status,
            message: message.into(),
            generation: None,
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

    fn plan(json: &str) -> ApplyPlan {
        // 試験の文は createdAt を省くので、足して読む。
        let mut v: serde_json::Value = serde_json::from_str(json).unwrap();
        v["createdAt"] = serde_json::json!(1_700_000_000_000u64);
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn the_apply_confirm_shows_counts_and_kinds_in_a_fixed_order() {
        let c = apply_confirm(
            &plan(
                r#"{"counts":{"create":2,"overwrite":1,"delete":0,"conflictRemote":1,"conflictMine":0},
                "byKind":{"skills":2,"claude-md":1,"commands":1,"settings":3},"instructions":0,"exec":[]}"#,
            ),
            "ja",
        );
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
        let c = apply_confirm(
            &plan(
                r#"{"counts":{"create":3},"byKind":{"skills":2,"commands":1},"instructions":3,
                "exec":[{"label":"skills/a/SKILL.md","marks":["hooks"]},{"label":"commands/b.md","marks":["shell","script"]}]}"#,
            ),
            "ja",
        );
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
        let c = apply_confirm(
            &plan(r#"{"counts":{"create":1},"byKind":{"agents":1},"instructions":1,"exec":[]}"#),
            "ja",
        );
        assert!(c.warn);
        assert!(c.body.contains("1 件書きます"));
        assert!(!c.body.contains("フックやコマンドの実行を含むもの"));
    }

    #[test]
    fn a_long_exec_list_is_cut_with_the_remaining_count() {
        let exec: Vec<String> = (1..=8)
            .map(|i| format!(r#"{{"label":"skills/s{i}/SKILL.md","marks":["hooks"]}}"#))
            .collect();
        let c = apply_confirm(
            &plan(&format!(
                r#"{{"counts":{{"create":8}},"byKind":{{"skills":8}},"instructions":8,"exec":[{}]}}"#,
                exec.join(",")
            )),
            "ja",
        );
        assert!(c.body.contains("skills/s5/SKILL.md"));
        assert!(!c.body.contains("skills/s6/SKILL.md"));
        assert!(c.body.contains("ほか 3 件"));
    }

    #[test]
    fn the_restore_confirm_lists_files_and_says_it_can_be_undone() {
        let c = restore_confirm(
            &RestorePlan {
                name: "20261010-120000".to_string(),
                restore: (1..=10).map(|i| format!("commands/c{i}.md")).collect(),
                remove: vec!["skills/x/SKILL.md".to_string()],
            },
            "ja",
        );
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
    fn the_confirms_and_outcomes_are_english_in_english() {
        let c = apply_confirm(
            &plan(
                r#"{"counts":{"create":2,"overwrite":1},"byKind":{"skills":2,"settings":1},"instructions":1,
                "exec":[{"label":"skills/a/SKILL.md","marks":["hooks","shell"]}]}"#,
            ),
            "en",
        );
        assert_eq!(c.title, "Apply settings from other computers?");
        assert_eq!((c.ok, c.cancel), ("Apply", "Cancel"));
        assert!(c.body.contains("New: 2, Overwrite: 1"), "{}", c.body);
        assert!(
            c.body.contains("Kinds: settings.json keys 1, skills 2"),
            "{}",
            c.body
        );
        assert!(c.body.contains("writes 1 instruction that"), "{}", c.body);
        assert!(
            c.body.contains("skills/a/SKILL.md (hooks, shell commands)"),
            "{}",
            c.body
        );
        assert!(!has_japanese(&c.body), "{}", c.body);
        let r = restore_confirm(
            &RestorePlan {
                name: "20261010-120000".to_string(),
                restore: (1..=10).map(|i| format!("commands/c{i}.md")).collect(),
                remove: vec!["skills/x/SKILL.md".to_string()],
            },
            "en",
        );
        assert_eq!(
            (r.title.as_str(), r.ok, r.cancel),
            ("Restore this generation?", "Restore", "Cancel")
        );
        assert!(r.body.contains("and 2 more"), "{}", r.body);
        assert!(!has_japanese(&r.body), "{}", r.body);
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
            words("en").apply_cancelled,
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
            assert!(err.contains("以内に終わりませんでした"));
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
            assert!(err.contains("起こせません"));
        }
    }
}
