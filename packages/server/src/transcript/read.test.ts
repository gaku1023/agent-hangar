import fs from 'node:fs';
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
  it('知らないセッションは空', () => {
    expect(readEvents(db, 'nope', {})).toEqual({ sessionId: 'nope', events: [], total: 0, nextSeq: null });
  });
});
