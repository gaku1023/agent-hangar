//! 利用者のファイルへの書き込みを承諾する窓（承諾のダイアログ）の、殻の側。
//!
//! 連携（MCP の登録、シェル連携、ステータスライン）と、設定の同期の適用と世代へ戻す操作は、
//! どれも利用者のファイル（`~/.claude.json`、`~/.zshrc`、ステータスラインのスクリプト、`~/.claude`）を書く。
//! 書くのは殻の命令と CLI だけで、サーバは書かない（全体計画の D9）。
//!
//! 流れは次のとおりである。
//! 1. 頁（サーバの UI）が殻の命令を呼ぶ。頁から受け取るのは、決まった対象の名前（と世代の名前）だけである。
//! 2. 殻が CLI に見立て（`--dry-run --json`、設定の同期は `--plan --json`）を出させる。
//! 3. 殻が自分の窓（`approve`。サーバを通らない、殻に同梱した頁 `loading/approve.html`）を開き、見立てを見せる。
//! 4. 利用者がその窓で「書き込み」を押したときだけ、殻が CLI の `--yes --json --expect <指紋>` を走らせる。
//!    CLI は書く直前に見立てを作り直し、指紋が違えば何も書かずに `changed` で断る。
//!
//! 承諾の窓の命令（`approve_view`、`approve_answer`）は、`approve` の窓の、殻に同梱した頁にだけ許す（capabilities/approve.json）。
//! サーバの頁（main の窓）からは呼べないので、HTTP の API に穴が開いても、押されずに書かれることは無い。
//! ここには、対象の名前の確かめ、CLI の引数の組み立て、見立ての読み取り、頁へ渡す材料の組み立てだけを置き、
//! 窓を開く、CLI を走らせる、といった殻の動きは lib.rs に置く。

use crate::configapply::{ApplyResult, Failure, Outcome, RestoreResult};
use serde_json::{json, Value};
use std::sync::mpsc;

/// 承諾の窓の名前（Tauri の窓のラベル）。capabilities/approve.json の windows と同じにする。
pub const LABEL: &str = "approve";

/// 承諾の窓に出す頁。殻に同梱した読み込み画面と同じ置き場（loading/）にある。
pub const PAGE: &str = "approve.html";

/// 頁から受け取れる連携の対象。CLI の setupPlan.ts の SETUP_TARGETS と同じ並びにする（config.test.ts が突き合わせる）。
pub const SETUP_TARGETS: [&str; 6] = [
    "mcp-install",
    "mcp-uninstall",
    "shell-install",
    "shell-uninstall",
    "statusline-install",
    "statusline-uninstall",
];

/// 頁から来た対象の名前を、決まった一覧の中の名前に直す。一覧に無ければ None。
pub fn setup_target(s: &str) -> Option<&'static str> {
    SETUP_TARGETS.iter().copied().find(|t| *t == s)
}

/// 承諾を求める仕事。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Job {
    /// 連携の書き込み。中身は SETUP_TARGETS の 1 つ。
    Setup(&'static str),
    /// 設定の同期の、適用の指示書の適用。
    Apply,
    /// 設定の同期の、控えの世代へ戻す。中身は世代の名前（`configapply::valid_generation_name` で確かめたもの）。
    Restore(String),
}

impl Job {
    /// 頁へ渡す対象の名前。
    pub fn target(&self) -> &str {
        match self {
            Job::Setup(t) => t,
            Job::Apply => "apply",
            Job::Restore(_) => "restore",
        }
    }
}

/// 対象を CLI のサブコマンドの 2 語にする（`mcp-install` は `mcp install`）。
fn setup_words(target: &str) -> (&str, &str) {
    target.split_once('-').unwrap_or((target, ""))
}

/// `--port` を受け取る対象。殻のサーバのポートを渡す（MCP の URL とステータスラインの宛先に埋め込まれる）。
fn takes_port(target: &str) -> bool {
    target == "mcp-install" || target == "statusline-install"
}

