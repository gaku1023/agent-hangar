//! アプリの自動更新（段 5-4）。
//! 更新は「知らせて、押して入れる」で、勝手には入れない。
//! 頁（UI）が `update_check`、`update_download`、`update_install` を順に呼び、取得の最中は `update_status` で進みを読む。
//! 目録（latest.json）は GitHub の Release の最新から引き、更新物は tauri.conf.json の公開鍵（minisign）で確かめる。
//! ここには、命令の間で持ち回る状態（段の移り方の `Flow`）と、頁へ返す形と、失敗の分け方だけを置く。命令そのものは lib.rs にある。

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use tauri_plugin_updater::{Error, Update};

/// 命令の間で持ち回る状態。
/// flow は見つけた版と取得した更新物の段（`Flow`）、progress は取得の進みである。
/// handed_over は、インストーラへ渡す直前（`on_before_exit`）にしたこと（`Handover`）である。
#[derive(Default)]
pub struct UpdateSlot {
    pub flow: Mutex<Flow<Update>>,
    pub progress: Progress,
    handed_over: AtomicU8,
}

/// インストーラへ渡す直前（`on_before_exit`）にしたこと。
/// 合図が来れば、`cleanup_before_exit` が Windows で窓を隠している。止めた子のサーバがいたときだけ ServerStopped になる。
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Handover {
    None,
    WindowHidden,
    ServerStopped,
}

impl UpdateSlot {
    /// インストーラへ渡す直前にしたことを覚える。stopped_server は、止めた子のサーバがいたか（`stop_server` の答え）。
    pub fn handing_over(&self, stopped_server: bool) {
        self.handed_over
            .store(if stopped_server { 2 } else { 1 }, Ordering::SeqCst);
    }

    /// 覚えていたことを返し、忘れる。
    /// Windows の updater は、合図の後でインストーラを起こせないと誤りを返して戻ってくる（Smart App Control に止められたときなど）。
    /// そのとき隠した窓と止めたサーバを 1 度だけ戻すために読む（#617）。
    pub fn take_handover(&self) -> Handover {
        match self.handed_over.swap(0, Ordering::SeqCst) {
            1 => Handover::WindowHidden,
            2 => Handover::ServerStopped,
            _ => Handover::None,
        }
    }
}

/// インストールに失敗したあとに戻すもの（`after_failed_install`）。
#[derive(Debug, PartialEq)]
pub struct Resume {
    pub show_window: bool,
    pub restart_server: bool,
}

/// インストールに失敗したあとに戻すものを決める。
/// 窓は合図が来ていれば出し直す。サーバは、止めた子がいて、起動の本体（`boot`）が走っておらず、頁がサーバの頁へ移っていたときだけ起こし直す。
/// 起動画面からの更新の失敗では、起動画面の「もう一度試す」（`retry_boot`）がサーバを起こすので、ここで二重に起こさない。
pub fn after_failed_install(h: Handover, booting: bool, on_server_page: bool) -> Resume {
    Resume {
        show_window: h != Handover::None,
        restart_server: h == Handover::ServerStopped && !booting && on_server_page,
    }
}

