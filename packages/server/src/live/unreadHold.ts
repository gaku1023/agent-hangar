import type { LiveSessionDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { noteUnreadReady, onUnread, type NotifyTarget, type UnreadMeta } from './unread.ts';

/**
 * notify_user の OS の通知とスマホの通知を、そのターンが終わるまで預かる（2026-11-05）。
 *
 * エージェントは、最後の返答を書く前に notify_user を呼ぶ（起動時の指示がそう頼む）。
 * これまでは呼ばれた時点で通知を出していたので、通知を押して開いても、返答がまだ書かれていないことがあった。
 * そこで done と ask は、その会話の登録が作業中（busy、または許可待ち）を抜けるまで預かり、抜けたら出す。
 * 抜けるのは、返答を書き終えて入力を待つとき（idle、問いの waiting）と、run が居なくなったときである。
 * 許可待ちでは出さない。返答はまだ途中で、許可の通知は別に出るからである。
 * progress は途中の報告なので、預からずにすぐ出す（利用者が 2026-11-05 に選んだ）。
 * 未読の数（unread）は預からない。書いた側（notifyUserTool）がその場で積む。
 */

/** 預かっている知らせ。同じ会話の分は 1 つにまとめ、本文は最後のもの、出し先は合わせたものにする。 */
type Held = { text: string; count: number; sent: Set<NotifyTarget>; meta: UnreadMeta };

export type UnreadHoldDeps = {
  db: Db;
  /** いまの実行中の一覧（agent/liveHub.ts の LiveHub.current）。 */
  live: () => LiveSessionDto[];
};

/** 登録の 1 行が、まだターンの途中か。作業中と、許可を待っている間を途中とみなす。 */
export const turnRunning = (l: Pick<LiveSessionDto, 'status' | 'waitingFor'>): boolean =>
  l.status === 'busy' || (l.status === 'waiting' && l.waitingFor === 'permission');

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
      if (this.running(live, id)) continue;
      this.held.delete(id);
      noteUnreadReady(id, h.text, h.count, [...h.sent], h.meta);
    }
  }

  private take(sessionId: string, text: string, count: number, sent: NotifyTarget[], meta: UnreadMeta): void {
    const out = sent.filter((x) => x !== 'unread');
    if (out.length === 0) return;
    if (meta.kind === 'progress' || meta.immediate || !this.running(this.deps.live(), sessionId)) {
      noteUnreadReady(sessionId, text, count, out, meta);
      return;
    }
    const prev = this.held.get(sessionId);
    const merged = new Set<NotifyTarget>([...(prev?.sent ?? []), ...out]);
    // ask は done より利用者の手が要るので、どちらかが ask なら ask として出す。
    const kind = prev?.meta.kind === 'ask' ? 'ask' : meta.kind;
    this.held.set(sessionId, { text, count, sent: merged, meta: { ...meta, kind } });
  }

  /** 会話（hangar の id）の run が、いまターンの途中か。登録に居なければ途中ではない。 */
  private running(live: LiveSessionDto[], sessionId: string): boolean {
    const r = this.deps.db.prepare('select provider, provider_session_id from sessions where id = ?').get(sessionId) as { provider: string; provider_session_id: string } | undefined;
    if (!r) return false;
    const l = live.find((x) => x.sessionId === r.provider_session_id && (x.agent ?? 'claude-code') === r.provider);
    return !!l && turnRunning(l);
  }
}
