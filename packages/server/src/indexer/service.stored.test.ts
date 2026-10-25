import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { convertMessages } from '../provider/opencode/transcript/convert.ts';
import { OpencodeTranscript } from '../provider/opencode/transcript/source.ts';
import { readEvents } from '../transcript/read.ts';
import { fixtureMessages, startFakeEventsServe, until, type FakeEventsServe } from '../../test/fake-opencode-events.ts';
import { IndexerService, type IndexerListener } from './service.ts';

// 本文を DB に持つエージェント（opencode）の束を、索引が書いて知らせる道。記録した 2.1.4 の本文を使う。
const SID = 'ses_e8eb096a3ffekAvQlPtKFewFB4';
const CWD = '/work/repo';
const ALL = [...fixtureMessages('messages.json').data].reverse();
const FIRST_TURN = ALL.findIndex((m) => (m as { type?: string }).type === 'idle') + 1;

let dir: string;
let db: Db;
let serve: FakeEventsServe;
let source: OpencodeTranscript;
let svc: IndexerService;
let changed: Parameters<NonNullable<IndexerListener['sessionChanged']>>[0][];
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-stored-'));
  fs.mkdirSync(path.join(dir, 'projects'));
  db = openDb(':memory:');
  serve = await startFakeEventsServe();
  source = new OpencodeTranscript({ debounceMs: 0, log: () => {} });
  svc = new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir: dir }), stored: [source], isRunning: () => false });
  changed = [];
  svc.on({ sessionChanged: (e) => changed.push(e) });
  await svc.start();
});
afterEach(async () => {
  svc.stop();
  await serve.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sessionId = () => (db.prepare("select id from sessions where provider = 'opencode' and provider_session_id = ?").get(SID) as { id: string } | undefined)?.id;
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;

describe('IndexerService（本文を DB に持つエージェント）', () => {
  it('束を書き、readEvents が opencode の会話を agent_events から読む', async () => {
    serve.state.messages.set(SID, ALL);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => sessionId() !== undefined && changed.length === 1);
    const id = sessionId()!;
    const expected = convertMessages(ALL).flatMap((r) => r.events);
    const page = readEvents(db, id, {});
    expect(page.total).toBe(expected.length);
    expect(page.events).toEqual(expected);
    expect(count("select count(*) c from agent_events where session_id = ? and agent_key = ''", id)).toBe(expected.length);
  });

  it('二度読んでも、作り直しの読み直しでも、行は重ならない', async () => {
    serve.state.messages.set(SID, ALL);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => changed.length === 1);
    const id = sessionId()!;
    const n = count('select count(*) c from event_index where session_id = ?', id);
    await source.sync(SID);
    // 載せ直すと、写した所を知らないので全部を作り直しとして読み直す（hangar の再起動や再開と同じ道）。
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => changed.length === 2);
    expect(count('select count(*) c from event_index where session_id = ?', id)).toBe(n);
    expect(count('select count(*) c from agent_events where session_id = ?', id)).toBe(n);
    expect(count('select count(*) c from event_fts where session_id = ?', id)).toBe(count('select count(distinct seq) c from event_fts where session_id = ?', id));
    expect(readEvents(db, id, {}).events).toEqual(convertMessages(ALL).flatMap((r) => r.events));
  });

  it('続きの束は前の seq の次から積む', async () => {
    serve.state.messages.set(SID, ALL.slice(0, FIRST_TURN));
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => changed.length === 1);
    serve.state.messages.set(SID, ALL);
    await source.sync(SID);
    await until(() => changed.length === 2);
    const id = sessionId()!;
    expect(readEvents(db, id, {}).events).toEqual(convertMessages(ALL).flatMap((r) => r.events));
  });

  it('知らせ（sessionChanged）は本文のファイルを持たない（path は null）手元の変化として出す', async () => {
    serve.state.messages.set(SID, ALL);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => changed.length === 1);
    const n = convertMessages(ALL).flatMap((r) => r.events).length;
    expect(changed[0]).toEqual({ sessionId: sessionId(), providerSessionId: SID, agentId: null, appended: n, artifactIds: [], deviceId: null, path: null });
  });

  it('検索、いまの手、統計、使用量の事実が opencode の会話にも入る', async () => {
    serve.state.messages.set(SID, ALL);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => changed.length === 1);
    const id = sessionId()!;
    expect(count("select count(*) c from event_fts where session_id = ? and text like '%hangar-capture%'", id)).toBeGreaterThan(0);
    expect(count("select count(*) c from event_fts where session_id = ? and role = 'user' and text = 'Sleep please.'", id)).toBe(1);
    expect(db.prepare('select tool, summary from session_activity where session_id = ?').get(id)).toEqual({ tool: 'Bash', summary: 'Bash sleep 20' });
    expect(db.prepare('select turns, model, files_changed, input_tokens, output_tokens from session_stats where session_id = ?').get(id))
      .toEqual({ turns: 3, model: 'mock/mock', files_changed: 1, input_tokens: 8 * 10 + 2 * 12, output_tokens: 8 * 3 + 2 * 5 });
    expect(db.prepare('select model, context_used, context_size, cost_usd from session_live_stats where provider_session_id = ?').get(SID))
      .toEqual({ model: 'mock/mock', context_used: 12, context_size: null, cost_usd: 0 });
    expect(db.prepare('select cwd, first_prompt from sessions where id = ?').get(id)).toEqual({ cwd: CWD, first_prompt: 'Run echo, record the intent, write and edit a file, then ask me a question.' });
  });

  it('opencode の会話は、本文があるもの（hasTranscript）として一覧に載る', async () => {
    serve.state.messages.set(SID, ALL);
    source.track({ providerSessionId: SID, cwd: CWD, serve });
    await until(() => changed.length === 1);
    const { getSession } = await import('../db/queries.ts');
    const s = getSession(db, [], sessionId()!, { deviceId: 'd' });
    expect(s).toMatchObject({ hasTranscript: true, remoteOnly: false });
  });
});