/// 起動画面の札に出す版。前にインストールに失敗した版（`Found::failed`）は、自動では勧め直さない（#617）。
pub fn boot_offer(found: &Found) -> Option<&str> {
    match (&found.version, &found.failed) {
        (Some(v), None) => Some(v),
        _ => None,
    }
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
/// notes は目録（latest.json）の notes で、正式な版ならリリースノートの md が入る。頁が新しい版の札と設定の「更新」の節に出す。
/// 試しの版の空の notes と、取得の途中で途中の版だけを答えるときは None にする。
/// failed は、見つけた版を前に入れようとして失敗していたら、その失敗の種類（`remembered_failure`）。
/// 頁は自動の確認でこれを見たら、新しい版の札ではなく失敗の札を出し、同じ版を勧め直さない。
#[derive(Serialize, Debug, PartialEq)]
pub struct Found {
    pub version: Option<String>,
    pub notes: Option<String>,
    pub failed: Option<String>,
}

/// インストールに失敗した版を覚えるファイル（hangar の置き場の下）。中身は `{"version":"0.19.0","kind":"blocked"}` の形である。
pub const INSTALL_FAILED_FILE: &str = "update-install-failed.json";

/// at は失敗した時刻（UNIX の秒）。
#[derive(Serialize, Deserialize)]
struct InstallFailed {
    version: String,
    kind: String,
    at: u64,
}

/// 記録を効かせる長さ（秒）。過ぎたら、その版をまた自動で勧める。
/// Smart App Control などに止められたとき（blocked）は、すぐ試しても同じく止められやすいので 24 時間にする。
/// ほか（管理者の許可の確認を 1 度断った、など）は一時のことが多いので 1 時間にする。
fn remembered_for(kind: &str) -> u64 {
    if kind == "blocked" {
        24 * 3600
    } else {
        3600
    }
}

/// インストールに失敗した版と種類と時刻（now、UNIX の秒）を覚える。前の記録は上書きする。
/// 書けなかったら誤りを返す。呼び手はログに残すだけで、更新の流れは止めない。
pub fn remember_install_failure(
    home: &Path,
    version: &str,
    kind: &str,
    now: u64,
) -> std::io::Result<()> {
    let body = InstallFailed {
        version: version.to_string(),
        kind: kind.to_string(),
        at: now,
    };
    let text = serde_json::to_string(&body).map_err(std::io::Error::other)?;
    std::fs::write(home.join(INSTALL_FAILED_FILE), text)
}

/// 見つけた版を前に入れようとして失敗していたら、その種類。
/// 記録が無い、読めない、別の版のもの、効く長さ（`remembered_for`）を過ぎたものなら None である。
pub fn remembered_failure(home: &Path, found: Option<&str>, now: u64) -> Option<String> {
    let found = found?;
    let text = std::fs::read_to_string(home.join(INSTALL_FAILED_FILE)).ok()?;
    let r: InstallFailed = serde_json::from_str(&text).ok()?;
    let fresh = now.saturating_sub(r.at) < remembered_for(&r.kind);
    (r.version == found && fresh).then_some(r.kind)
}

/// いまの時刻（UNIX の秒）。
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 命令の失敗。kind は頁が文を選ぶための分類（network、signature、permission、blocked、other）、detail はログ向けの英語の 1 行である。
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

/// Windows のアプリの制御（Smart App Control、App Control for Business）がファイルを止めたときの誤りの番号。
/// どれも「An Application Control policy has blocked this file」の文を持つ（ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION と、評判で止めた系）。
/// 方針そのものの誤り（4550、4552 から 4555）は、ファイルを止めたのではないので含めない。
/// 名前は windows-sys（Win32 のメタデータ）の ERROR_SYSTEM_INTEGRITY_ の POLICY_VIOLATION（4551）、REPUTATION_MALICIOUS（4556）、
/// REPUTATION_PUA（4557）、REPUTATION_DANGEROUS_EXT（4558）、REPUTATION_OFFLINE（4559）、REPUTATION_UNFRIENDLY_FILE（4580）、
/// REPUTATION_UNATTAINABLE（4581）、REPUTATION_EXPLICIT_DENY_FILE（4582）である。
/// 4583 は windows-sys 0.61 に名前が無いが、Windows 11 の FormatMessage の文は同じく「has blocked this file」（WHQL の要件）である。
const APP_CONTROL_BLOCKS: [i32; 9] = [4551, 4556, 4557, 4558, 4559, 4580, 4581, 4582, 4583];

/// Smart App Control の状態。`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` の `VerifiedAndReputablePolicyState`（0 がオフ、1 がオン、2 が評価）で読む。
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum SmartAppControl {
    Off,
    On,
    Evaluation,
}

impl SmartAppControl {
    /// 値から読む。値が無い（Smart App Control の無い Windows、macOS）か知らない値なら、オフとして扱う。
    pub fn from_policy(value: Option<u32>) -> Self {
        match value {
            Some(1) => SmartAppControl::On,
            Some(2) => SmartAppControl::Evaluation,
            _ => SmartAppControl::Off,
        }
    }

    /// この PC の状態。Windows のほかでは常にオフである。
    pub fn current() -> Self {
        Self::from_policy(policy_state())
    }
}

#[cfg(windows)]
fn policy_state() -> Option<u32> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD,
    };
    let wide = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let key = wide("SYSTEM\\CurrentControlSet\\Control\\CI\\Policy");
    let value = wide("VerifiedAndReputablePolicyState");
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let r = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut core::ffi::c_void,
            &mut size,
        )
    };
    (r == ERROR_SUCCESS).then_some(data)
}

