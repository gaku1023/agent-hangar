import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

/**
 * セッションの名前（session_notes）。利用者と Claude が付けるもので、索引は書かない。
 *
 * sessions の列にしないのは、sessions の行が索引のたびに全列で書き直され、同期が行ごとの後勝ちなので、
 * 別の PC で付けた名前が、本文を持つ PC の索引で上書きされるからである（session_states と同じ理由）。
 * 書き手は、起動のときの名前（runs/manager.ts）である。
 * 索引が本文から拾う題名（Claude Code の側で付けた名前）は別の事実で、sessions.custom_title にある。
 * 表の名前が notes なのは、ノート（memo）の列も持っていた頃の名残である。ノートは 0.4.0 で外した（版 21）。
 *
 * ここの書き込みは upsertShared を通るので、行の変化の口（db/notify.ts）へ自動で知らされ、
 * 配る層（events/publisher.ts）が当のセッションの session.upsert を配る。
 */

type NoteRow = { session_id: string; name: string | null; updated_at: number; deleted_at: number | null; origin_device: string };
export type SessionNote = { name: string | null };

/** 今の名前。行が無いか論理削除されていれば null。 */
export function getSessionNote(db: Db, sessionId: string): SessionNote | null {
  const r = db.prepare('select name from session_notes where session_id = ? and deleted_at is null').get(sessionId) as SessionNote | undefined;
  return r ?? null;
}

/**
 * hangar で付けた名前を書く。null で外す。整形（前後の空白など）は呼び手が済ませる。updated_at と origin_device は upsertShared が補う。
 * 今と同じなら書かない。行の無いところへ空を書いて、空の行を作ることもしない。
 * 空の行は新しい時刻を持つので、同期で他の PC の名前に勝ってしまう。
 */
export function setSessionName(db: Db, deviceId: string, sessionId: string, name: string | null): void {
  const live = getSessionNote(db, sessionId);
  if (live && live.name === name) return;
  if (!live && !name) return;
  const row: Omit<NoteRow, 'updated_at' | 'origin_device'> = { session_id: sessionId, name, deleted_at: null };
  upsertShared(db, 'session_notes', row, deviceId, 'session_id');
}

/**
 * 要約の題名の手がかりにする名前。本文から拾った題名（sessions.custom_title）、hangar で付けた名前の順に採る。
 * 表示名（db/queries.ts の displayName）と同じ順である。どちらも無いか、セッションが無ければ null。
 */
export function sessionTitleOf(db: Db, sessionId: string): string | null {
  const r = db.prepare('select s.custom_title t, n.name n from sessions s left join session_notes n on n.session_id = s.id and n.deleted_at is null where s.id = ?').get(sessionId) as { t: string | null; n: string | null } | undefined;
  return r ? (r.t || r.n || null) : null;
}
