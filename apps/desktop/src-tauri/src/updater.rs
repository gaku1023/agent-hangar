//! アプリの自動更新（段 5-4）。
//! 更新は「知らせて、押して入れる」で、勝手には入れない。
//! 頁（UI）が `update_check`、`update_download`、`update_install` を順に呼び、取得の最中は `update_status` で進みを読む。
//! 目録（latest.json）は GitHub の Release の最新から引き、更新物は tauri.conf.json の公開鍵（minisign）で確かめる。
//! ここには、命令の間で持ち回る状態（段の移り方の `Flow`）と、頁へ返す形と、失敗の分け方だけを置く。命令そのものは lib.rs にある。

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri_plugin_updater::{Error, Update};

/// 命令の間で持ち回る状態。
/// flow は見つけた版と取得した更新物の段（`Flow`）、progress は取得の進みである。
#[derive(Default)]
pub struct UpdateSlot {
    pub flow: Mutex<Flow<Update>>,
    pub progress: Progress,
}

/// 版の名前を持つもの。`Flow` が試験で updater の Update の代わりを受け取れるように、版を読む口だけを切り出す。
pub trait Versioned {
    fn version(&self) -> &str;
}

impl Versioned for Update {
    fn version(&self) -> &str {
        &self.version
    }
}

/// 見つけた版から入れ終えるまでの段。
/// 確認は待ち（Idle）のときだけ見つけた版を差し替え、取得中、取得済み、インストール中は差し替えない。
/// 取得した中身は取得済み（Downloaded）の段に版と一緒に持つので、中身と版が食い違うことはない。
/// 確認、取得、インストールは別々の頁（UI、起動画面）と殻自身から呼ばれ、互いの途中に割り込みうる（2026-10-11）。
#[derive(Debug)]
pub enum Flow<U> {
    Idle { found: Option<U> },
    Downloading { update: U },
    Downloaded { update: U, bytes: Vec<u8> },
    Installing { update: U },
}

impl<U> Default for Flow<U> {
    fn default() -> Self {
        Flow::Idle { found: None }
    }
}

/// 確認の答えを置いたかどうか。
#[derive(Debug, PartialEq)]
pub enum Checked {
    /// 待ちだったので、見つけた版（無ければ None）を置いた。
    Kept(Option<String>),
    /// 取得からインストールまでの途中だったので捨てた。中の版は途中の版である。
    Busy(String),
}

/// 取得の始め方。
#[derive(Debug, PartialEq)]
pub enum Begin<U> {
    /// この版を取りに行く。
    Fetch(U),
    /// もう取得してある。取りに行かずに済んだと答える。
    Ready,
}

pub const NOTHING_TO_DOWNLOAD: &str = "no update to download";
pub const STILL_DOWNLOADING: &str = "the update is still downloading";
pub const NOT_DOWNLOADED: &str = "the update is not downloaded";
pub const INSTALLING: &str = "the update is being installed";

impl<U: Versioned + Clone> Flow<U> {
    /// 取得からインストールまでの途中なら、その版。確認はこのとき目録を引かず、この版を答える。
    pub fn busy_version(&self) -> Option<String> {
        match self {
            Flow::Idle { .. } => None,
            Flow::Downloading { update }
            | Flow::Downloaded { update, .. }
            | Flow::Installing { update } => Some(update.version().to_string()),
        }
    }

    /// 確認の答えを置く。目録を引いている間に取得が始まっていたら、答えを捨てて途中の版を守る。
    pub fn checked(&mut self, found: Option<U>) -> Checked {
        if let Some(v) = self.busy_version() {
            return Checked::Busy(v);
        }
        let version = found.as_ref().map(|u| u.version().to_string());
        *self = Flow::Idle { found };
        Checked::Kept(version)
    }

