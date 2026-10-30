import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';

/**
 * MCP の create_session で起こした会話の起動元を残す。手元だけの表（session_spawns）で、同期しない。
 * 同じ会話を 2 度残したら、後の起動元で置き換える。残したら会話の行を触り、画面の一覧に入れ子を配る。
 */
export function recordSpawn(db: Db, sessionId: string, parentId: string, now: number): void {
  if (sessionId === parentId) return;
  db.prepare(
    'insert into session_spawns (session_id, parent_id, created_at) values (?, ?, ?) '
    + 'on conflict(session_id) do update set parent_id = excluded.parent_id, created_at = excluded.created_at',
  ).run(sessionId, parentId, now);
  touchRow(db, 'sessions', sessionId);
}

/** 利用者が起動元から外した。入れ子も起動元へのリンクも消え、起動元の状態が変わっても戻らない。 */
export function forgetSpawn(db: Db, sessionId: string): void {
  const r = db.prepare('delete from session_spawns where session_id = ?').run(sessionId);
  if (r.changes > 0) touchRow(db, 'sessions', sessionId);
}
