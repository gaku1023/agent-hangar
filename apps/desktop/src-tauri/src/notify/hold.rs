//! 問いの文の無い入力待ちの通知を、問いの文が届くまで少し預かる。
//!
//! 入力待ちの合図（Claude の登録の `waiting`）は、問いの文（hook の台本や本文の索引）より先に届くことがある。
//! 頁はそのとき、問いの文の無い通知（bare）を呼び、問いの文が届いたら同じセッションの通知をもう一度呼ぶ。
//! OS は同じ識別子（macOS）や同じタグと組（Windows）の通知を置き換えるが、置き換えのたびにバナーと音を出し直す。
//! そこで殻は、問いの文の無い通知をセッションごとに `HOLD` だけ預かる。
//! 預かっている間に問いの文の入った通知が来たら、預かった分を捨てて、問いの文の通知を 1 回だけ出す。
//! 来なければ、預かった分（代わりの文）を出す。
//! 預かりの時間を過ぎてから届いた問いの文は、出し直さない（右下の札とホームに出る）。
//! 戻る時刻の知らせは預からない。
//! 時計は殻（Rust のスレッド）が持つ。頁の時計は窓を最小化すると絞られるからである。

use super::{Keep, Kind, Waiting};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// 問いの文の無い入力待ちの通知を預かる時間。
/// 2026-10-12 に macOS の通知の記録と殻のログで、問いの文の無い呼び出しから問いの文の入った呼び出しまでの間を測った。
/// 19 回のうち 18 回は 0.07〜1.2 秒で、1 回だけ 2.5 秒だった。
/// 2 秒あればほとんどを 1 回にまとめられ、問いの文が来ない入力待ち（権限の確認など）の通知の遅れも 2 秒で済む。
pub const HOLD: Duration = Duration::from_secs(2);

/// 頁から届いた通知をどうするか。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Offer {
    /// いま出す。
    Show(Waiting),
    /// 預かった。`HOLD` の後に、この番号で `Holds::due` を呼ぶ。
    Hold(u64),
    /// 同じセッションの問いの文の無い通知をすでに預かっているので、何もしない。
    Wait,
    /// 預かりの時間を過ぎてから届いた問いの文なので、出し直さない。
    Late,
}

/// セッションごとの預かりの状態。
#[derive(Debug, Default)]
pub struct Holds {
    /// 預かっている通知と、その番号。
    held: HashMap<String, (u64, Waiting)>,
    /// 預かりの時間を過ぎて、問いの文の無いまま出した（か、窓が前にあって出さなかった）セッション。
    /// この後に届いた問いの文は出し直さない。
    settled: HashSet<String>,
    next: u64,
}

impl Holds {
    /// 頁から届いた通知を受け取る。
    /// `bare` は、問いの文が取れず代わりの文で出す入力待ちの通知であることを表す。
    pub fn offer(&mut self, w: Waiting, bare: bool) -> Offer {
        if w.kind != Kind::Waiting {
            return Offer::Show(w);
        }
        let id = w.session_id.clone();
        if bare {
            // 問いの文の無い通知は、新しい入力待ちの始まりである。前の 1 回で出し終えた印は捨てる。
            self.settled.remove(&id);
            if self.held.contains_key(&id) {
                return Offer::Wait;
            }
            self.next += 1;
            self.held.insert(id, (self.next, w));
            return Offer::Hold(self.next);
        }
        if self.settled.remove(&id) {
            return Offer::Late;
        }
        self.held.remove(&id);
        Offer::Show(w)
    }

    /// 預かりの時間が過ぎたときに呼ぶ。
    /// その番号の通知をまだ預かっていれば、それを返す（出す）。
    /// 捨てた後や、新しく預かり直した後なら `None`。
    pub fn due(&mut self, session_id: &str, token: u64) -> Option<Waiting> {
        match self.held.get(session_id) {
            Some((t, _)) if *t == token => {}
            _ => return None,
        }
        let (_, w) = self.held.remove(session_id)?;
        self.settled.insert(session_id.to_string());
        Some(w)
    }

    /// 残してよい顔ぶれに無いセッション（答えた、終わった）の預かりを捨てる。
    pub fn prune(&mut self, keep: &Keep) {
        self.held.retain(|id, _| keep.holds(Kind::Waiting, id));
        self.settled.retain(|id| keep.holds(Kind::Waiting, id));
    }
}

static HOLDS: LazyLock<Mutex<Holds>> = LazyLock::new(|| Mutex::new(Holds::default()));

/// 殻の全体で 1 つの預かりに通知を渡す（`Holds::offer`）。
/// 預かりの錠が壊れていたら、預からずにいま出す。
pub fn offer(w: Waiting, bare: bool) -> Offer {
    match HOLDS.lock() {
        Ok(mut h) => h.offer(w, bare),
        Err(_) => Offer::Show(w),
    }
}

/// 殻の全体で 1 つの預かりの時間が過ぎた（`Holds::due`）。
pub fn due(session_id: &str, token: u64) -> Option<Waiting> {
    HOLDS.lock().ok()?.due(session_id, token)
}

