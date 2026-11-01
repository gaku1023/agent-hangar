import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';

export type UnreadRow = { count: number; latest: string | null; at: number };

/**
 * notify_user の 1 回を積む。count を 1 つ増やし、最後の本文と時刻を置き換える。戻り値は積んだ後の count である。
 * 手元だけの表（session_unread）で、同期しない。
 */
export function addUnread(db: Db, sessionId: string, text: string, now: number): number {
  db.prepare(
    'insert into session_unread (session_id, count, latest_text, latest_at) values (?, 1, ?, ?) '
    + 'on conflict(session_id) do update set count = count + 1, latest_text = excluded.latest_text, latest_at = excluded.latest_at',
  ).run(sessionId, text, now);
  return (db.prepare('select count from session_unread where session_id = ?').get(sessionId) as { count: number }).count;
}

/**
 * 利用者が未読に戻す。未読が無いときだけ 1 にし、エージェントの知らせではないので本文は持たない。
 * すでに未読があれば、数も本文も変えない。OS とスマホへは知らせない（noteUnread を呼ばない）。
 */
export function markUnread(db: Db, sessionId: string, now: number): void {
  const r = db.prepare('insert into session_unread (session_id, count, latest_text, latest_at) values (?, 1, null, ?) on conflict(session_id) do nothing').run(sessionId, now);
  if (r.changes > 0) touchRow(db, 'sessions', sessionId);
}

/** 既読にする。行が無ければ何もせず、false を返す（画面へも配らない）。 */
export function markSeen(db: Db, sessionId: string): boolean {
  const r = db.prepare('delete from session_unread where session_id = ?').run(sessionId);
  if (r.changes === 0) return false;
  touchRow(db, 'sessions', sessionId);
  return true;
}

/** 未読の行を DTO の形にする。開くと行ごと消すので、count が 1 以上の行だけが来る。無ければ null。 */
export function unreadOf(row: { unread_count: number | null; unread_text: string | null; unread_at: number | null }): UnreadRow | null {
  if (row.unread_count === null || row.unread_count <= 0) return null;
  return { count: row.unread_count, latest: row.unread_text, at: row.unread_at ?? 0 };
}

/** notify_user の出し先。unread は未読の数、os は OS の通知、phone はスマホの通知。 */
export const NOTIFY_TARGETS = ['unread', 'os', 'phone'] as const;
export type NotifyTarget = (typeof NOTIFY_TARGETS)[number];

type UnreadListener = (sessionId: string, text: string, count: number, sent: NotifyTarget[]) => void;
const unreadListeners = new Set<UnreadListener>();

/**
 * 未読が増えたときの購読を足す。戻り値を呼ぶと外す。
 * 知らせるのは書いた側（mcp/tools.ts の notifyUserTool）で、addUnread の後に noteUnread を呼ぶ。onIntent と同じ形である。
 * OS の通知とスマホの通知が、この購読で動く。
 */
export function onUnread(cb: UnreadListener): () => void {
  unreadListeners.add(cb);
  return () => { unreadListeners.delete(cb); };
}

/** 知らせを購読へ渡す。sent は設定を通って実際に出す先で、購読者は os と phone を見て送る。count は積んだ後の数（unread を出さなかったときは今の数）。購読が投げても、書いた側にも他の購読にも波及させない。 */
export function noteUnread(sessionId: string, text: string, count: number, sent: NotifyTarget[]): void {
  for (const cb of unreadListeners) {
    try { cb(sessionId, text, count, sent); } catch (e) { console.error('[unread] a listener failed', e instanceof Error ? e.constructor.name : typeof e); }
  }
}
