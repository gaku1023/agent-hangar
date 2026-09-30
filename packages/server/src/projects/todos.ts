import { newId, type TodoDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';

type Row = {
  id: string; project_id: string; text: string; done: number; position: number; session_id: string | null; updated_at: number;
  candidate_at: number | null; candidate_session_id: string | null; candidate_note: string | null; rejected_sessions: string;
};

/** 根拠の一文の上限（空白を除いた字数）。 */
export const CANDIDATE_NOTE_MAX = 200;

// 完了かつ候補という矛盾は同期の競り合いでしか起きない。完了を正とし、候補は無いものとして読む（書き直しはしない）。
const toDto = (r: Row): TodoDto => ({
  id: r.id, projectId: r.project_id, text: r.text, done: r.done === 1, position: r.position, sessionId: r.session_id, updatedAt: r.updated_at,
  candidate: r.candidate_at !== null && r.done !== 1 ? { sessionId: r.candidate_session_id, note: r.candidate_note, at: r.candidate_at } : null,
});

const NO_CANDIDATE = { candidate_at: null, candidate_session_id: null, candidate_note: null };

const liveRow = (db: Db, id: string) => db.prepare('select * from todos where id = ? and deleted_at is null').get(id) as Row | undefined;
const reread = (db: Db, id: string) => toDto(db.prepare('select * from todos where id = ?').get(id) as Row);

/** 却下されたセッションの一覧。壊れた値は空として読む。候補を出す道を投げて止めるより、出せてしまう方が害が小さい。 */
function rejectedOf(r: Row): string[] {
  try {
    const v: unknown = JSON.parse(r.rejected_sessions);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 生きている TODO を返す。projectId を省くとすべてのプロジェクトをまとめて返す。 */
export function listTodos(db: Db, projectId?: string): TodoDto[] {
  const rows = projectId
    ? db.prepare('select * from todos where project_id = ? and deleted_at is null order by position, id').all(projectId)
    : db.prepare('select * from todos where deleted_at is null order by project_id, position, id').all();
  return (rows as Row[]).map(toDto);
}

/** 末尾に足す。position は削除した行も含めた最大値の次で、番号を再利用しない。 */
export function addTodo(db: Db, deviceId: string, o: { projectId: string; text: string; sessionId?: string | null }): TodoDto {
  const text = o.text.trim();
  if (!text) throw new Error('TODO の本文が空です');
  const max = (db.prepare('select max(position) m from todos where project_id = ?').get(o.projectId) as { m: number | null }).m ?? 0;
  const id = newId();
  upsertShared(db, 'todos', { id, project_id: o.projectId, text, done: 0, position: max + 1, session_id: o.sessionId ?? null }, deviceId);
  return reread(db, id);
}

/** 完了の印を付け外しする。利用者の操作なので、候補の印もあわせて消す。見つからないときは null を返す。 */
export function setTodoDone(db: Db, deviceId: string, id: string, done: boolean): TodoDto | null {
  const row = liveRow(db, id);
  if (!row) return null;
  upsertShared(db, 'todos', { ...row, ...NO_CANDIDATE, done: done ? 1 : 0 }, deviceId);
  return reread(db, id);
}

export type ProposeOutcome = 'proposed' | 'already_candidate' | 'already_done' | 'rejected_before';

/**
 * 完了の候補にする。完了にはしない（完了にするのは利用者だけ）。見つからないときは null を返す。
 * すでに候補なら根拠を上書きしない。利用者が読んでいる最中に中身が差し替わらないようにするためである。
 */
export function proposeTodoDone(db: Db, deviceId: string, id: string, o: { sessionId: string | null; note: string | null; now?: number }): { todo: TodoDto; outcome: ProposeOutcome } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (row.done === 1) return { todo: toDto(row), outcome: 'already_done' };
  if (row.candidate_at !== null) return { todo: toDto(row), outcome: 'already_candidate' };
  if (o.sessionId !== null && rejectedOf(row).includes(o.sessionId)) return { todo: toDto(row), outcome: 'rejected_before' };
  upsertShared(db, 'todos', { ...row, candidate_at: o.now ?? Date.now(), candidate_session_id: o.sessionId, candidate_note: o.note }, deviceId);
  return { todo: reread(db, id), outcome: 'proposed' };
}

export type ConfirmResult = 'confirmed' | 'already_done' | 'not_candidate';

/** 候補を確定して完了にする。すでに完了なら何もしない。見つからないときは null を返す。 */
export function confirmTodo(db: Db, deviceId: string, id: string): { todo: TodoDto; result: ConfirmResult } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (row.done === 1) return { todo: toDto(row), result: 'already_done' };
  if (row.candidate_at === null) return { todo: toDto(row), result: 'not_candidate' };
  upsertShared(db, 'todos', { ...row, ...NO_CANDIDATE, done: 1 }, deviceId);
  return { todo: reread(db, id), result: 'confirmed' };
}

export type RejectResult = 'rejected' | 'not_candidate';

/**
 * 候補を却下して未完に戻す。出したセッションを rejected_sessions に一度だけ積む。
 * セッションの分からない候補は積まない（積む鍵が無いので、出し直しは止められない）。
 */
export function rejectTodo(db: Db, deviceId: string, id: string): { todo: TodoDto; result: RejectResult } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (row.done === 1 || row.candidate_at === null) return { todo: toDto(row), result: 'not_candidate' };
  const rejected = rejectedOf(row);
  const sid = row.candidate_session_id;
  const next = sid !== null && !rejected.includes(sid) ? [...rejected, sid] : rejected;
  upsertShared(db, 'todos', { ...row, ...NO_CANDIDATE, rejected_sessions: JSON.stringify(next) }, deviceId);
  return { todo: reread(db, id), result: 'rejected' };
}

/** 論理削除する。利用者のファイルは消さないので、行は残したまま deleted_at を立てる。 */
export function removeTodo(db: Db, deviceId: string, id: string): TodoDto | null {
  const row = liveRow(db, id);
  if (!row) return null;
  softDeleteShared(db, 'todos', id, deviceId);
  return toDto(row);
}