/// 見立てを出させる CLI の引数。何も書かない。
pub fn plan_args(job: &Job, port: u16) -> Vec<String> {
    let mut v: Vec<String> = match job {
        Job::Setup(t) => {
            let (a, b) = setup_words(t);
            let mut v = vec![
                a.to_string(),
                b.to_string(),
                "--dry-run".into(),
                "--json".into(),
            ];
            if takes_port(t) {
                v.extend(["--port".to_string(), port.to_string()]);
            }
            v
        }
        Job::Apply => vec![
            "config".into(),
            "apply".into(),
            "--plan".into(),
            "--json".into(),
        ],
        Job::Restore(name) => vec![
            "config".into(),
            "restore".into(),
            name.clone(),
            "--plan".into(),
            "--json".into(),
        ],
    };
    v.shrink_to_fit();
    v
}

/// 指紋として受け取れる形か。sha256 の 16 進 64 桁だけにする（CLI へ渡す値なので、引数に見える形を通さない）。
pub fn valid_fingerprint(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// 承諾された後に走らせる CLI の引数。見立ての指紋（と適用は指示書の作成時刻）を添え、見せた後に変わっていたら CLI が断る。
/// 見立ての形が読めなければ None（書かない）。
pub fn write_args(job: &Job, plan: &Value, port: u16) -> Option<Vec<String>> {
    let fp = plan.get("fingerprint")?.as_str()?;
    if !valid_fingerprint(fp) {
        return None;
    }
    let tail = [
        "--yes".to_string(),
        "--json".into(),
        "--expect".into(),
        fp.to_string(),
    ];
    Some(match job {
        Job::Setup(t) => {
            let (a, b) = setup_words(t);
            let mut v = vec![a.to_string(), b.to_string()];
            v.extend(tail);
            if takes_port(t) {
                v.extend(["--port".to_string(), port.to_string()]);
            }
            v
        }
        Job::Apply => {
            let order = plan.get("createdAt")?.as_u64()?;
            let mut v = vec!["config".to_string(), "apply".into()];
            v.extend(tail);
            v.extend(["--order".to_string(), order.to_string()]);
            v
        }
        Job::Restore(name) => {
            let mut v = vec!["config".to_string(), "restore".into(), name.clone()];
            v.extend(tail);
            v
        }
    })
}

/// 見立ての状態。設定の同期の見立ては、書けない時は CLI が ok: false で返すので、いつも Ready である。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanState {
    Ready,
    /// もう済んでいる（登録済み、入っていない、など）。code は理由の鍵、message は CLI の文。
    Noop {
        code: String,
        message: String,
    },
    /// この PC では書けない（Windows のシェル連携、スクリプトが無い、など）。
    Blocked {
        code: String,
        message: String,
    },
}

pub fn plan_state(plan: &Value) -> PlanState {
    let reason = || {
        let r = plan.get("reason");
        let code = r
            .and_then(|r| r.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let message = r
            .and_then(|r| r.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        (code, message)
    };
    match plan.get("state").and_then(Value::as_str) {
        Some("noop") => {
            let (code, message) = reason();
            PlanState::Noop { code, message }
        }
        Some("blocked") => {
            let (code, message) = reason();
            PlanState::Blocked { code, message }
        }
        _ => PlanState::Ready,
    }
}

/// 窓の段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Confirm,
    Writing,
    Done,
    Fail,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Confirm => "confirm",
            Stage::Writing => "writing",
            Stage::Done => "done",
            Stage::Fail => "fail",
        }
    }
}

/// 開いている承諾の窓 1 つ分の状態。窓は同時に 1 つだけで、殻の AppState が持つ。
pub struct Session {
    pub job: Job,
    pub plan: Value,
    pub stage: Stage,
    pub lang: &'static str,
    /// 書いた結果（CLI の result）。
    pub result: Option<Value>,
    /// 書けなかった理由。
    pub failure: Option<Failure>,
    /// 頁の命令へ結果を返す口。1 度だけ送る。
    outcome: Option<mpsc::Sender<Outcome>>,
    /// 書いている最中に窓が閉じられた。書き終わったところで片付ける。
    pub closed: bool,
}

impl Session {
    pub fn new(job: Job, plan: Value, lang: &'static str, outcome: mpsc::Sender<Outcome>) -> Self {
        Session {
            job,
            plan,
            stage: Stage::Confirm,
            lang,
            result: None,
            failure: None,
            outcome: Some(outcome),
            closed: false,
        }
    }

    /// 結果を頁の命令へ返す。2 度目からは何もしない。
    pub fn finish(&mut self, o: Outcome) {
        if let Some(tx) = self.outcome.take() {
            let _ = tx.send(o);
        }
    }

