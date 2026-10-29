//! サーバが組んだデスクトップ通知を読みに行く（`GET /api/notify/feed`）。
//!
//! これまでは頁（UI）が入力待ちの出入りを見て `notify_waiting` を呼んでいた。
//! 0.3.0-rc.4 の VM の確かめで、Hangar を別のアプリの裏に置いたまま問いを約 7 秒おきに出すと、4 分のあいだ頁が反応せず、通知が 3 回出なかった。
//! 背面の WebView の JS が止まっていたとみる。
//! そこで、きっかけはサーバ（`sessions/stopNotices.ts`）が決めて並べ、殻のスレッドが長いポーリングで読んで OS へ渡す。
//! サーバも殻のスレッドも背面で止まらないので、頁が止まっていても入力待ちになったら 1 回だけ通知が出る。
//! 頁はデスクトップでは入力待ちの通知を呼ばない。受け取るかどうか（設定のスイッチ）だけを `notify_feed` で殻に伝える。

use super::Kind;
use std::sync::atomic::{AtomicBool, Ordering};

/// 長いポーリングでサーバに待たせる秒数。殻の要求の締め切りはこれより長くする（`READ_TIMEOUT`）。
pub const WAIT_SECS: u64 = 25;
/// 1 回の要求の締め切り。サーバが待たせる長さに余裕を足す。
pub const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(WAIT_SECS + 10);
/// 読めなかったとき（サーバが起き直している、止まっている）に、次に読むまで待つ長さ。
pub const RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(2);

/// サーバから届いた通知 1 件。kind は入力待ち（許可待ちとリセット済みも含む）か使用制限か参加リクエストか未読（notify_user）である。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub kind: Kind,
    pub session_id: String,
    pub title: String,
    pub body: String,
    /// 問いの文がまだ無い入力待ち。殻が問いの文を少し待つ（`hold`）。
    pub bare: bool,
}

/// どこまで読んだか。boot はサーバの起動ごとに変わる印で、変わったら番号を合わせ直し、前の分は出さない。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Cursor {
    boot: Option<String>,
    seq: u64,
}

impl Cursor {
    /// 次に読む経路。まだ何も読んでいなければ、待たずに今の番号だけを聞く。
    pub fn path(&self) -> String {
        match &self.boot {
            None => "/api/notify/feed?wait=0".to_string(),
            Some(boot) => format!(
                "/api/notify/feed?after={}&boot={}&wait={WAIT_SECS}",
                self.seq,
                url::form_urlencoded::byte_serialize(boot.as_bytes()).collect::<String>()
            ),
        }
    }

    /// 応答を読み、出す通知を返す。読めなければ `None`（番号は変えない）。
    /// boot が覚えと違えば（初めて読んだか、サーバが起き直した）、番号を合わせ直すだけで何も出さない。
    /// 起き直す前に並んだ通知は、起き直す前のサーバの持ち物で、その分はもう出たか、出す時を過ぎている。
    pub fn take(&mut self, body: &str) -> Option<Vec<Item>> {
        let v: serde_json::Value = serde_json::from_str(body).ok()?;
        let boot = v.get("boot")?.as_str()?.to_string();
        let seq = v.get("seq")?.as_u64()?;
        let same = self.boot.as_deref() == Some(boot.as_str());
        let after = self.seq;
        self.boot = Some(boot);
        self.seq = seq;
        if !same {
            return Some(Vec::new());
        }
        let items = v.get("items")?.as_array()?;
        Some(
            items
                .iter()
                .filter(|i| {
                    i.get("seq")
                        .and_then(|s| s.as_u64())
                        .is_some_and(|s| s > after)
                })
                .filter_map(item_of)
                .collect(),
        )
    }
}

/// 1 件を読む。知らない種類と、欠けた値のものは捨てる。中身の確かめ（id の形、長さ）は `notify::waiting` が行う。
fn item_of(v: &serde_json::Value) -> Option<Item> {
    let kind = match v.get("kind")?.as_str()? {
        "waiting" => Kind::Waiting,
        "limit" => Kind::Limit,
        "join" => Kind::Join,
        "unread" => Kind::Unread,
        _ => return None,
    };
    Some(Item {
        kind,
        session_id: v.get("sessionId")?.as_str()?.to_string(),
        title: v.get("title")?.as_str()?.to_string(),
        body: v.get("body")?.as_str()?.to_string(),
        bare: v.get("bare").and_then(|b| b.as_bool()).unwrap_or(false),
    })
}

/// 利用者が通知を受け取ると選んでいるか。頁が起動したときと、設定のスイッチを変えたときに `notify_feed` で伝える。
/// 頁が伝えるまでは出さない。頁は起動の直後に必ず伝える。
static ENABLED: AtomicBool = AtomicBool::new(false);

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::SeqCst);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// 読みに行くスレッドを起こしたか。起動のやり直し（`retry_boot`）で 2 本目を起こさない。
static STARTED: AtomicBool = AtomicBool::new(false);

