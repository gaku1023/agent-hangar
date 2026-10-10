//! アプリの自動更新（段 5-4）。
//! 更新は「知らせて、押して入れる」で、勝手には入れない。
//! 頁（UI）が `update_check`、`update_download`、`update_install` を順に呼び、取得の最中は `update_status` で進みを読む。
//! 目録（latest.json）は GitHub の Release の最新から引き、更新物は tauri.conf.json の公開鍵（minisign）で確かめる。
//! ここには、命令の間で持ち回る状態と、頁へ返す形と、失敗の分け方だけを置く。命令そのものは lib.rs にある。

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri_plugin_updater::{Error, Update};

/// 命令の間で持ち回る状態。
/// pending は最後の確認で見つけた版、bytes は取得して署名を確かめ終えた更新物である。
/// done と total は取得の進みで、total の 0 は大きさが分からないことを表す。
#[derive(Default)]
pub struct UpdateSlot {
    pub pending: Mutex<Option<Update>>,
    pub bytes: Mutex<Option<Vec<u8>>>,
    pub progress: Progress,
}

/// 取得の進み。チャンクが届くたびに足し、頁が `update_status` で読む。
#[derive(Default)]
pub struct Progress {
    done: AtomicU64,
    total: AtomicU64,
}

impl Progress {
    pub fn reset(&self) {
        self.done.store(0, Ordering::SeqCst);
        self.total.store(0, Ordering::SeqCst);
    }
    /// 届いたチャンクの長さと、応答の Content-Length（分からなければ None）を足す。
    pub fn record(&self, chunk: usize, total: Option<u64>) {
        self.done.fetch_add(chunk as u64, Ordering::SeqCst);
        if let Some(t) = total {
            self.total.store(t, Ordering::SeqCst);
        }
    }
    /// いまの進み。大きさが分からなければ total は None。
    pub fn snapshot(&self) -> (u64, Option<u64>) {
        let total = self.total.load(Ordering::SeqCst);
        (
            self.done.load(Ordering::SeqCst),
            (total > 0).then_some(total),
        )
    }
}

/// `update_status` の答え。current は動いている版。
#[derive(Serialize, Debug, PartialEq)]
pub struct Status {
    pub current: String,
    pub done: u64,
    pub total: Option<u64>,
}

/// `update_check` の答え。新しい版が無ければ version は None。
#[derive(Serialize, Debug, PartialEq)]
pub struct Found {
    pub version: Option<String>,
}

/// 命令の失敗。kind は頁が文を選ぶための 4 つの分類（network、signature、permission、other）、detail はログ向けの英語の 1 行である。
#[derive(Serialize, Debug, PartialEq)]
pub struct Failure {
    pub kind: &'static str,
    pub detail: String,
}

impl Failure {
    pub fn other(detail: impl Into<String>) -> Self {
        Failure {
            kind: "other",
            detail: detail.into(),
        }
    }
}

impl From<&Error> for Failure {
    fn from(e: &Error) -> Self {
        Failure {
            kind: failure_kind(e),
            detail: e.to_string(),
        }
    }
}

/// updater の誤りを、頁が利用者に言える 4 つに分ける。
/// 目録や更新物を取れない（接続できない、目録が無い、この OS の更新物が無い）は network、
/// 署名が合わない、読めないは signature、管理者の許可を断られた、書けないは permission、ほかは other である。
pub fn failure_kind(e: &Error) -> &'static str {
    match e {
        Error::Reqwest(_)
        | Error::Network(_)
        | Error::Http(_)
        | Error::ReleaseNotFound
        | Error::TargetNotFound(_)
        | Error::TargetsNotFound(_) => "network",
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. } => "signature",
        Error::AuthenticationFailed => "permission",
        Error::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => "permission",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_sorted_into_four_kinds_the_page_can_explain() {
        assert_eq!(failure_kind(&Error::Network("503".into())), "network");
        assert_eq!(failure_kind(&Error::ReleaseNotFound), "network");
        assert_eq!(
            failure_kind(&Error::TargetNotFound("darwin-aarch64".into())),
            "network"
        );
        assert_eq!(failure_kind(&Error::SignatureUtf8("x".into())), "signature");
        assert_eq!(failure_kind(&Error::AuthenticationFailed), "permission");
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(failure_kind(&Error::Io(denied)), "permission");
        let other = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(failure_kind(&Error::Io(other)), "other");
        assert_eq!(failure_kind(&Error::EmptyEndpoints), "other");
    }

    #[test]
    fn a_failure_keeps_the_kind_and_the_message_for_the_log() {
        let f = Failure::from(&Error::ReleaseNotFound);
        assert_eq!(f.kind, "network");
        assert!(f.detail.contains("release JSON"));
        assert_eq!(Failure::other("busy").kind, "other");
    }

    #[test]
    fn progress_adds_chunks_and_knows_the_size_only_when_told() {
        let p = Progress::default();
        assert_eq!(p.snapshot(), (0, None));
        p.record(10, None);
        p.record(5, Some(40));
        assert_eq!(p.snapshot(), (15, Some(40)));
        p.reset();
        assert_eq!(p.snapshot(), (0, None));
    }

    #[test]
    fn the_answers_reach_the_page_in_camel_case_and_null() {
        let s = Status {
            current: "1.4.2".into(),
            done: 3,
            total: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "current": "1.4.2", "done": 3, "total": null })
        );
        let f = Found {
            version: Some("1.5.0".into()),
        };
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({ "version": "1.5.0" })
        );
        assert_eq!(
            serde_json::to_value(Failure::other("x")).unwrap(),
            serde_json::json!({ "kind": "other", "detail": "x" })
        );
    }
}