    /// 書けなかった。窓は失敗の段にし、結果は窓が閉じたときに返す（読み直してから書くこともできるため）。
    pub fn fail(&mut self, f: Failure) {
        self.stage = Stage::Fail;
        self.failure = Some(f);
    }

    /// 書いた結果を受け取る。書けたら完了の段にして、すぐ結果を返す（頁の札がすぐ変わる）。
    pub fn written(&mut self, reply: Result<Value, Failure>) {
        match reply {
            Ok(r) => {
                let o = self.done_outcome(&r);
                self.stage = Stage::Done;
                self.result = Some(r);
                self.failure = None;
                self.finish(o);
            }
            Err(f) => self.fail(f),
        }
    }

    /// 見立てを出させ直した結果を受け取る。書けるなら確認の段へ戻し、済んでいるか書けなければ、その理由を失敗の段に出す。
    pub fn replan(&mut self, reply: Result<Value, Failure>) {
        match reply {
            Ok(plan) => match plan_state(&plan) {
                PlanState::Ready => {
                    self.plan = plan;
                    self.stage = Stage::Confirm;
                    self.failure = None;
                }
                PlanState::Noop { code, message } | PlanState::Blocked { code, message } => {
                    self.fail(Failure { code, message })
                }
            },
            Err(f) => self.fail(f),
        }
    }

    /// まだ結果を返していないか。
    pub fn waiting(&self) -> bool {
        self.outcome.is_some()
    }

    /// 窓が閉じたときの結果。書けなかった理由があればそれを、無ければ取り消しを返す。
    pub fn closed_outcome(&self) -> Outcome {
        let w = words(self.lang);
        match &self.failure {
            Some(f) => Outcome {
                code: Some(f.code.clone()),
                ..Outcome::simple("failed", f.message.clone())
            },
            None => Outcome::simple("cancelled", w.cancelled),
        }
    }

    /// 書けたときの結果。設定の同期は今までどおり applied と restored、連携は written を返す。
    pub fn done_outcome(&self, result: &Value) -> Outcome {
        let w = words(self.lang);
        match &self.job {
            Job::Setup(_) => {
                let changed = result
                    .get("changed")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                Outcome::simple(if changed { "written" } else { "none" }, w.written)
            }
            Job::Apply => {
                let r: ApplyResult =
                    serde_json::from_value(result.clone()).unwrap_or(ApplyResult {
                        generation: None,
                        written: 0,
                        removed: 0,
                        kept_mine: 0,
                    });
                Outcome::applied(&r, self.lang)
            }
            Job::Restore(_) => {
                let r: RestoreResult =
                    serde_json::from_value(result.clone()).unwrap_or(RestoreResult {
                        restored: vec![],
                        removed: vec![],
                        safety: None,
                    });
                Outcome::restored(&r, self.lang)
            }
        }
    }

    /// 頁（loading/approve.js）へ渡す材料。文は頁が自分の表から作る。殻は種類と CLI の見立てをそのまま渡す。
    pub fn view(&self, home: &str, hangar_home: &str, windows: bool) -> Value {
        let name = match &self.job {
            Job::Restore(n) => Some(n.clone()),
            _ => None,
        };
        json!({
            "lang": self.lang,
            "job": match self.job { Job::Setup(_) => "setup", Job::Apply => "apply", Job::Restore(_) => "restore" },
            "target": self.job.target(),
            "name": name,
            "stage": self.stage.name(),
            "plan": self.plan,
            "result": self.result,
            "failure": self.failure.as_ref().map(|f| json!({ "code": f.code, "message": f.message })),
            "home": home,
            "hangarHome": hangar_home,
            "windows": windows,
        })
    }
}

/// 殻が出す、承諾の窓まわりの文。頁の文は頁（loading/approve.js）が持つ。
pub struct Words {
    /// 窓の題。
    pub window_title: &'static str,
    pub cancelled: &'static str,
    pub written: &'static str,
    pub busy: &'static str,
    pub stopped: &'static str,
    pub cannot_open: &'static str,
    pub unreadable: &'static str,
}

#[rustfmt::skip]
const JA: Words = Words {
    window_title: "書き込みの確認",
    cancelled: "書きませんでした。",
    written: "書き込みました。",
    busy: "書き込みの確認がすでに出ています。",
    stopped: "書き込みの処理が止まりました。",
    cannot_open: "書き込みの確認の窓を開けませんでした。",
    unreadable: "書く中身を読めなかったので、書きませんでした。",
};

