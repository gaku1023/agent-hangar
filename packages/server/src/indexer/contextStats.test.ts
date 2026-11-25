import { beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import type { IndexBatch, IndexRecord } from '../agent/types.ts';
import { writeBatch } from './write.ts';

// 記録から出した文脈の量（session_stats.context_tokens、context_model）。statusline が無い会話の輪と数字に使う。
let db: Db;
const DEV = 'dev-1';
const SID = 'cc-0123';
const TS = Date.parse('2026-10-20T10:00:00.000Z');
beforeEach(() => { db = openDb(':memory:'); });
const stats = (sid = SID) => db.prepare('select s.context_tokens, s.context_model from session_stats s join sessions x on x.id = s.session_id where x.provider_session_id = ?').get(sid) as { context_tokens: number | null; context_model: string | null } | undefined;
const rec = (seq: number, ctx: number | undefined, model = 'claude-test-1'): IndexRecord => {
  const events: TranscriptEvent[] = [{ kind: 'assistant', seq, ts: TS + seq, text: 'a' }];
  return { events, facts: { isUserTurn: false, ts: TS + seq, cwd: '/w', model, ...(ctx !== undefined ? { contextTokens: ctx } : {}) }, locator: { kind: 'stored' } };
};
const batch = (records: IndexRecord[], o: { reset?: boolean; agentId?: string | null } = {}): IndexBatch =>
  ({ agent: 'claude-code', providerSessionId: SID, agentId: o.agentId ?? null, reset: o.reset ?? false, records });

describe('記録から出す文脈の量', () => {
  it('手元の主線は、最後の記録の値とモデルを session_stats に書き、live_stats には触れない', () => {
    writeBatch(db, batch([rec(0, 100), rec(1, 250, 'claude-test-2'), rec(2, undefined)], { reset: true }), { deviceId: DEV });
    expect(stats()).toEqual({ context_tokens: 250, context_model: 'claude-test-2' });
    expect(db.prepare('select count(*) n from session_live_stats').get()).toEqual({ n: 0 });
  });
  it('続きの束では最後の値で置き換え、値の無い束は残す', () => {
    writeBatch(db, batch([rec(0, 100)], { reset: true }), { deviceId: DEV });
    writeBatch(db, batch([rec(1, 300)]), { deviceId: DEV });
    expect(stats()).toMatchObject({ context_tokens: 300 });
    writeBatch(db, batch([rec(2, undefined)]), { deviceId: DEV });
    expect(stats()).toMatchObject({ context_tokens: 300 });
  });
  it('作り直しでは前の値を捨てる', () => {
    writeBatch(db, batch([rec(0, 900)], { reset: true }), { deviceId: DEV });
    writeBatch(db, batch([rec(0, 40)], { reset: true }), { deviceId: DEV });
    expect(stats()).toMatchObject({ context_tokens: 40 });
    writeBatch(db, batch([rec(0, undefined)], { reset: true }), { deviceId: DEV });
    expect(stats()).toMatchObject({ context_tokens: null });
  });
  it('サブエージェントの束の値で本線を上書きしない', () => {
    writeBatch(db, batch([rec(0, 500)], { reset: true }), { deviceId: DEV });
    writeBatch(db, batch([rec(0, 7)], { reset: true, agentId: 'sub1' }), { deviceId: DEV });
    expect(stats()).toMatchObject({ context_tokens: 500 });
  });
  it('他端末の写しにも書く（会話の行が届いていれば）', () => {
    writeBatch(db, batch([rec(0, 1)], { reset: true }), { deviceId: DEV });
    writeBatch(db, batch([rec(0, 123)], { reset: true }), { deviceId: DEV, remote: true, origin: 'x@peer' });
    expect(stats()).toMatchObject({ context_tokens: 123 });
  });
});
