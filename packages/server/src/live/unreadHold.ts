import type { LiveSessionDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { addUnread, noteUnreadReady, onUnread, type NotifyTarget, type UnreadMeta } from './unread.ts';

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
  (l.status === 'busy' && !l.aside) || (l.status === 'waiting' && l.waitingFor === 'permission');

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

  /** notify_user の知らせ（onUnread）を聞き始める。戻り値を呼ぶと外す。 */
  start(): () => void {
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
      this.release(id, h);
    }
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
    this.held.set(sessionId, { text, sent: merged, unread: unread || (prev?.unread ?? false), count, meta: { ...rest, kind } });
  }

  /** 預かりを出す。未読の数を積む番なら積んで画面へ配り、OS とスマホの出し先があれば流す。 */
  private release(sessionId: string, h: Held): void {
    let count = h.count;
    if (h.unread) {
      count = addUnread(this.deps.db, sessionId, h.text, this.deps.now?.() ?? Date.now());
      touchRow(this.deps.db, 'sessions', sessionId);
    }
    if (h.sent.size > 0) noteUnreadReady(sessionId, h.text, count, [...h.sent], h.meta);
  }
}