    /// 取得を始める。見つけた版を取得中にして、その版を返す。
    pub fn begin_download(&mut self) -> Result<Begin<U>, &'static str> {
        match self {
            Flow::Idle { found: Some(u) } => {
                let u = u.clone();
                *self = Flow::Downloading { update: u.clone() };
                Ok(Begin::Fetch(u))
            }
            Flow::Idle { found: None } => Err(NOTHING_TO_DOWNLOAD),
            Flow::Downloading { .. } => Err(STILL_DOWNLOADING),
            Flow::Downloaded { .. } => Ok(Begin::Ready),
            Flow::Installing { .. } => Err(INSTALLING),
        }
    }

    /// 取得を終える。取得中の版と同じ版のときだけ受け取り、中身があれば取得済みに、無ければ（失敗）見つけた版に戻す。
    /// 受け取らなかったときは偽を返し、中身は捨てる。
    pub fn finish_download(&mut self, version: &str, bytes: Option<Vec<u8>>) -> bool {
        let update = match self {
            Flow::Downloading { update } if update.version() == version => update.clone(),
            _ => return false,
        };
        *self = match bytes {
            Some(bytes) => Flow::Downloaded { update, bytes },
            None => Flow::Idle {
                found: Some(update),
            },
        };
        true
    }

    /// インストールを始める。取得済みの版と中身を一緒に渡す。
    pub fn begin_install(&mut self) -> Result<(U, Vec<u8>), &'static str> {
        match std::mem::take(self) {
            Flow::Downloaded { update, bytes } => {
                *self = Flow::Installing {
                    update: update.clone(),
                };
                Ok((update, bytes))
            }
            other => {
                let err = match &other {
                    Flow::Downloading { .. } => STILL_DOWNLOADING,
                    Flow::Installing { .. } => INSTALLING,
                    _ => NOT_DOWNLOADED,
                };
                *self = other;
                Err(err)
            }
        }
    }

    /// インストールに失敗した。見つけた版に戻す（中身は渡したので、もう一度取得してから入れる）。
    pub fn install_failed(&mut self) {
        if let Flow::Installing { update } = self {
            *self = Flow::Idle {
                found: Some(update.clone()),
            };
        }
    }
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

    /// 試験の版。updater の Update の代わりに、版の名前だけを持つ。
    #[derive(Clone, Debug, PartialEq)]
    struct V(&'static str);
    impl Versioned for V {
        fn version(&self) -> &str {
            self.0
        }
    }

    fn found(v: &'static str) -> Flow<V> {
        let mut f = Flow::default();
        assert_eq!(f.checked(Some(V(v))), Checked::Kept(Some(v.into())));
        f
    }

    #[test]
    fn a_check_while_idle_replaces_what_the_last_check_found() {
        let mut f = found("0.2.1");
        assert_eq!(f.busy_version(), None);
        assert_eq!(
            f.checked(Some(V("0.2.2"))),
            Checked::Kept(Some("0.2.2".into()))
        );
        assert_eq!(f.begin_download(), Ok(Begin::Fetch(V("0.2.2"))));
        let mut none = found("0.2.1");
        assert_eq!(none.checked(None), Checked::Kept(None));
        assert_eq!(none.begin_download(), Err(NOTHING_TO_DOWNLOAD));
    }

    // 取得の最中に別の頁（UI の起動時の確認、起動画面の「更新を確認」、殻の起動失敗の後の確認）が確かめても、取得中の版を差し替えない。
    // 確かめた答えは取得中の版にする（2026-10-11、CI の通し稽古で、取得の終わりに pending が別の Update に替わっていた）。
    #[test]
    fn a_check_during_a_download_keeps_the_update_being_downloaded() {
        let mut f = found("0.2.1");
        assert_eq!(f.begin_download(), Ok(Begin::Fetch(V("0.2.1"))));
        assert_eq!(f.busy_version(), Some("0.2.1".into()));
        // 取得の前に始まって、取得の最中に終わった確認も捨てる。
        assert_eq!(f.checked(Some(V("0.2.2"))), Checked::Busy("0.2.1".into()));
        assert_eq!(f.checked(None), Checked::Busy("0.2.1".into()));
        assert!(f.finish_download("0.2.1", Some(vec![1, 2, 3])));
        assert_eq!(f.begin_install(), Ok((V("0.2.1"), vec![1, 2, 3])));
    }

    #[test]
    fn a_check_after_the_download_or_during_the_install_keeps_the_update() {
        let mut f = found("0.2.1");
        f.begin_download().unwrap();
        assert!(f.finish_download("0.2.1", Some(vec![9])));
        assert_eq!(f.busy_version(), Some("0.2.1".into()));
        assert_eq!(f.checked(Some(V("0.2.2"))), Checked::Busy("0.2.1".into()));
        assert_eq!(f.begin_install(), Ok((V("0.2.1"), vec![9])));
        assert_eq!(f.busy_version(), Some("0.2.1".into()));
        assert_eq!(f.checked(Some(V("0.2.2"))), Checked::Busy("0.2.1".into()));
    }

    // 取得した中身は、取得を始めた版のものだけを持つ。版が合わなければ捨て、取得中のまま残す。
    #[test]
    fn downloaded_bytes_are_kept_only_for_the_version_being_downloaded() {
        let mut f = Flow::<V>::default();
        assert!(!f.finish_download("0.2.1", Some(vec![1])));
        assert_eq!(f.begin_install(), Err(NOT_DOWNLOADED));
        let mut f = found("0.2.1");
        f.begin_download().unwrap();
        assert!(!f.finish_download("0.2.2", Some(vec![1])));
        assert_eq!(f.begin_install(), Err(STILL_DOWNLOADING));
        assert!(f.finish_download("0.2.1", Some(vec![2])));
        assert_eq!(f.begin_install(), Ok((V("0.2.1"), vec![2])));
    }

    #[test]
    fn a_second_download_is_refused_while_one_runs_and_skipped_once_done() {
        let mut f = found("0.2.1");
        f.begin_download().unwrap();
        assert_eq!(f.begin_download(), Err(STILL_DOWNLOADING));
        assert!(f.finish_download("0.2.1", Some(vec![1])));
        // 取得が済んでいれば、取りに行かずにそのまま済んだと答える。
        assert_eq!(f.begin_download(), Ok(Begin::Ready));
        f.begin_install().unwrap();
        assert_eq!(f.begin_download(), Err(INSTALLING));
        assert_eq!(f.begin_install(), Err(INSTALLING));
    }

    // 取得に失敗したら見つけた版に戻り、もう一度取りに行ける。確認でも差し替えられる。
    #[test]
    fn a_failed_download_goes_back_to_the_found_update() {
        let mut f = found("0.2.1");
        f.begin_download().unwrap();
        assert!(f.finish_download("0.2.1", None));
        assert_eq!(f.busy_version(), None);
        assert_eq!(f.begin_download(), Ok(Begin::Fetch(V("0.2.1"))));
        assert!(f.finish_download("0.2.1", None));
        assert_eq!(
            f.checked(Some(V("0.2.2"))),
            Checked::Kept(Some("0.2.2".into()))
        );
    }

    // インストールに失敗したら見つけた版に戻る。中身は渡してしまったので、取り直してから入れる。
    #[test]
    fn a_failed_install_goes_back_to_the_found_update_and_needs_a_new_download() {
        let mut f = found("0.2.1");
        assert_eq!(f.begin_install(), Err(NOT_DOWNLOADED));
        f.begin_download().unwrap();
        f.finish_download("0.2.1", Some(vec![1]));
        f.begin_install().unwrap();
        f.install_failed();
        assert_eq!(f.busy_version(), None);
        assert_eq!(f.begin_install(), Err(NOT_DOWNLOADED));
        assert_eq!(f.begin_download(), Ok(Begin::Fetch(V("0.2.1"))));
    }

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
