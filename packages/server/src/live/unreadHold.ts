import { isTurnRunning, turnPhaseOf, type LiveSessionDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { addUnread, noteUnreadReady, onUnread, type NotifyTarget, type UnreadMeta } from './unread.ts';
import { isViewing } from './viewing.ts';

/**
 * notify_user の知らせを、そのターンが終わるまで預かる（2026-11-05、未読の数も 2026-11-11）。
 *
 * エージェントは、最後の返答を書く前に notify_user を呼ぶ（起動時の指示がそう頼む）。
 * 呼ばれた時点で出すと、知らせを見て開いても、返答がまだ書かれていない。
 * そこで done と ask は、その会話の登録が作業中（busy、または許可待ち）を抜けるまで預かり、抜けたら出す。
 * 抜けるのは、返答を書き終えて入力を待つとき（idle、問いの waiting）、本体が入力を受け付けていて裏だけが動くとき（aside）、run が居なくなったときである。
 * 許可待ちでは出さない。返答はまだ途中で、許可の通知は別に出るからである。
 * progress は途中の報告なので、預からずにすぐ出す（利用者が 2026-11-05 に選んだ）。
 * 未読の数は、書いた側（notifyUserTool）が unreadHeld の印を付けて渡したときだけ預かり、抜けたときに 1 つ積む。
 * 同じターンに何度呼ばれても、返答は 1 つなので 1 つだけ積む。
 */

/** 預かっている知らせ。同じ会話の分は 1 つにまとめ、本文は最後のもの、出し先は合わせたものにする。unread は未読の数を積む番がこちらにあること。 */
type Held = { text: string; sent: Set<NotifyTarget>; unread: boolean; count: number; meta: UnreadMeta };

export type UnreadHoldDeps = {
  db: Db;
  /** いまの実行中の一覧（agent/liveHub.ts の LiveHub.current）。 */
  live: () => LiveSessionDto[];
  now?: () => number;
};

/**
 * 登録の 1 行が、まだターンの途中か。作業中と、許可を待っている間を途中とみなす。
 * 作業中でも裏だけの印（aside）があれば、本体は返答を書き終えて入力を受け付けているので途中とみなさない。
 */
export const turnRunning = (l: Pick<LiveSessionDto, 'status' | 'waitingFor' | 'aside'>): boolean =>
  isTurnRunning(turnPhaseOf(l)) || (l.status === 'waiting' && l.waitingFor === 'permission');

/** 会話（hangar の id）の run が、いまターンの途中か。登録に居なければ途中ではない。 */
export function sessionTurnRunning(db: Db, live: LiveSessionDto[], sessionId: string): boolean {
  const r = db.prepare('select provider, provider_session_id from sessions where id = ?').get(sessionId) as { provider: string; provider_session_id: string } | undefined;
  if (!r) return false;
  const l = live.find((x) => x.sessionId === r.provider_session_id && (x.agent ?? 'claude-code') === r.provider);
  return !!l && turnRunning(l);
}

export class UnreadHold {
  private held = new Map<string, Held>();

  constructor(private readonly deps: UnreadHoldDeps) {}

  /** notify_user の知らせ（onUnread）を聞き始める。戻り値を呼ぶと外す。前のサーバが預かったまま止まった分は表から読み戻す。 */
  start(): () => void {
    this.restore();
    return onUnread((sessionId, text, count, sent, meta) => this.take(sessionId, text, count, sent, meta));
  }

  /** 預かっている会話があるか。 */
  pending(): boolean {
    return this.held.size > 0;
  }

  /** 登録が変わったときに呼ぶ。ターンを抜けた会話の預かりを出す。 */
  check(): void {
    if (this.held.size === 0) return;
    const live = this.deps.live();
    for (const [id, h] of [...this.held]) {
      if (sessionTurnRunning(this.deps.db, live, id)) continue;
      this.held.delete(id);
      this.forget(id);
      this.release(id, h);
    }
  }

  /** 表に残した預かりを読み戻す。会話が消えていたら捨てる。読めない行も捨てる（出せない知らせで止まらないため）。 */
  private restore(): void {
    const rows = this.deps.db.prepare('select session_id, text, sent, unread, count, meta from unread_hold').all() as { session_id: string; text: string; sent: string; unread: number; count: number; meta: string }[];
    for (const r of rows) {
      try {
        const exists = this.deps.db.prepare('select 1 from sessions where id = ?').get(r.session_id);
        if (!exists) { this.forget(r.session_id); continue; }
        this.held.set(r.session_id, { text: r.text, sent: new Set(JSON.parse(r.sent) as NotifyTarget[]), unread: r.unread === 1, count: r.count, meta: JSON.parse(r.meta) as UnreadMeta });
      } catch {
        this.forget(r.session_id);
      }
    }
  }

  private persist(id: string, h: Held): void {
    this.deps.db.prepare(
      'insert into unread_hold (session_id, text, sent, unread, count, meta) values (?, ?, ?, ?, ?, ?) '
      + 'on conflict(session_id) do update set text = excluded.text, sent = excluded.sent, unread = excluded.unread, count = excluded.count, meta = excluded.meta',
    ).run(id, h.text, JSON.stringify([...h.sent]), h.unread ? 1 : 0, h.count, JSON.stringify(h.meta));
  }

  private forget(id: string): void {
    this.deps.db.prepare('delete from unread_hold where session_id = ?').run(id);
  }

  private take(sessionId: string, text: string, count: number, sent: NotifyTarget[], meta: UnreadMeta): void {
    const unread = meta.unreadHeld === true && sent.includes('unread');
    const out = sent.filter((x) => x !== 'unread');
    if (out.length === 0 && !unread) return;
    const { unreadHeld: _, ...rest } = meta;
    const prev = this.held.get(sessionId);
    if (meta.kind === 'progress' || meta.immediate || !sessionTurnRunning(this.deps.db, this.deps.live(), sessionId)) {
      this.release(sessionId, { text, sent: new Set(out), unread, count, meta: rest });
      return;
    }
    const merged = new Set<NotifyTarget>([...(prev?.sent ?? []), ...out]);
    // ask は done より利用者の手が要るので、どちらかが ask なら ask として出す。
    const kind = prev?.meta.kind === 'ask' ? 'ask' : meta.kind;
    const next: Held = { text, sent: merged, unread: unread || (prev?.unread ?? false), count, meta: { ...rest, kind } };
    this.held.set(sessionId, next);
    this.persist(sessionId, next);
  }

  /** 預かりを出す。未読の数を積む番なら積んで画面へ配り、OS とスマホの出し先があれば流す。 */
  private release(sessionId: string, h: Held): void {
    let count = h.count;
    const now = this.deps.now?.() ?? Date.now();
    // 抜けたときに画面で前に出して見ている会話には、未読を積まず、スマホへも出さない（live/viewing.ts）。
    const viewing = isViewing(sessionId, now);
    if (h.unread && !viewing) {
      count = addUnread(this.deps.db, sessionId, h.text, now);
      touchRow(this.deps.db, 'sessions', sessionId);
    }
    const sent = [...h.sent].filter((x) => !(viewing && x === 'phone'));
    if (sent.length > 0) noteUnreadReady(sessionId, h.text, count, sent, h.meta);
  }
}