/// 殻の全体で 1 つの預かりから、残してよい顔ぶれに無いものを捨てる（`Holds::prune`）。
pub fn prune(keep: &Keep) {
    if let Ok(mut h) = HOLDS.lock() {
        h.prune(keep);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(kind: Kind, id: &str, body: &str) -> Waiting {
        Waiting {
            kind,
            session_id: id.to_string(),
            title: "名前".to_string(),
            body: body.to_string(),
        }
    }
    const BARE: &str = "入力待ちです";
    const ASKED: &str = "向きはどちらにしますか";

    #[test]
    fn a_waiting_with_its_question_is_shown_at_once() {
        let mut h = Holds::default();
        let q = w(Kind::Waiting, "s1", ASKED);
        assert_eq!(h.offer(q.clone(), false), Offer::Show(q));
    }

    #[test]
    fn a_bare_waiting_is_held_and_shown_when_no_question_comes() {
        let mut h = Holds::default();
        let b = w(Kind::Waiting, "s1", BARE);
        let Offer::Hold(t) = h.offer(b.clone(), true) else {
            panic!("not held")
        };
        assert_eq!(h.due("s1", t), Some(b));
        // 出した後に同じ番号で呼ばれても、もう出さない。
        assert_eq!(h.due("s1", t), None);
    }

    #[test]
    fn a_question_within_the_hold_replaces_the_bare_one_and_is_shown_once() {
        let mut h = Holds::default();
        let Offer::Hold(t) = h.offer(w(Kind::Waiting, "s1", BARE), true) else {
            panic!("not held")
        };
        let q = w(Kind::Waiting, "s1", ASKED);
        assert_eq!(h.offer(q.clone(), false), Offer::Show(q));
        // 預かっていた代わりの文は、時間が来ても出さない。
        assert_eq!(h.due("s1", t), None);
    }

    #[test]
    fn a_question_after_the_hold_is_not_shown_again() {
        let mut h = Holds::default();
        let Offer::Hold(t) = h.offer(w(Kind::Waiting, "s1", BARE), true) else {
            panic!("not held")
        };
        assert!(h.due("s1", t).is_some());
        assert_eq!(h.offer(w(Kind::Waiting, "s1", ASKED), false), Offer::Late);
        // 出し直さないのは、その入力待ちの 1 回だけ。次の入力待ちの問いの文は出す。
        let q = w(Kind::Waiting, "s1", "次の問い");
        assert_eq!(h.offer(q.clone(), false), Offer::Show(q));
    }

    #[test]
    fn a_second_bare_call_while_holding_does_not_hold_again() {
        let mut h = Holds::default();
        let Offer::Hold(t) = h.offer(w(Kind::Waiting, "s1", BARE), true) else {
            panic!("not held")
        };
        assert_eq!(h.offer(w(Kind::Waiting, "s1", BARE), true), Offer::Wait);
        assert!(h.due("s1", t).is_some());
    }

    #[test]
    fn a_new_bare_waiting_after_a_settled_one_is_held_again() {
        let mut h = Holds::default();
        let Offer::Hold(t) = h.offer(w(Kind::Waiting, "s1", BARE), true) else {
            panic!("not held")
        };
        assert!(h.due("s1", t).is_some());
        // 新しい入力待ち（問いの文の無いもの）は、前の 1 回の続きではない。
        let Offer::Hold(t2) = h.offer(w(Kind::Waiting, "s1", BARE), true) else {
            panic!("not held")
        };
        assert_ne!(t, t2);
        let q = w(Kind::Waiting, "s1", ASKED);
        assert_eq!(h.offer(q.clone(), false), Offer::Show(q));
    }

    #[test]
    fn sessions_are_held_apart() {
        let mut h = Holds::default();
        let Offer::Hold(t1) = h.offer(w(Kind::Waiting, "s1", BARE), true) else {
            panic!("not held")
        };
        let Offer::Hold(t2) = h.offer(w(Kind::Waiting, "s2", BARE), true) else {
            panic!("not held")
        };
        let q = w(Kind::Waiting, "s2", ASKED);
        assert_eq!(h.offer(q.clone(), false), Offer::Show(q));
        assert!(h.due("s1", t1).is_some());
        assert_eq!(h.due("s2", t2), None);
    }

    #[test]
    fn answering_within_the_hold_drops_it() {
        let mut h = Holds::default();
        let Offer::Hold(t) = h.offer(w(Kind::Waiting, "s1", BARE), true) else {
            panic!("not held")
        };
        let Offer::Hold(t2) = h.offer(w(Kind::Waiting, "s2", BARE), true) else {
            panic!("not held")
        };
        h.prune(&Keep::new(&["s2".to_string()], &[]));
        assert_eq!(h.due("s1", t), None);
        assert!(h.due("s2", t2).is_some());
    }

    #[test]
    fn leaving_the_waiting_forgets_that_the_bare_one_was_shown() {
        let mut h = Holds::default();
        let Offer::Hold(t) = h.offer(w(Kind::Waiting, "s1", BARE), true) else {
            panic!("not held")
        };
        assert!(h.due("s1", t).is_some());
        h.prune(&Keep::default());
        let q = w(Kind::Waiting, "s1", ASKED);
        assert_eq!(h.offer(q.clone(), false), Offer::Show(q));
    }

    #[test]
    fn a_return_notice_is_never_held() {
        let mut h = Holds::default();
        let r = w(Kind::Return, "s1", "13:30 を過ぎました");
        assert_eq!(h.offer(r.clone(), true), Offer::Show(r.clone()));
        // 入力待ちを預かっていても、戻る時刻の知らせはそれを捨てずに出す。
        let Offer::Hold(t) = h.offer(w(Kind::Waiting, "s1", BARE), true) else {
            panic!("not held")
        };
        assert_eq!(h.offer(r.clone(), false), Offer::Show(r));
        assert!(h.due("s1", t).is_some());
    }
}