/// 初めてなら真を返し、起こした印を付ける。
pub fn start_once() -> bool {
    !STARTED.swap(true, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOT: &str = "0199a2b3-1111-7000-8000-000000000001";

    fn feed(boot: &str, seq: u64, items: &str) -> String {
        format!(r#"{{"boot":"{boot}","seq":{seq},"items":[{items}]}}"#)
    }

    #[test]
    fn the_first_read_only_learns_the_number_and_shows_nothing() {
        let mut c = Cursor::default();
        assert_eq!(c.path(), "/api/notify/feed?wait=0");
        let item =
            r#"{"seq":3,"kind":"waiting","sessionId":"s1","title":"t","body":"b","bare":false}"#;
        assert_eq!(c.take(&feed(BOOT, 3, item)), Some(vec![]));
        assert_eq!(
            c.path(),
            format!("/api/notify/feed?after=3&boot={BOOT}&wait=25")
        );
    }

    #[test]
    fn later_reads_show_only_the_new_items() {
        let mut c = Cursor::default();
        c.take(&feed(BOOT, 1, "")).unwrap();
        let items = [
            r#"{"seq":1,"kind":"waiting","sessionId":"old","title":"t","body":"b","bare":false}"#,
            r#"{"seq":2,"kind":"waiting","sessionId":"s1","title":"名前","body":"向きは？","bare":true}"#,
            r#"{"seq":3,"kind":"limit","sessionId":"s2","title":"使用制限（5 時間）","body":"b","bare":false}"#,
        ]
        .join(",");
        let got = c.take(&feed(BOOT, 3, &items)).unwrap();
        assert_eq!(
            got,
            vec![
                Item {
                    kind: Kind::Waiting,
                    session_id: "s1".into(),
                    title: "名前".into(),
                    body: "向きは？".into(),
                    bare: true
                },
                Item {
                    kind: Kind::Limit,
                    session_id: "s2".into(),
                    title: "使用制限（5 時間）".into(),
                    body: "b".into(),
                    bare: false
                },
            ]
        );
        assert!(c.path().contains("after=3"));
    }

    #[test]
    fn a_join_request_notice_is_read_as_the_join_kind() {
        let mut c = Cursor::default();
        c.take(&feed(BOOT, 0, "")).unwrap();
        let item = r#"{"seq":1,"kind":"join","sessionId":"join-request","title":"参加リクエストを受信しました","body":"b","bare":false}"#;
        let got = c.take(&feed(BOOT, 1, item)).unwrap();
        assert_eq!(
            got,
            vec![Item {
                kind: Kind::Join,
                session_id: "join-request".into(),
                title: "参加リクエストを受信しました".into(),
                body: "b".into(),
                bare: false
            }]
        );
    }

    #[test]
    fn an_unread_notice_is_read_as_the_unread_kind() {
        let mut c = Cursor::default();
        c.take(&feed(BOOT, 0, "")).unwrap();
        let item = r#"{"seq":1,"kind":"unread","sessionId":"s1","title":"名前","body":"調査が終わりました","bare":false}"#;
        let got = c.take(&feed(BOOT, 1, item)).unwrap();
        assert_eq!(
            got,
            vec![Item {
                kind: Kind::Unread,
                session_id: "s1".into(),
                title: "名前".into(),
                body: "調査が終わりました".into(),
                bare: false
            }]
        );
    }

    #[test]
    fn a_restarted_server_resets_the_number_without_showing_its_backlog() {
        let mut c = Cursor::default();
        c.take(&feed(BOOT, 5, "")).unwrap();
        let item =
            r#"{"seq":1,"kind":"waiting","sessionId":"s1","title":"t","body":"b","bare":false}"#;
        assert_eq!(c.take(&feed("another-boot", 1, item)), Some(vec![]));
        assert!(c.path().contains("after=1&boot=another-boot"));
    }

    #[test]
    fn unknown_kinds_and_broken_items_are_dropped_and_a_broken_body_changes_nothing() {
        let mut c = Cursor::default();
        c.take(&feed(BOOT, 0, "")).unwrap();
        let items = r#"{"seq":1,"kind":"party","sessionId":"s1","title":"t","body":"b"},{"seq":2,"kind":"waiting","title":"t","body":"b"}"#;
        assert_eq!(c.take(&feed(BOOT, 2, items)), Some(vec![]));
        let before = c.clone();
        assert_eq!(c.take("not json"), None);
        assert_eq!(c, before);
    }

    #[test]
    fn notices_are_off_until_the_page_says_otherwise() {
        assert!(!enabled());
        set_enabled(true);
        assert!(enabled());
        set_enabled(false);
        assert!(!enabled());
    }
}
