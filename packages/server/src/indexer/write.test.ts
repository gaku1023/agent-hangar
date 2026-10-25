import { beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { softDeleteShared } from '../db/shared.ts';
import type { IndexBatch, IndexRecord } from '../agent/types.ts';
import { localDay } from '../usage/aggregate.ts';
import { storedOrigin, writeBatch } from './write.ts';

let db: Db;
const DEV = 'dev-1';
const OC = 'ses_0123456789abcdef';
beforeEach(() => { db = openDb(':memory:'); });

const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];
const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Record<string, unknown> | undefined;

const TS = Date.parse('2026-10-20T10:00:00.000Z');
/** 本文を DB に持つエージェントの 1 件。seq は束の中で 0 から振る。 */
const stored = (events: TranscriptEvent[], facts: Partial<IndexRecord['facts']> = {}): IndexRecord =>
  ({ events, facts: { isUserTurn: false, ...facts }, locator: { kind: 'stored' } });
const prompt = (seq: number, text: string, ts = TS): IndexRecord =>
  stored([{ kind: 'user', seq, ts, text }], { isUserTurn: true, ts, cwd: '/Users/me/workspace/oc' });
const reply = (seq: number, text: string, ts = TS + 1000): IndexRecord =>
  stored([{ kind: 'assistant', seq, ts, text }, { kind: 'tool_call', seq: seq + 1, ts, toolId: 't1', name: 'edit', input: {}, summary: 'a.ts', filePath: '/Users/me/workspace/oc/a.ts' }],
    { ts, model: 'glm-4.6', usage: { input: 10, output: 5 } });
const batch = (records: IndexRecord[], reset = false): IndexBatch =>
  ({ agent: 'opencode', providerSessionId: OC, agentId: null, reset, records });