#[cfg(not(windows))]
fn policy_state() -> Option<u32> {
    None
}

/// インストールの失敗を分ける。`failure_kind` に加えて、Smart App Control がオンのときの拒否（os error 5）を blocked にする。
/// 今の updater は ShellExecuteW の戻り値の SE_ERR_ACCESSDENIED を os error 5 にするので、
/// Smart App Control に止められたのか、管理者の許可の確認で断ったのかを、誤りだけでは見分けられない。
/// オンの PC では止められたことの方が多いと見て blocked にし、頁の文でもそう言い切らない（#617）。
pub fn install_failure_kind(e: &Error, sac: SmartAppControl) -> &'static str {
    match e {
        Error::Io(io) if sac == SmartAppControl::On && io.raw_os_error() == Some(5) => "blocked",
        _ => failure_kind(e),
    }
}

/// updater の誤りを、頁が利用者に言える種類に分ける。
/// 目録や更新物を取れない（接続できない、目録が無い、この OS の更新物が無い）は network、
/// 署名が合わない、読めないは signature、管理者の許可を断られた、書けないは permission、
/// Windows のアプリの制御がインストーラを止めた（os error 4551 など）は blocked、ほかは other である。
pub fn failure_kind(e: &Error) -> &'static str {
    match e {
        Error::Io(io)
            if io
                .raw_os_error()
                .is_some_and(|c| APP_CONTROL_BLOCKS.contains(&c)) =>
        {
            "blocked"
        }
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
    fn errors_are_sorted_into_kinds_the_page_can_explain() {
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

    // Windows のアプリの制御（Smart App Control、App Control for Business）がインストーラを止めた誤り（4551 系）は、
    // どの段でも blocked にする（#617）。古い updater は ShellExecuteW の後の GetLastError をそのまま返していた。
    #[test]
    fn an_application_control_block_is_its_own_kind() {
        for code in [4551, 4556, 4557, 4558, 4559, 4580, 4581, 4582, 4583] {
            let e = Error::Io(std::io::Error::from_raw_os_error(code));
            assert_eq!(failure_kind(&e), "blocked", "os error {code}");
            assert_eq!(install_failure_kind(&e, SmartAppControl::Off), "blocked");
        }
        // 方針の不正や仮想化の誤りは、ファイルを止めたのではないので blocked にしない。
        let e = Error::Io(std::io::Error::from_raw_os_error(4552));
        assert_eq!(failure_kind(&e), "other");
    }

    // 今の updater は、ShellExecuteW の戻り値の SE_ERR_ACCESSDENIED（5）を os error 5 にする。
    // Smart App Control が止めたときもこれになるので、オンのときのインストールの 5 だけを blocked にする。
    // 評価のモードは止めないので、権限のままにする。確認と取得の 5 も、ファイルを書けないだけなので権限のままにする。
    #[test]
    fn access_denied_while_installing_is_blocked_only_when_smart_app_control_is_on() {
        let denied = || Error::Io(std::io::Error::from_raw_os_error(5));
        assert_eq!(
            install_failure_kind(&denied(), SmartAppControl::On),
            "blocked"
        );
        let plain = failure_kind(&denied());
        assert_eq!(install_failure_kind(&denied(), SmartAppControl::Off), plain);
        assert_eq!(
            install_failure_kind(&denied(), SmartAppControl::Evaluation),
            plain
        );
        // 5 が ERROR_ACCESS_DENIED なのは Windows だけである（macOS では EIO）。
        #[cfg(windows)]
        assert_eq!(plain, "permission");
        // 5 でない失敗は、オンでもそのままの分類にする。
        assert_eq!(
            install_failure_kind(&Error::Network("503".into()), SmartAppControl::On),
            "network"
        );
    }

    #[test]
    fn the_smart_app_control_state_is_read_from_the_policy_value() {
        assert_eq!(SmartAppControl::from_policy(Some(0)), SmartAppControl::Off);
        assert_eq!(SmartAppControl::from_policy(Some(1)), SmartAppControl::On);
        assert_eq!(
            SmartAppControl::from_policy(Some(2)),
            SmartAppControl::Evaluation
        );
        // 値が無い（Smart App Control の無い Windows、macOS）か知らない値なら、オフとして扱う。
        assert_eq!(SmartAppControl::from_policy(None), SmartAppControl::Off);
        assert_eq!(SmartAppControl::from_policy(Some(7)), SmartAppControl::Off);
    }

    // インストールに失敗した版を覚え、同じ版を見つけた確認に失敗の種類を添える（#617）。
    // 起動し直すたびに同じ版を勧めて、同じ失敗と Windows セキュリティの知らせを繰り返さないためである。
    #[test]
    fn a_failed_install_is_remembered_for_the_same_version_only() {
        let dir = std::env::temp_dir().join(format!(
            "hangar-update-failed-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let t0 = 1_800_000_000;
        assert_eq!(remembered_failure(&dir, Some("0.19.0"), t0), None);
        remember_install_failure(&dir, "0.19.0", "blocked", t0).unwrap();
        assert_eq!(
            remembered_failure(&dir, Some("0.19.0"), t0),
            Some("blocked".into())
        );
        assert_eq!(remembered_failure(&dir, Some("0.19.1"), t0), None);
        assert_eq!(remembered_failure(&dir, None, t0), None);
        // 後の失敗で上書きする。
        remember_install_failure(&dir, "0.19.1", "permission", t0).unwrap();
        assert_eq!(remembered_failure(&dir, Some("0.19.0"), t0), None);
        assert_eq!(
            remembered_failure(&dir, Some("0.19.1"), t0),
            Some("permission".into())
        );
        // 壊れたファイル、時刻の無い記録は無いものとして扱う。
        std::fs::write(dir.join(INSTALL_FAILED_FILE), "{").unwrap();
        assert_eq!(remembered_failure(&dir, Some("0.19.1"), t0), None);
        std::fs::write(
            dir.join(INSTALL_FAILED_FILE),
            r#"{"version":"0.19.1","kind":"blocked"}"#,
        )
        .unwrap();
        assert_eq!(remembered_failure(&dir, Some("0.19.1"), t0), None);
        // 置き場が無ければ、書けなかったと返す（呼び手がログに残す）。
        assert!(remember_install_failure(&dir.join("missing"), "0.19.1", "other", t0).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 記録は時間で失効させる（#617 の見直し）。
    // UAC を 1 度断っただけのような一時の失敗で、その版をずっと勧めなくならないためである。
    // Smart App Control に止められたときは同じく止められやすいので 24 時間、ほかは 1 時間で勧め直す。
    #[test]
    fn a_remembered_failure_expires() {
        let dir = std::env::temp_dir().join(format!(
            "hangar-update-expiry-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let t0 = 1_800_000_000;
        const H: u64 = 3600;
        remember_install_failure(&dir, "0.19.0", "blocked", t0).unwrap();
        assert!(remembered_failure(&dir, Some("0.19.0"), t0 + 24 * H - 1).is_some());
        assert_eq!(remembered_failure(&dir, Some("0.19.0"), t0 + 24 * H), None);
        for kind in ["permission", "network", "signature", "other"] {
            remember_install_failure(&dir, "0.19.0", kind, t0).unwrap();
            assert!(remembered_failure(&dir, Some("0.19.0"), t0 + H - 1).is_some());
            assert_eq!(
                remembered_failure(&dir, Some("0.19.0"), t0 + H),
                None,
                "{kind}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // インストーラへ渡す直前にしたことを覚え、1 度だけ取り出す（#617）。
    // 合図が来れば窓は隠れている（cleanup_before_exit）。止めた子のサーバがいたときだけ、サーバも止めたと覚える。
    #[test]
    fn the_handover_is_taken_once() {
        let slot = UpdateSlot::default();
        assert_eq!(slot.take_handover(), Handover::None);
        slot.handing_over(false);
        assert_eq!(slot.take_handover(), Handover::WindowHidden);
        assert_eq!(slot.take_handover(), Handover::None);
        slot.handing_over(true);
        assert_eq!(slot.take_handover(), Handover::ServerStopped);
        assert_eq!(slot.take_handover(), Handover::None);
    }

    // インストールに失敗したあとに戻すもの（#617 の見直し）。
    // 窓は合図が来ていれば出し直す。サーバは、止めた子がいて、起動の本体が走っておらず、頁がサーバの頁へ移っていたときだけ起こし直す。
    // 起動画面からの更新の失敗では、起動画面の「もう一度試す」（retry_boot）がサーバを起こすので、二重に起こさない。
    #[test]
    fn what_to_bring_back_after_a_failed_install() {
        let r = |h, booting, on_server_page| after_failed_install(h, booting, on_server_page);
        let nothing = Resume {
            show_window: false,
            restart_server: false,
        };
        let window = Resume {
            show_window: true,
            restart_server: false,
        };
        let both = Resume {
            show_window: true,
            restart_server: true,
        };
        assert_eq!(r(Handover::None, false, true), nothing);
        assert_eq!(r(Handover::WindowHidden, false, true), window);
        assert_eq!(r(Handover::ServerStopped, false, true), both);
        assert_eq!(r(Handover::ServerStopped, true, true), window);
        assert_eq!(r(Handover::ServerStopped, false, false), window);
    }

    // 起動画面の札に出すのは、前にインストールに失敗していない版だけである（#617 の見直し）。
    #[test]
    fn the_boot_screen_is_offered_only_versions_without_a_remembered_failure() {
        let found = |version: Option<&str>, failed: Option<&str>| Found {
            version: version.map(Into::into),
            notes: None,
            failed: failed.map(Into::into),
        };
        assert_eq!(boot_offer(&found(Some("0.20.0"), None)), Some("0.20.0"));
        assert_eq!(boot_offer(&found(Some("0.20.0"), Some("blocked"))), None);
        assert_eq!(boot_offer(&found(None, None)), None);
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
            notes: Some("## 直したこと".into()),
            failed: None,
        };
        assert_eq!(
            serde_json::to_value(&f).unwrap(),
            serde_json::json!({ "version": "1.5.0", "notes": "## 直したこと", "failed": null })
        );
        let f = Found {
            version: Some("1.5.0".into()),
            notes: None,
            failed: Some("blocked".into()),
        };
        assert_eq!(
            serde_json::to_value(&f).unwrap()["failed"],
            serde_json::json!("blocked")
        );
        assert_eq!(
            serde_json::to_value(Failure::other("x")).unwrap(),
            serde_json::json!({ "kind": "other", "detail": "x" })
        );
    }
}
