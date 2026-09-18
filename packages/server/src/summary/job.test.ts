import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { isSummaryStale, SummaryJob } from './job.ts';
import { SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput } from './types.ts';

let dir: string; let db: Db; let alphaId: string;
const sent: ServerEvent[] = [];
const out: SummaryOutput = { title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [] };
function fake(id: Summarizer['id'], o: { available?: boolean; fail?: boolean; delayMs?: number; seen?: SummaryInput[]; model?: string } = {}): Summarizer {
  return {
    id,
    available: async () => o.available ?? true,
    summarize: async (input) => { o.seen?.push(input); if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs)); if (o.fail) throw new SummarizerError(id, `${id} failed`); return o.model ? { ...out, model: o.model } : out; },
  };
}
beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:'); sent.length = 0;
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const make = (summarizers: Summarizer[], live: LiveSessionDto[] = []) => new SummaryJob({ db, deviceId: 'd', summarizers: () => summarizers, live: () => live, hub: { broadcast: (e) => sent.push(e) } });

describe('isSummaryStale', () => {
  it('土台のままか 5 ターン以上進んでいれば真', () => {
    expect(isSummaryStale(db, alphaId)).toBe(true);
    upsertShared(db, 'session_summaries', { session_id: alphaId, title: 't', one_liner: 'o', body: 'b', state: 'done', next_steps: '[]', source: 'in_session', source_model: null, based_on_turns: 2 }, 'd', 'session_id');
    expect(isSummaryStale(db, alphaId)).toBe(false);
    db.prepare('update session_stats set turns = 7 where session_id = ?').run(alphaId);
    expect(isSummaryStale(db, alphaId)).toBe(true);
    db.prepare('update session_stats set turns = 6 where session_id = ?').run(alphaId);
    expect(isSummaryStale(db, alphaId)).toBe(false);
    expect(isSummaryStale(db, 'nope')).toBe(false);
  });
});

describe('SummaryJob', () => {
  it('受け付けて pending を配り、要約を post_hoc で書いて配る', async () => {
    const seen: SummaryInput[] = [];
    const job = make([fake('lmstudio', { seen, model: 'qwen3-27b' })]);
    expect(job.enqueue(alphaId)).toBe(true);
    expect(job.enqueue(alphaId)).toBe(false);
    expect(job.pending()).toEqual([alphaId]);
    expect(sent[0]).toEqual({ type: 'summary.pending', sessionId: alphaId });
    await job.idle();
    expect(job.pending()).toEqual([]);
    expect(seen[0]).toMatchObject({ sessionId: alphaId, turns: 2, running: false });
    const row = db.prepare('select * from session_summaries where session_id = ?').get(alphaId) as Record<string, unknown>;
    expect(row).toMatchObject({ title: 'T', source: 'post_hoc', source_model: 'qwen3-27b', based_on_turns: 2 });
    expect(sent.map((e) => e.type)).toEqual(['summary.pending', 'session.upsert', 'summary.updated']);
    expect(job.enqueue(alphaId)).toBe(false);     // もう stale ではない
    expect(job.enqueue(alphaId, true)).toBe(true);
    await job.idle();
  });
  it('使えない要約器を飛ばし、失敗したら次へ。全部だめなら summary.failed', async () => {
    const job = make([fake('lmstudio', { available: false }), fake('claude-headless', { fail: true })]);
    job.enqueue(alphaId);
    await job.idle();
    expect(sent.at(-1)).toEqual({ type: 'summary.failed', sessionId: alphaId, message: 'claude-headless failed' });
    expect((db.prepare('select source from session_summaries where session_id = ?').get(alphaId) as { source: string }).source).toBe('baseline');
    sent.length = 0;
    const job2 = make([fake('lmstudio', { fail: true }), fake('claude-headless', { model: 'haiku' })]);
    job2.enqueue(alphaId);
    await job2.idle();
    expect((db.prepare('select source_model from session_summaries where session_id = ?').get(alphaId) as { source_model: string }).source_model).toBe('haiku');
  });
  it('実行中のセッションは受け付けず、force なら受け付ける。本文の無いセッションも受け付けない', async () => {
    const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'busy', name: null, nameSource: null, cwd: '/x', pid: 1 }];
    const job = make([fake('lmstudio')], live);
    expect(job.enqueue(alphaId)).toBe(false);
    expect(job.enqueue(alphaId, true)).toBe(true);
    await job.idle();
    const beta = (db.prepare("select id from sessions where provider_session_id = 'aaaaaaaa-0000-4000-8000-000000000002'").get() as { id: string }).id;
    expect(job.enqueue(beta, true)).toBe(false);
  });
  it('配信が失敗しても待ち行列は進む', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = { broadcast: (e: ServerEvent) => { sent.push(e); throw new Error('socket closed'); } };
    const job = new SummaryJob({ db, deviceId: 'd', summarizers: () => [fake('lmstudio')], live: () => [], hub: boom });
    const other = (db.prepare("select id from sessions where provider_session_id = 'aaaaaaaa-0000-4000-8000-000000000003'").get() as { id: string }).id;
    expect(job.enqueue(alphaId, true)).toBe(true);
    expect(job.enqueue(other, true)).toBe(true);
    await job.idle();
    expect(job.pending()).toEqual([]);
    for (const id of [alphaId, other]) {
      expect((db.prepare('select source from session_summaries where session_id = ?').get(id) as { source: string }).source).toBe('post_hoc');
    }
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('summary.pending');
    warn.mockRestore();
  });
  it('モデル名を言わない要約器なら source_model は要約器の id に落ちる', async () => {
    const job = make([fake('lmstudio')]);
    job.enqueue(alphaId, true);
    await job.idle();
    expect((db.prepare('select source_model from session_summaries where session_id = ?').get(alphaId) as { source_model: string }).source_model).toBe('lmstudio');
  });
  it('直列に走り、test は DB に書かない', async () => {
    const job = make([fake('lmstudio', { delayMs: 20, model: 'qwen3-27b' })]);
    const beta = (db.prepare("select id from sessions where provider_session_id = 'aaaaaaaa-0000-4000-8000-000000000003'").get() as { id: string }).id;
    job.enqueue(alphaId, true); job.enqueue(beta, true);
    expect(job.pending()).toEqual([alphaId, beta]);
    await job.idle();
    expect(sent.filter((e) => e.type === 'summary.updated').map((e) => (e as { sessionId: string }).sessionId)).toEqual([alphaId, beta]);
    const before = (db.prepare('select count(*) c from changes').get() as { c: number }).c;
    const r = await job.test();
    expect(r).toMatchObject({ ok: true, id: 'lmstudio', summary: { title: 'T', source: 'post_hoc', sourceModel: 'qwen3-27b' } });
    expect((db.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(before);
    const bad = await make([fake('lmstudio', { fail: true }), fake('claude-headless', { available: false })]).test();
    expect(bad).toEqual({ ok: false, tried: [{ id: 'lmstudio', message: 'lmstudio failed' }, { id: 'claude-headless', message: '使えません（接続できないか、上限に達しています）' }] });
  });
});