describe('writeBatch', () => {
  it('本文を DB に持つ束（locator が stored）を、provider の会話として書く', () => {
    const r = writeBatch(db, batch([prompt(0, 'はじめの依頼'), reply(1, '直しました')], true), { deviceId: DEV });
    expect(r.skipped).toBe(false);
    expect(r.appended).toBe(3);
    const s = one('select * from sessions where id = ?', r.sessionId)!;
    expect(s).toMatchObject({ provider: 'opencode', provider_session_id: OC, cwd: '/Users/me/workspace/oc', first_prompt: 'はじめの依頼', started_at: TS, last_activity_at: TS + 1000 });
    const origin = storedOrigin(batch([]));
    expect(all('select seq, kind, byte_offset, byte_length, file_path_ref, tool_name, file_path from event_index where session_id = ? order by seq', r.sessionId)).toEqual([
      { seq: 0, kind: 'user', byte_offset: 0, byte_length: 0, file_path_ref: origin, tool_name: null, file_path: null },
      { seq: 1, kind: 'assistant', byte_offset: 0, byte_length: 0, file_path_ref: origin, tool_name: null, file_path: null },
      { seq: 2, kind: 'tool_call', byte_offset: 0, byte_length: 0, file_path_ref: origin, tool_name: 'edit', file_path: '/Users/me/workspace/oc/a.ts' },
    ]);
    expect(all('select seq, role, text from event_fts where session_id = ? order by seq', r.sessionId).map((x) => x.text)).toEqual(['はじめの依頼', '直しました', 'a.ts']);
    expect(one('select turns, model, input_tokens, output_tokens, last_prompt from session_stats where session_id = ?', r.sessionId))
      .toEqual({ turns: 1, model: 'glm-4.6', input_tokens: 10, output_tokens: 5, last_prompt: 'はじめの依頼' });
    expect(all('select day, file_path, input_tokens, output_tokens from usage_daily where session_id = ?', r.sessionId))
      .toEqual([{ day: localDay(TS + 1000), file_path: origin, input_tokens: 10, output_tokens: 5 }]);
    // 本文の位置はファイルではないので、transcript_files には何も書かない。
    expect(all('select * from transcript_files')).toEqual([]);
  });

  it('続きの束は、前の束の次の seq から積み、作り直しの束は消してから積む', () => {
    const first = writeBatch(db, batch([prompt(0, 'はじめの依頼')], true), { deviceId: DEV });
    const next = writeBatch(db, batch([reply(0, '続き')]), { deviceId: DEV });
    expect(next.sessionId).toBe(first.sessionId);
    expect(all('select seq, kind from event_index where session_id = ? order by seq', first.sessionId).map((x) => `${x.seq}:${x.kind}`)).toEqual(['0:user', '1:assistant', '2:tool_call']);
    expect(one('select turns, input_tokens from session_stats where session_id = ?', first.sessionId)).toEqual({ turns: 1, input_tokens: 10 });
    writeBatch(db, batch([prompt(0, '作り直した依頼')], true), { deviceId: DEV });
    expect(all('select seq, kind from event_index where session_id = ? order by seq', first.sessionId).map((x) => `${x.seq}:${x.kind}`)).toEqual(['0:user']);
    expect(all('select text from event_fts where session_id = ?', first.sessionId).map((x) => x.text)).toEqual(['作り直した依頼']);
    expect(all('select * from usage_daily where session_id = ?', first.sessionId)).toEqual([]);
    expect(one('select turns, input_tokens from session_stats where session_id = ?', first.sessionId)).toEqual({ turns: 1, input_tokens: 0 });
  });

  it('最後の入力・返答の時刻（last_turn_ts）は、主線の発言と返答だけから取る。後に書かれた system の記録や道具では進めない', () => {
    const late = (seq: number) => stored([{ kind: 'system', seq, ts: TS + 180_000, text: 'away summary' }], { ts: TS + 180_000 });
    const first = writeBatch(db, batch([prompt(0, 'はじめの依頼'), reply(1, '直しました'), late(3)], true), { deviceId: DEV });
    expect(one('select last_ts, last_turn_ts from session_stats where session_id = ?', first.sessionId)).toEqual({ last_ts: TS + 180_000, last_turn_ts: TS + 1000 });
    // 返答の無い続きの束では前の値を残し、作り直しでは束の値に置き換える。
    writeBatch(db, batch([late(0)]), { deviceId: DEV });
    expect(one('select last_turn_ts from session_stats where session_id = ?', first.sessionId)).toEqual({ last_turn_ts: TS + 1000 });
    writeBatch(db, batch([prompt(0, '作り直した依頼', TS + 500)], true), { deviceId: DEV });
    expect(one('select last_turn_ts from session_stats where session_id = ?', first.sessionId)).toEqual({ last_turn_ts: TS + 500 });
    writeBatch(db, batch([late(0)], true), { deviceId: DEV });
    expect(one('select last_turn_ts from session_stats where session_id = ?', first.sessionId)).toEqual({ last_turn_ts: null });
  });

  it('論理削除した会話の束は書かない', () => {
    const first = writeBatch(db, batch([prompt(0, 'はじめの依頼')], true), { deviceId: DEV });
    softDeleteShared(db, 'sessions', first.sessionId, DEV);
    const r = writeBatch(db, batch([reply(0, '消した後の続き')]), { deviceId: DEV });
    expect(r).toMatchObject({ sessionId: first.sessionId, skipped: true, appended: 0 });
    expect(all('select seq from event_index where session_id = ?', first.sessionId)).toHaveLength(1);
  });

  it('ほかの PC の写しは、行がまだ無ければ書かずに見送る', () => {
    const r = writeBatch(db, batch([prompt(0, 'はじめの依頼')], true), { deviceId: DEV, remote: true });
    expect(r).toMatchObject({ sessionId: '', skipped: true });
    expect(all('select * from sessions')).toEqual([]);
  });

  it('ファイルの位置を持つ束は、その位置を event_index に残す', () => {
    const rec: IndexRecord = { events: [{ kind: 'user', seq: 0, ts: TS, text: 'hi' }], facts: { isUserTurn: true, ts: TS }, locator: { kind: 'file', path: '/x/a.jsonl', offset: 120, length: 42 } };
    const r = writeBatch(db, { agent: 'claude-code', providerSessionId: 'aaaaaaaa-0000-4000-8000-000000000001', agentId: null, reset: true, records: [rec] }, { deviceId: DEV, origin: '/x/a.jsonl' });
    expect(one('select provider from sessions where id = ?', r.sessionId)).toEqual({ provider: 'claude-code' });
    expect(all('select byte_offset, byte_length, file_path_ref from event_index where session_id = ?', r.sessionId)).toEqual([{ byte_offset: 120, byte_length: 42, file_path_ref: '/x/a.jsonl' }]);
  });
});
