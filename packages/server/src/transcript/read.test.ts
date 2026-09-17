import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { readEvents, subagentIds } from './read.ts';

let dir: string;
let db: Db;
let alphaId: string;
beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readEvents', () => {
  it('主線を seq 順に返す', () => {
    const page = readEvents(db, alphaId, {});
    expect(page.total).toBe(17);
    expect(page.nextSeq).toBeNull();
    expect(page.events.map((e) => e.seq)).toEqual([...Array(17).keys()]);
    expect(page.events[0]).toMatchObject({ kind: 'user', text: '動画チャンネルの整理をしたい。まず現状を見て' });
    expect(page.events[6]).toMatchObject({ kind: 'tool_result', isError: true, text: 'File not found' });
    expect(page.events[13]).toMatchObject({ kind: 'meta', name: 'ai-title' });
  });
  it('fromSeq と limit でページを切る', () => {
    const p1 = readEvents(db, alphaId, { fromSeq: 0, limit: 5 });
    expect(p1.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(p1.nextSeq).toBe(5);
    const p2 = readEvents(db, alphaId, { fromSeq: p1.nextSeq!, limit: 100 });
    expect(p2.events[0]!.seq).toBe(5);
    expect(p2.nextSeq).toBeNull();
  });
  it('サブエージェントの本文を agentId で読む', () => {
    expect(subagentIds(db, alphaId)).toEqual(['abc123']);
    const page = readEvents(db, alphaId, { agentId: 'abc123' });
    expect(page.events.map((e) => e.kind)).toEqual(['user', 'assistant']);
  });
  it('サブエージェントは名前順ではなく始まった順に並ぶ', async () => {
    // 名前の順と時刻の順が逆になるように、2 つのサブエージェントを足す。
    const sub = path.join(dir, 'projects', '-Users-me-workspace-alpha', SESSION_ALPHA, 'subagents');
    const line = (agentId: string, ts: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, uuid: 'x-' + agentId, parentUuid: null, isSidechain: true, agentId, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA }) + '\n';
    fs.writeFileSync(path.join(sub, 'agent-aaa999.jsonl'), line('aaa999', '2026-09-01T10:05:00.000Z'));
    fs.writeFileSync(path.join(sub, 'agent-zzz111.jsonl'), line('zzz111', '2026-09-01T10:01:00.000Z'));
    await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
    expect(subagentIds(db, alphaId)).toEqual(['abc123', 'zzz111', 'aaa999']);
  });
  it('知らないセッションは空', () => {
    expect(readEvents(db, 'nope', {})).toEqual({ sessionId: 'nope', events: [], total: 0, nextSeq: null });
  });
});
