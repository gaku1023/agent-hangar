import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { repointPins } from '../sessions/move.ts';

/**
 * プロジェクト from の中身（セッション、TODO、成果物、メモ）を into へ移す。場所の行とプロジェクトの行には触らない。
 * from へ移したセッション（sessions/move.ts）の移した先（session_states.project_id）も into へ付け替える。
 * TODO は into の後ろに、元の順で並べる。
 * メモは、into が空なら移し、両方にあれば into の後ろへ空行を挟んでつなぐ。
 * 呼ぶ側のトランザクションの中で呼ぶ。プロジェクトをまとめる（registry.ts の mergeProjects）ときと、
 * PC ごとのクイックセッションのプロジェクトを 1 つにまとめる（scratch.ts の ensureScratchProject）ときに使う。
 * 何か 1 行でも移したら真を返す。移すものが無ければ何も書かない。
 */
export function moveProjectContents(db: Db, deviceId: string, fromId: string, intoId: string): boolean {
  let moved = false;
  for (const s of db.prepare('select * from sessions where project_id = ?').all(fromId) as Record<string, unknown>[]) { upsertShared(db, 'sessions', { ...s, project_id: intoId }, deviceId); moved = true; }
  if (repointPins(db, deviceId, fromId, intoId) > 0) moved = true;
  let position = (db.prepare('select coalesce(max(position), -1) m from todos where project_id = ?').get(intoId) as { m: number }).m;
  for (const t of db.prepare('select * from todos where project_id = ? order by position, id').all(fromId) as Record<string, unknown>[]) { upsertShared(db, 'todos', { ...t, project_id: intoId, position: ++position }, deviceId); moved = true; }
  for (const a of db.prepare('select * from artifacts where project_id = ?').all(fromId) as Record<string, unknown>[]) { upsertShared(db, 'artifacts', { ...a, project_id: intoId }, deviceId); moved = true; }

  const memoOf = db.prepare('select markdown from project_memos where project_id = ? and deleted_at is null');
  const fromMemo = (memoOf.get(fromId) as { markdown: string } | undefined)?.markdown ?? '';
  if (fromMemo.trim() !== '') {
    const intoMemo = (memoOf.get(intoId) as { markdown: string } | undefined)?.markdown ?? '';
    const markdown = intoMemo.trim() === '' ? fromMemo : `${intoMemo.replace(/\s+$/, '')}\n\n${fromMemo}`;
    upsertShared(db, 'project_memos', { project_id: intoId, markdown, deleted_at: null }, deviceId, 'project_id');
    moved = true;
  }
  if (db.prepare('select 1 from project_memos where project_id = ? and deleted_at is null').get(fromId)) { softDeleteShared(db, 'project_memos', fromId, deviceId, 'project_id'); moved = true; }
  return moved;
}
