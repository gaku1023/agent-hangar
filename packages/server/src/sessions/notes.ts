import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

/**
 * セッションの名前とメモ（session_notes）。利用者と Claude が付けるもので、索引は書かない。
 *
 * sessions の列にしないのは、sessions の行が索引のたびに全列で書き直され、同期が行ごとの後勝ちなので、
 * 別の PC で付けた名前やメモが、本文を持つ PC の索引で上書きされるからである（session_states と同じ理由）。
 * 書き手は、起動のときの名前（runs/manager.ts）、画面のメモ（HTTP）、MCP の set_session_memo である。
 * 索引が本文から拾う題名（Claude Code の側で付けた名前）は別の事実で、sessions.custom_title にある。
 *
 * ここの書き込みは upsertShared を通るので、行の変化の口（db/notify.ts）へ自動で知らされ、
 * 配る層（events/publisher.ts）が当のセッションの session.upsert を配る。
 */

type NoteRow = { session_id: string; name: string | null; memo: string | null; updated_at: number; deleted_at: number | null; origin_device: string };
export type SessionNote = { name: string | null; memo: string | null };

/** 今の名前とメモ。行が無いか論理削除されていれば null。 */
export function getSessionNote(db: Db, sessionId: string): SessionNote | null {
  const r = db.prepare('select name, memo from session_notes where session_id = ? and deleted_at is null').get(sessionId) as SessionNote | undefined;
  return r ?? null;
}

/**
 * 今の行（無ければ空）に差分を重ねて書く。updated_at と origin_device は upsertShared が補う。
 * 重ねた結果が今と同じなら書かない。行の無いところへ空を書いて、空の行を作ることもしない。
 * 空の行は新しい時刻を持つので、同期で他の PC の名前やメモに勝ってしまう。
 */
function write(db: Db, deviceId: string, sessionId: string, patch: Partial<SessionNote>): void {
  const live = getSessionNote(db, sessionId);
  const cur = live ?? { name: null, memo: null };
  const next = { ...cur, ...patch };
  if (next.name === cur.name && next.memo === cur.memo) return;
  if (!live && !next.name && !next.memo) return;
  const row: Omit<NoteRow, 'updated_at' | 'origin_device'> = { session_id: sessionId, name: next.name, memo: next.memo, deleted_at: null };
  upsertShared(db, 'session_notes', row, deviceId, 'session_id');
}

/** hangar で付けた名前を書く。null で外す。整形（前後の空白など）は呼び手が済ませる。 */
export function setSessionName(db: Db, deviceId: string, sessionId: string, name: string | null): void {
  write(db, deviceId, sessionId, { name });
}

/** メモを書く。null で外す。整形は呼び手が済ませる。 */
export function setSessionMemo(db: Db, deviceId: string, sessionId: string, memo: string | null): void {
  write(db, deviceId, sessionId, { memo });
}

/**
 * 要約の題名の手がかりにする名前。本文から拾った題名（sessions.custom_title）、hangar で付けた名前の順に採る。
 * 表示名（db/queries.ts の displayName）と同じ順である。どちらも無いか、セッションが無ければ null。
 */
export function sessionTitleOf(db: Db, sessionId: string): string | null {
  const r = db.prepare('select s.custom_title t, n.name n from sessions s left join session_notes n on n.session_id = s.id and n.deleted_at is null where s.id = ?').get(sessionId) as { t: string | null; n: string | null } | undefined;
  return r ? (r.t || r.n || null) : null;
}
