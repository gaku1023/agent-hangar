import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { convertMessages } from '../provider/opencode/transcript/convert.ts';
import { OpencodeTranscript } from '../provider/opencode/transcript/source.ts';
import { fixtureMessages, startFakeEventsServe, until, type FakeEventsServe } from '../../test/fake-opencode-events.ts';
import { IndexerService } from './service.ts';
import { writeBatch } from './write.ts';

// opencode の本文には文脈の大きさが無い。索引はモデルの一覧から引く口（contextSizeOf）で context_size を書く（計画の C5）。
const SID = 'ses_e8eb096a3ffekAvQlPtKFewFB4';
const CWD = '/work/repo';
const ALL = [...fixtureMessages('messages.json').data].reverse();
const stats = (db: Db) => db.prepare('select model, context_used, context_size, cost_usd from session_live_stats where provider_session_id = ?').get(SID);

describe('writeBatch の文脈の大きさ', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });
  const batch = (reset: boolean, records = convertMessages(ALL)) => ({ agent: 'opencode' as const, providerSessionId: SID, agentId: null, cwd: CWD, reset, records });

  it('モデルの上限が引ければ context_size に書く', () => {
    const asked: string[] = [];
    writeBatch(db, batch(true), { deviceId: 'd', contextSizeOf: (m) => { asked.push(m); return m === 'mock/mock' ? 100 : null; } });
    expect(stats(db)).toEqual({ model: 'mock/mock', context_used: 12, context_size: 100, cost_usd: 0 });
    expect(asked).toEqual(['mock/mock']);
  });

  it('引けなければ書かず、前に書いた値を残す', () => {
    writeBatch(db, batch(true), { deviceId: 'd', contextSizeOf: () => 100 });
    writeBatch(db, batch(false), { deviceId: 'd', contextSizeOf: () => null });
    expect(stats(db)).toMatchObject({ context_size: 100 });
  });

  it('束にモデルが無いときは、前に書いたモデルで引く', () => {
    writeBatch(db, batch(true), { deviceId: 'd' });
    expect(stats(db)).toMatchObject({ model: 'mock/mock', context_size: null });
    // モデルを持たない続きの束（使用量だけの記録）。
    const usageOnly = convertMessages(ALL).map((r) => ({ ...r, facts: { ...r.facts, model: undefined } }));
    writeBatch(db, batch(false, usageOnly), { deviceId: 'd', contextSizeOf: (m) => (m === 'mock/mock' ? 64_000 : null) });
    expect(stats(db)).toMatchObject({ model: 'mock/mock', context_size: 64_000 });
  });

  it('口を渡さなければ context_size は null のまま（B5 と同じ）', () => {
    writeBatch(db, batch(true), { deviceId: 'd' });
    expect(stats(db)).toMatchObject({ context_size: null });
  });
});

describe('IndexerService の contextSizeOf', () => {
  let dir: string;
  let db: Db;
  let serve: FakeEventsServe;
  let svc: IndexerService;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ctxsize-'));
    fs.mkdirSync(path.join(dir, 'projects'));
    db = openDb(':memory:');
    serve = await startFakeEventsServe();
  });
  afterEach(async () => {
    svc.stop();
    await serve.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('押し込まれた束を書くときに、渡した口で文脈の大きさを引く', async () => {
    const source = new OpencodeTranscript({ debounceMs: 0, log: () => {} });
    svc = new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir: dir }), stored: [source], isRunning: () => false, contextSizeOf: () => 200 });
    await svc.start();
    serve.state.messages.set(SID, ALL);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => (stats(db) as { context_size: number | null } | undefined)?.context_size === 200);
    expect(stats(db)).toEqual({ model: 'mock/mock', context_used: 12, context_size: 200, cost_usd: 0 });
  });
});
