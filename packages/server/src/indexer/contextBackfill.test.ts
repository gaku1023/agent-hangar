import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { CONTEXT_BACKFILL_DONE_KEY, backfillContextStep, createContextBackfill } from './contextBackfill.ts';

let db: Db;
let dir: string;
beforeEach(() => { db = openDb(':memory:'); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxfill-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const usage = (n: number) => ({ input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
const asst = (n: number | null, model = 'claude-test-1', extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant', isSidechain: false, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'assistant', model, content: [], ...(n === null ? {} : { usage: usage(n) }) }, ...extra });

let seq = 0;
/** 会話の行と本文のファイルを作る。stats の context_tokens は ctx（既定 null）。 */
function addSession(content: string, o: { ctx?: number | null; provider?: string } = {}): { sid: string; psid: string } {
  const n = ++seq;
  const sid = `s${n}`; const psid = `p${n}`;
  db.prepare('insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values (?,?,?,?,?,?,?)').run(sid, o.provider ?? 'claude-code', psid, '/w', 'd', 1, 'd');
  db.prepare('insert into session_stats (session_id, turns, context_tokens) values (?,?,?)').run(sid, 1, o.ctx ?? null);
  addFile(psid, content, null);
  return { sid, psid };
}
function addFile(psid: string, content: string, agentId: string | null): void {
  const p = path.join(dir, `${psid}-${agentId ?? 'main'}-${++seq}.jsonl`);
  fs.writeFileSync(p, content);
  db.prepare('insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version, agent) values (?,?,?,?,?,?,?,?,?)').run(p, psid, agentId, 'd', content.length, 1, content.length, 1, 'claude-code');
}
const ctx = (sid: string) => db.prepare('select context_tokens t, context_model m from session_stats where session_id = ?').get(sid) as { t: number | null; m: string | null };
const run = () => { while (backfillContextStep(db, { batch: 2 })) { /* 全部済むまで */ } };

describe('既存の会話の文脈の量の補完', () => {
  it('本文の末尾から、最後の usage の和とモデルを拾う', () => {
    const a = addSession(asst(100, 'claude-a') + asst(250, 'claude-b') + line({ type: 'user', message: { role: 'user', content: 'x' } }));
    run();
    expect(ctx(a.sid)).toEqual({ t: 250, m: 'claude-b' });
  });
  it('末尾の 256KB に無ければ範囲を広げて拾う', () => {
    const filler = line({ type: 'user', message: { role: 'user', content: 'y'.repeat(1000) } });
    const a = addSession(asst(777) + filler.repeat(600));
    run();
    expect(ctx(a.sid).t).toBe(777);
  });
  it('サブエージェントのファイルと sidechain の記録、usage の無い記録を飛ばす', () => {
    const a = addSession(asst(300) + asst(900, 'claude-x', { isSidechain: true }) + asst(null));
    addFile(a.psid, asst(5), 'sub1');
    run();
    expect(ctx(a.sid)).toEqual({ t: 300, m: 'claude-test-1' });
  });
  it('埋まっている行は上書きしない', () => {
    const a = addSession(asst(300), { ctx: 42 });
    run();
    expect(ctx(a.sid).t).toBe(42);
  });
  it('Claude 以外の会話と、値の無い会話は触らない', () => {
    const c = addSession(asst(1), { provider: 'codex' });
    const e = addSession(line({ type: 'user', message: { role: 'user', content: 'x' } }));
    run();
    expect(ctx(c.sid).t).toBeNull();
    expect(ctx(e.sid).t).toBeNull();
  });
  it('済みの印を立て、2 回目は動かない', () => {
    const a = addSession(asst(10));
    run();
    expect(db.prepare('select value from settings_local where key = ?').get(CONTEXT_BACKFILL_DONE_KEY)).toBeTruthy();
    const b = addSession(asst(20));
    run();
    expect(ctx(b.sid).t).toBeNull();
    expect(ctx(a.sid).t).toBe(10);
  });
  it('埋めた会話の行を名指しして画面に知らせる', () => {
    const touched: string[] = [];
    const off = onRowChange((c) => { if (c.table === 'sessions' && c.origin === 'touch') touched.push(c.rowId); });
    const a = addSession(asst(10));
    run();
    off();
    expect(touched).toEqual([a.sid]);
  });
  it('背面の仕事は、イベントループを返しながら全部を済ませる', async () => {
    const all = [addSession(asst(1)), addSession(asst(2)), addSession(asst(3))];
    const job = createContextBackfill(db, { batch: 1, gapMs: 1 });
    job.start();
    await new Promise((r) => setTimeout(r, 300));
    job.stop();
    expect(all.map((s) => ctx(s.sid).t)).toEqual([1, 2, 3]);
  });
});
