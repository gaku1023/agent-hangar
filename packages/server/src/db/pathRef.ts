import type { Db } from './open.ts';
import { stmt } from '../indexer/statements.ts';

/**
 * 索引（event_index）が指すファイルのパスの番号を返す。無ければ event_paths に足す。
 * 索引は行ごとにパスの文字を持たず、この番号（path_id）で指す。
 */
export function pathRefId(db: Db, path: string): number {
  const found = stmt(db, 'select id from event_paths where path = ?').get(path) as { id: number } | undefined;
  if (found) return found.id;
  return Number(stmt(db, 'insert into event_paths (path) values (?)').run(path).lastInsertRowid);
}
