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

/**
 * event_index の行（別名 e）が指すファイルのパスを返す SQL の式。
 * 番号（path_id）で指す行はその表から、埋め終えていない旧い行（path_id が null）は旧い列（file_path_ref）から読む。
 */
export const EVENT_PATH_SQL = "coalesce((select p.path from event_paths p where p.id = e.path_id), e.file_path_ref)";

/**
 * 旧い列（file_path_ref）でパスを持つ行のうち、id の小さいほうから limit 行に番号を振り、旧い列を空にする。振った行数を返す（0 なら埋め終わり）。
 * 旧い列の NOT NULL は後から外せないので、空の文字で埋める。空にすると、行が縮んで頁の中に空きができ、後の書き込みが使い回す。
 * 1 回は 1 つの取引で、途中で止まっても、振った行は番号のまま、残りは旧い列のままで、次の呼びが続きから振る。
 */
export function fillPathRefs(db: Db, limit = 5000): number {
  return db.transaction(() => {
    const ids = (stmt(db, 'select id from event_index where path_id is null and file_path_ref <> \'\' order by id limit ?').all(limit) as { id: number }[]).map((r) => r.id);
    if (ids.length === 0) return 0;
    const lo = ids[0]!;
    const hi = ids[ids.length - 1]!;
    // 範囲の中に、振り終えた行や旧い列が空の行が混じっても、条件で絞る。
    stmt(db, "insert or ignore into event_paths (path) select distinct file_path_ref from event_index where id between ? and ? and path_id is null and file_path_ref <> ''").run(lo, hi);
    return stmt(db, "update event_index set path_id = (select p.id from event_paths p where p.path = event_index.file_path_ref), file_path_ref = '' where id between ? and ? and path_id is null and file_path_ref <> ''").run(lo, hi).changes;
  })();
}

export type PathRefFillOptions = { limit?: number; delayMs?: number; onDone?: () => void };

/**
 * 起動の後ろで、埋め終えるまで fillPathRefs を 1 回ずつ間を置いて呼ぶ。返す関数で止める。
 * 1 回ごとに待ちを挟み、その間にほかの処理（イベントループ、DB の書き込み）が入れるようにする。失敗しても落とさず、次の起動で続きから振る。
 */
export function startPathRefFill(db: Db, opts: PathRefFillOptions = {}): () => void {
  const delay = opts.delayMs ?? 50;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = (): void => {
    if (stopped) return;
    try {
      if (fillPathRefs(db, opts.limit) === 0) { opts.onDone?.(); return; }
    } catch (e) {
      console.error('[db] path number fill stopped', e instanceof Error ? e.message : e);
      return;
    }
    timer = setTimeout(step, delay);
    timer.unref();
  };
  timer = setTimeout(step, delay);
  timer.unref();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
