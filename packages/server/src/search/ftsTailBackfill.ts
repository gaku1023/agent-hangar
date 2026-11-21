import type { Db } from '../db/open.ts';

/**
 * 版 66 より前に積んだ event_fts の行へ、末尾の区切り（FTS_TAIL）を足し直す背面の仕事。
 * 版 66 のマイグレーション（db/migrations.ts）は版を上げて印（settings_local の FTS_TAIL_CURSOR_KEY）を置くだけにする。
 * 実データ（百万行台）で一度に直すと数分かかり、その間サーバが立たないためである。
 * 起動の後に、rowid の昇順で少しずつ足す。済んだ rowid を印に覚えるので、止まっても次の起動で続きから進む。
 * 足し直していない行は、末尾の 2 文字が引けないだけで、検索も抜粋も動く。
 * 印が無いときは、直す行が無い（新しい DB や、足し終えた DB）。
 */
export const FTS_TAIL_CURSOR_KEY = 'fts_tail_backfill_rowid';

/** 1 回に直す行数。FTS5 の索引を書き換えるので、主スレッドを長く止めない大きさにする。 */
export const FTS_TAIL_BATCH = 1000;
/** 1 回ごとに空ける間（ミリ秒）。この間にリクエストが通る。 */
const GAP_MS = 25;

function readCursor(db: Db): number | null {
  const row = db.prepare('select value from settings_local where key = ?').get(FTS_TAIL_CURSOR_KEY) as { value: string } | undefined;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 1 回分（既定で FTS_TAIL_BATCH 行）を直す。まだ続きがあれば true、全部済んで印を消したら false。
 * すでに区切りで終わる行（背面で足す前に新しく積んだ行）は触らない。
 */
export function backfillFtsTailStep(db: Db, batch: number = FTS_TAIL_BATCH): boolean {
  const cursor = readCursor(db);
  if (cursor === null) return false;
  const last = db.prepare('select max(rowid) m from (select rowid from event_fts where rowid > ? order by rowid limit ?)').get(cursor, batch) as { m: number | null };
  if (last.m === null) {
    db.prepare('delete from settings_local where key = ?').run(FTS_TAIL_CURSOR_KEY);
    return false;
  }
  db.transaction(() => {
    db.prepare("update event_fts set text = text || char(31) where rowid > ? and rowid <= ? and substr(text, -1) != char(31)").run(cursor, last.m);
    db.prepare('update settings_local set value = ? where key = ?').run(String(last.m), FTS_TAIL_CURSOR_KEY);
  })();
  return true;
}

export interface FtsTailBackfill { start(): void; stop(): void }

/** 起動の後に回す。1 回ごとに短い間を空け、止めるまで、または全部済むまで続ける。 */
export function createFtsTailBackfill(db: Db, opts: { batch?: number; gapMs?: number; onError?: (e: unknown) => void } = {}): FtsTailBackfill {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = (): void => {
    timer = null;
    if (stopped) return;
    let more = false;
    try { more = backfillFtsTailStep(db, opts.batch); } catch (e) { opts.onError?.(e); return; }
    if (more && !stopped) timer = setTimeout(tick, opts.gapMs ?? GAP_MS);
  };
  return {
    start() { if (timer === null && !stopped) timer = setTimeout(tick, opts.gapMs ?? GAP_MS); },
    stop() { stopped = true; if (timer !== null) clearTimeout(timer); timer = null; },
  };
}