#[rustfmt::skip]
const EN: Words = Words {
    window_title: "Confirm changes",
    cancelled: "Nothing was written.",
    written: "Written.",
    busy: "A confirmation is already open.",
    stopped: "Writing stopped.",
    cannot_open: "Could not open the confirmation window.",
    unreadable: "Could not read what to write, so nothing was written.",
};

pub fn words(lang: &str) -> &'static Words {
    if lang == "en" {
        &EN
    } else {
        &JA
    }
}

/// 窓の頁が「読み直す」以外で移ってよい URL か。殻に同梱した頁（macOS は tauri://、Windows は http://tauri.localhost）だけにする。
pub fn allowed_navigation(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn only_the_fixed_targets_are_accepted() {
        assert_eq!(setup_target("mcp-install"), Some("mcp-install"));
        assert_eq!(
            setup_target("statusline-uninstall"),
            Some("statusline-uninstall")
        );
        assert_eq!(setup_target("config-apply"), None);
        assert_eq!(setup_target("mcp-install --yes"), None);
        assert_eq!(setup_target(""), None);
    }

    #[test]
    fn plan_args_never_write() {
        assert_eq!(
            plan_args(&Job::Setup("mcp-install"), 4177),
            ["mcp", "install", "--dry-run", "--json", "--port", "4177"]
        );
        assert_eq!(
            plan_args(&Job::Setup("shell-uninstall"), 4177),
            ["shell", "uninstall", "--dry-run", "--json"]
        );
        assert_eq!(
            plan_args(&Job::Apply, 4177),
            ["config", "apply", "--plan", "--json"]
        );
        assert_eq!(
            plan_args(&Job::Restore("20261011-210400".into()), 4177),
            ["config", "restore", "20261011-210400", "--plan", "--json"]
        );
        for job in [Job::Setup("statusline-install"), Job::Apply] {
            assert!(!plan_args(&job, 4177).iter().any(|a| a == "--yes"));
        }
    }

    #[test]
    fn write_args_carry_the_fingerprint_and_refuse_odd_ones() {
        let plan = json!({ "fingerprint": FP, "createdAt": 1_700_000_000_000u64 });
        assert_eq!(
            write_args(&Job::Setup("statusline-install"), &plan, 4177).unwrap(),
            [
                "statusline",
                "install",
                "--yes",
                "--json",
                "--expect",
                FP,
                "--port",
                "4177"
            ]
        );
        assert_eq!(
            write_args(&Job::Apply, &plan, 4177).unwrap(),
            [
                "config",
                "apply",
                "--yes",
                "--json",
                "--expect",
                FP,
                "--order",
                "1700000000000"
            ]
        );
        assert_eq!(
            write_args(&Job::Restore("20261011-210400".into()), &plan, 4177).unwrap(),
            [
                "config",
                "restore",
                "20261011-210400",
                "--yes",
                "--json",
                "--expect",
                FP
            ]
        );
        // 指紋が無い、形が違う、引数に見えるものは書かない。
        assert!(write_args(&Job::Setup("mcp-install"), &json!({}), 4177).is_none());
        assert!(write_args(
            &Job::Setup("mcp-install"),
            &json!({ "fingerprint": "--yes" }),
            4177
        )
        .is_none());
        assert!(write_args(
            &Job::Setup("mcp-install"),
            &json!({ "fingerprint": FP.to_uppercase() }),
            4177
        )
        .is_none());
        assert!(write_args(&Job::Apply, &json!({ "fingerprint": FP }), 4177).is_none());
    }

    #[test]
    fn plan_state_reads_noop_and_blocked() {
        assert_eq!(plan_state(&json!({ "state": "ready" })), PlanState::Ready);
        assert_eq!(plan_state(&json!({ "counts": {} })), PlanState::Ready);
        assert_eq!(
            plan_state(
                &json!({ "state": "noop", "reason": { "code": "already", "message": "m" } })
            ),
            PlanState::Noop {
                code: "already".into(),
                message: "m".into()
            }
        );
        assert_eq!(
            plan_state(
                &json!({ "state": "blocked", "reason": { "code": "windows", "message": "w" } })
            ),
            PlanState::Blocked {
                code: "windows".into(),
                message: "w".into()
            }
        );
    }

    #[test]
    fn a_session_answers_once_and_closing_after_a_failure_reports_it() {
        let (tx, rx) = mpsc::channel();
        let mut s = Session::new(Job::Setup("mcp-install"), json!({}), "ja", tx);
        assert!(s.waiting());
        s.failure = Some(Failure {
            code: "changed".into(),
            message: "変わりました".into(),
        });
        let o = s.closed_outcome();
        assert_eq!((o.status, o.code.as_deref()), ("failed", Some("changed")));
        s.finish(o);
        s.finish(Outcome::simple("written", "x"));
        assert!(!s.waiting());
        assert_eq!(rx.try_iter().count(), 1);
        let (tx, _rx) = mpsc::channel();
        let s = Session::new(Job::Apply, json!({}), "en", tx);
        assert_eq!(s.closed_outcome().status, "cancelled");
        assert_eq!(s.closed_outcome().message, "Nothing was written.");
    }

    #[test]
    fn done_outcomes_keep_the_config_sync_statuses() {
        let (tx, _rx) = mpsc::channel();
        let s = Session::new(Job::Apply, json!({}), "ja", tx);
        let o = s.done_outcome(
            &json!({ "generation": "20261012-104002", "written": 2, "removed": 0, "keptMine": 0 }),
        );
        assert_eq!(
            (o.status, o.generation.as_deref()),
            ("applied", Some("20261012-104002"))
        );
        let (tx, _rx) = mpsc::channel();
        let s = Session::new(Job::Setup("shell-install"), json!({}), "ja", tx);
        assert_eq!(
            s.done_outcome(&json!({ "changed": true, "backups": [] }))
                .status,
            "written"
        );
        assert_eq!(
            s.done_outcome(&json!({ "changed": false, "backups": [] }))
                .status,
            "none"
        );
    }

    #[test]
    fn writing_then_failing_waits_for_the_close_and_a_success_answers_at_once() {
        let (tx, rx) = mpsc::channel();
        let mut s = Session::new(
            Job::Setup("shell-install"),
            json!({ "state": "ready" }),
            "ja",
            tx,
        );
        s.written(Err(Failure {
            code: "changed".into(),
            message: "m".into(),
        }));
        assert_eq!(s.stage, Stage::Fail);
        assert!(rx.try_recv().is_err());
        // 読み直して、まだ書ける。
        s.replan(Ok(json!({ "state": "ready", "fingerprint": FP })));
        assert_eq!((s.stage, s.failure.is_none()), (Stage::Confirm, true));
        s.written(Ok(json!({ "changed": true, "backups": ["/b"] })));
        assert_eq!(s.stage, Stage::Done);
        assert_eq!(rx.try_recv().unwrap().status, "written");
        // 読み直したら済んでいた。
        let (tx, _rx) = mpsc::channel();
        let mut s = Session::new(Job::Setup("mcp-uninstall"), json!({}), "ja", tx);
        s.replan(Ok(
            json!({ "state": "noop", "reason": { "code": "absent", "message": "m" } }),
        ));
        assert_eq!(
            (s.stage, s.failure.as_ref().unwrap().code.as_str()),
            (Stage::Fail, "absent")
        );
    }

    #[test]
    fn the_view_carries_the_plan_and_the_stage() {
        let (tx, _rx) = mpsc::channel();
        let s = Session::new(
            Job::Restore("20261011-210400".into()),
            json!({ "fingerprint": FP }),
            "ja",
            tx,
        );
        let v = s.view("/home/u", "/home/u/.agent-hangar", false);
        assert_eq!(v["job"], "restore");
        assert_eq!(v["target"], "restore");
        assert_eq!(v["name"], "20261011-210400");
        assert_eq!(v["stage"], "confirm");
        assert_eq!(v["plan"]["fingerprint"], FP);
        assert_eq!(v["failure"], Value::Null);
    }

    #[test]
    fn the_window_only_navigates_within_the_bundled_pages() {
        let ok = |s: &str| allowed_navigation(&url::Url::parse(s).unwrap());
        assert!(ok("tauri://localhost/approve.html"));
        assert!(ok("http://tauri.localhost/approve.html"));
        assert!(!ok("http://127.0.0.1:4177/"));
        assert!(!ok("https://example.com/"));
        assert!(!ok("file:///etc/passwd"));
    }
}
