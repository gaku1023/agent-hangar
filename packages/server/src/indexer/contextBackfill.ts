import fs from 'node:fs';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { recordFacts } from '../provider/claude-code/transcript/normalize.ts';

/**
 * 版 72 より前に索引へ入った Claude の会話の、文脈の量（session_stats.context_tokens、context_model）を埋める背面の仕事。
 * 値は索引が本文を読み直したときに付くが、止まった会話の大半は読み直されない。そこで起動の後に一度だけ、
 * 値が null で手元に本文のファイルがある会話（手元の会話と、他端末から降ろした写し）の本文を末尾から読み、主線の最後の usage を拾う。
 * 式は索引（recordFacts の contextTokens）と同じ。ファイルは末尾の一部だけを読み、見つからなければ範囲を広げる。
 * 済んだことは settings_local の印（CONTEXT_BACKFILL_DONE_KEY）に覚え、次の起動では動かない。途中の位置も印（CONTEXT_BACKFILL_CURSOR_KEY）に持つので、止まっても続きから進む。
 * 値が見つからなかった会話は null のまま残す（その会話の本文が次に読み直されれば、索引が書く）。Codex と opencode は対象外である。
 */
export const CONTEXT_BACKFILL_DONE_KEY = 'context_backfill_done';
export const CONTEXT_BACKFILL_CURSOR_KEY = 'context_backfill_cursor';

/** 1 回に処理する会話の数。 */
export const CONTEXT_BACKFILL_BATCH = 20;
/** 1 回ごとに空ける間（ミリ秒）。この間にリクエストが通る。 */
const GAP_MS = 25;
/** 末尾から最初に読む大きさと、広げる上限。 */
const FIRST_TAIL = 256 * 1024;
const MAX_TAIL = 16 * 1024 * 1024;

type Found = { tokens: number; model: string | null };

function readTail(fd: number, size: number, want: number): { text: string; whole: boolean } {
  const len = Math.min(size, want);
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, size - len + got);
    if (n <= 0) break;
    got += n;
  }
  return { text: buf.subarray(0, got).toString('utf8'), whole: len >= size };
}

/** 本文の末尾から、主線の最後の usage を持つ assistant の記録を探す。範囲を広げても見つからなければ null。 */
export function findLastContext(file: string): Found | null {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    for (let want = FIRST_TAIL; ; want *= 4) {
      const { text, whole } = readTail(fd, size, want);
      const lines = text.split('\n');
      // 途中から読んだときの先頭の行は欠けているので捨てる。
      if (!whole) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!;
        if (l === '' || !l.includes('"assistant"')) continue;
        let rec: unknown;
        try { rec = JSON.parse(l); } catch { continue; }
        if (typeof rec !== 'object' || rec === null || (rec as { isSidechain?: unknown }).isSidechain === true) continue;
        const f = recordFacts(rec);
        if (f.contextTokens !== undefined) return { tokens: f.contextTokens, model: f.model ?? null };
      }
      if (whole || want >= MAX_TAIL) return null;
    }
  } catch { return null; } finally { fs.closeSync(fd); }
}

function setMark(db: Db, key: string, value: string): void {
  db.prepare('insert into settings_local (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
}

/**
 * 1 回分（既定で CONTEXT_BACKFILL_BATCH 会話）を埋める。まだ続きがあれば true、全部済んで印を立てたら（済んでいれば初めから）false。
 */
export function backfillContextStep(db: Db, o: { batch?: number } = {}): boolean {
  if (db.prepare('select 1 from settings_local where key = ?').get(CONTEXT_BACKFILL_DONE_KEY)) return false;
  const cursor = (db.prepare('select value from settings_local where key = ?').get(CONTEXT_BACKFILL_CURSOR_KEY) as { value: string } | undefined)?.value ?? '';
  const rows = db.prepare(`select s.id id, s.provider_session_id psid from sessions s join session_stats st on st.session_id = s.id
    where s.provider = 'claude-code' and st.context_tokens is null and s.id > ? order by s.id limit ?`).all(cursor, o.batch ?? CONTEXT_BACKFILL_BATCH) as { id: string; psid: string }[];
  if (rows.length === 0) { setMark(db, CONTEXT_BACKFILL_DONE_KEY, '1'); db.prepare('delete from settings_local where key = ?').run(CONTEXT_BACKFILL_CURSOR_KEY); return false; }
  const files = db.prepare("select path from transcript_files where session_id = ? and agent_id is null and agent = 'claude-code' order by mtime desc");
  const write = db.prepare('update session_stats set context_tokens = ?, context_model = ? where session_id = ? and context_tokens is null');
  for (const r of rows) {
    for (const f of files.all(r.psid) as { path: string }[]) {
      const found = findLastContext(f.path);
      if (!found) continue;
      if (write.run(found.tokens, found.model, r.id).changes > 0) touchRow(db, 'sessions', r.id);
      break;
    }
  }
  setMark(db, CONTEXT_BACKFILL_CURSOR_KEY, rows[rows.length - 1]!.id);
  return true;
}

export interface ContextBackfill { start(): void; stop(): void }

/** 起動の後に回す。1 回ごとに短い間を空け、止めるまで、または全部済むまで続ける。 */
export function createContextBackfill(db: Db, opts: { batch?: number; gapMs?: number; onError?: (e: unknown) => void } = {}): ContextBackfill {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = (): void => {
    timer = null;
    if (stopped) return;
    let more = false;
    try { more = backfillContextStep(db, { batch: opts.batch }); } catch (e) { opts.onError?.(e); return; }
    if (more && !stopped) timer = setTimeout(tick, opts.gapMs ?? GAP_MS);
  };
  return {
    start() { if (timer === null && !stopped) timer = setTimeout(tick, opts.gapMs ?? GAP_MS); },
    stop() { stopped = true; if (timer !== null) clearTimeout(timer); timer = null; },
  };
}
