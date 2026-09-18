import { newId, type TodoDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';

type Row = { id: string; project_id: string; text: string; done: number; position: number; session_id: string | null; updated_at: number };

const toDto = (r: Row): TodoDto => ({ id: r.id, projectId: r.project_id, text: r.text, done: r.done === 1, position: r.position, sessionId: r.session_id, updatedAt: r.updated_at });

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
  return toDto(db.prepare('select * from todos where id = ?').get(id) as Row);
}

/** 完了の印を付け外しする。見つからないときは null を返す。 */
export function setTodoDone(db: Db, deviceId: string, id: string, done: boolean): TodoDto | null {
  const row = db.prepare('select * from todos where id = ? and deleted_at is null').get(id) as Row | undefined;
  if (!row) return null;
  upsertShared(db, 'todos', { ...row, done: done ? 1 : 0 }, deviceId);
  return toDto(db.prepare('select * from todos where id = ?').get(id) as Row);
}

/** 論理削除する。利用者のファイルは消さないので、行は残したまま deleted_at を立てる。 */
export function removeTodo(db: Db, deviceId: string, id: string): TodoDto | null {
  const row = db.prepare('select * from todos where id = ? and deleted_at is null').get(id) as Row | undefined;
  if (!row) return null;
  softDeleteShared(db, 'todos', id, deviceId);
  return toDto(row);
}
