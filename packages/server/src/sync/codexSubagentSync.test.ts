import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRASH_KEEP_MS } from '@agent-hangar/shared';
import { CODEX_SUBAGENT_A, CODEX_SUBAGENT_B, CODEX_SUBAGENT_PARENT, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../test/codexFixtures.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { listRemoteRolloutFiles, listRolloutFiles } from '../provider/codex/transcript/discover.ts';
import { setSessionTrashed } from '../sessions/states.ts';
import { AGENT_SYNC, idsOfAnyLedgerKey } from './agentSync.ts';
import { RemotePuller } from './puller.ts';
import { SyncStateStore } from './state.ts';
import { sweepTrashBlobs } from './trashSweep.ts';
import { TranscriptUploader } from './uploader.ts';

// Codex のサブエージェント（子の rollout）の同期。子は親の下の鍵で上げ、R2 の鍵名と写しの path は前の版（独立した会話として上げた形）と同じ。
// 見本は合成（test/fixtures/codex/subagent-*.jsonl）で、CODEX_HOME は一時のディレクトリである。

const P = CODEX_SUBAGENT_PARENT.id;
const A = CODEX_SUBAGENT_A.id;
const B = CODEX_SUBAGENT_B.id;
const nameOf = (id: string, when: string) => rolloutName(id, when);
const PARENT = nameOf(P, '2026-11-25T20-14-16');
const CHILD_A = nameOf(A, '2026-11-25T20-14-35');
const CHILD_B = nameOf(B, '2026-11-25T20-14-36');
const PATH_A = `codex/sessions/2026/11/25/${CHILD_A.name}`;
const KEY_P = (dev: string) => `codex/${dev}/${P}.jsonl.gz`;
const KEY_A = (dev: string) => `codex/${dev}/${P}/subagents/${A}.jsonl.gz`;
const KEY_B = (dev: string) => `codex/${dev}/${P}/subagents/${B}.jsonl.gz`;

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let state: SyncStateStore;
let codexHome: string;
let claudeDir: string;
let remoteHome: string;
const errors: string[] = [];

const logical = (n: { rel: string }) => path.join(codexHome, n.rel);
const make = (o: { db?: Db; deviceId?: string; client?: FakeCloudClient } = {}) => {
  const c = o.client ?? cloud;
  return new TranscriptUploader({
    db: o.db ?? db, deviceId: o.deviceId ?? 'dev-a', claudeDir, client: c, keyring: c.keyring, state: o.db ? new SyncStateStore(o.db) : state,
    now: () => timers.now, timers, isPaused: () => false, onError: (_p, m) => errors.push(m), codex: () => ({ home: codexHome }),
  });
};
const targetA = () => ({ provider: 'codex' as const, path: logical(CHILD_A), sessionId: P, agentId: A });
const puts = () => cloud.calls.filter((c) => c.method === 'putFile').length;
const ledger = (d: Db = db) => (d.prepare("select key from file_sync where key like 'codex/%' order by key").all() as { key: string }[]).map((r) => r.key);

/** 索引が済んだ状態。親と子 2 つを、IndexerService が書く形（子は sessionId が親の行、agent_id が子）で置く。 */
const addIndexed = (d: Db) => {
  d.prepare('insert or ignore into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`s-${P}`, 'codex', P, '/w/alpha', 1, 1, 'dev-a', 'dev-a', 1);
  for (const [n, agent] of [[PARENT, null], [CHILD_A, A], [CHILD_B, B]] as const) {
    const st = fs.statSync(logical(n));
    d.prepare('insert or replace into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?,?)')
      .run(logical(n), `s-${P}`, agent, null, st.size, Math.floor(st.mtimeMs), st.size, 2);
  }
};

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'dev-a' });
  timers = new FakeTimers();
  state = new SyncStateStore(db);
  codexHome = makeCodexHome();
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
  remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  errors.length = 0;
  putRollout(codexHome, PARENT.rel, fixtureBytes(CODEX_SUBAGENT_PARENT.file));
  putRollout(codexHome, CHILD_A.rel, fixtureBytes(CODEX_SUBAGENT_A.file));
  putRollout(codexHome, CHILD_B.rel, fixtureBytes(CODEX_SUBAGENT_B.file));
});
afterEach(() => { for (const d of [codexHome, claudeDir, remoteHome]) fs.rmSync(d, { recursive: true, force: true }); });

describe('鍵の形', () => {
  it('子の台帳の鍵は親の下（codex/<端末>/<親>/subagents/<子>.jsonl.gz）で、親の鍵と元の形は変わらない', () => {
    expect(AGENT_SYNC.codex.ledgerKey('dev-a', P, null)).toBe(KEY_P('dev-a'));
    expect(AGENT_SYNC.codex.ledgerKey('dev-a', P, A)).toBe(KEY_A('dev-a'));
    expect(idsOfAnyLedgerKey('dev-a', KEY_A('dev-a'))).toEqual({ provider: 'codex', uuid: P, agentId: A });
    expect(idsOfAnyLedgerKey('dev-a', KEY_P('dev-a'))).toEqual({ provider: 'codex', uuid: P, agentId: null });
    expect(idsOfAnyLedgerKey('dev-b', KEY_A('dev-a'))).toBeNull();
    expect(() => AGENT_SYNC.codex.ledgerKey('dev-a', P, 'not-a-thread')).toThrow();
  });
});

describe('子を上げる', () => {
  it('子の rollout は親の下の鍵で上がり、R2 の鍵名と写しの path は前の版と同じ（子の thread の UUID で引く）', async () => {
    const up = make();
    expect(await up.uploadFile(targetA())).toBe('uploaded');
    expect(ledger()).toEqual([KEY_A('dev-a')]);
    const o = (await cloud.openedFile(await cloud.codexKey(A)))!;
    expect(o.entry).toMatchObject({ path: PATH_A, kind: 'transcript', origin: 'dev-a' });
    expect(o.body.equals(fixtureBytes(CODEX_SUBAGENT_A.file))).toBe(true);
    // 同じ中身は上げ直さない。
    expect(await up.uploadFile(targetA())).toBe('unchanged');
    expect(puts()).toBe(1);
    expect(errors).toEqual([]);
    up.stop();
  });

  it('取り残しの走査は、親と子を別の台帳の鍵で数えて積む', async () => {
    addIndexed(db);
    const up = make();
    expect(up.pendingSweep()).toBe(3);
    expect(up.sweep()).toBe(3);
    await up.idle();
    expect(puts()).toBe(3);
    expect(ledger()).toEqual([KEY_P('dev-a'), KEY_A('dev-a'), KEY_B('dev-a')].sort());
    expect(up.pendingSweep()).toBe(0);
    expect(up.sweep()).toBe(0);
    up.stop();
  });

  it('flushSession(親) は、索引の台帳にある子も上げる', async () => {
    addIndexed(db);
    const up = make();
    await up.flushSession(P);
    expect(puts()).toBe(3);
    expect(ledger()).toHaveLength(3);
    up.stop();
  });

  it('flushSession(親) は、索引が見ていない開始直後でも、$CODEX_HOME の子を探して上げる', async () => {
    db.prepare('insert into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
      .run(`s-${P}`, 'codex', P, '/w/alpha', 1, 1, 'dev-a', 'dev-a', 1);
    const up = make();
    await up.flushSession(P);
    expect(ledger()).toEqual([KEY_P('dev-a'), KEY_A('dev-a'), KEY_B('dev-a')].sort());
    up.stop();
  });
});

describe('子を降ろす', () => {
  const uploadFromB = async (): Promise<void> => {
    const dbB = openDb(':memory:');
    const upB = make({ db: dbB, deviceId: 'dev-b', client: cloud.asDevice('dev-b') });
    await upB.uploadFile({ provider: 'codex', path: logical(PARENT), sessionId: P, agentId: null });
    await upB.uploadFile({ ...targetA(), path: logical(CHILD_A) });
    upB.stop();
  };
  const makePuller = () => new RemotePuller({ db, deviceId: 'dev-a', home: remoteHome, client: cloud, state, onError: (k, m) => errors.push(`${k}: ${m}`), codexEnabled: () => true });

  it('降ろした子は、写しの先頭の parent_thread_id から親の子として発見される（前の版が上げた子も同じ）', async () => {
    await uploadFromB();
    expect(await makePuller().pullNow()).toEqual({ downloaded: 2 });
    const r = listRemoteRolloutFiles(path.join(remoteHome, 'remote'));
    expect(r.files.map((f) => ({ s: f.sessionId, a: f.agentId, d: f.deviceId })).sort((x, y) => `${x.a ?? ''}`.localeCompare(`${y.a ?? ''}`))).toEqual([
      { s: P, a: null, d: 'dev-b' }, { s: P, a: A, d: 'dev-b' },
    ]);
    expect(errors).toEqual([]);
  });

  it('削除の印のある親の子は降ろさない', async () => {
    await uploadFromB();
    addIndexed(db);
    setSessionTrashed(db, 'dev-a', `s-${P}`, 5, 5);
    db.prepare('update sessions set deleted_at = 5 where id = ?').run(`s-${P}`);
    // 手元の子の索引の行は、削除で消える。ゴミ箱の控え（trashed_transcripts）が親との結び付きを持つ。
    db.prepare('delete from transcript_files').run();
    db.prepare('insert into trashed_transcripts (path, session_id, kind, trashed_at) values (?,?,?,?)').run(logical(CHILD_A), `s-${P}`, 'file', 5);
    expect(await makePuller().pullNow()).toEqual({ downloaded: 0 });
  });
});

describe('ゴミ箱の掃除', () => {
  it('親を消して 30 日たつと、子の R2 の鍵名も消す', async () => {
    let clock = 1_000_000_000;
    const c = new FakeCloudClient({ deviceId: 'dev-a', now: () => clock });
    const up = make({ client: c });
    expect(await up.uploadFile({ provider: 'codex', path: logical(PARENT), sessionId: P, agentId: null })).toBe('uploaded');
    expect(await up.uploadFile(targetA())).toBe('uploaded');
    up.stop();
    expect(db.prepare('select count(*) n from blob_uploads').get()).toEqual({ n: 2 });
    db.prepare('insert or ignore into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
      .run(`s-${P}`, 'codex', P, '/w/alpha', 1, 1, 'dev-a', 'dev-a', 1);
    setSessionTrashed(db, 'dev-a', `s-${P}`, clock, clock);
    db.prepare('update sessions set deleted_at = ? where id = ?').run(clock, `s-${P}`);
    clock += TRASH_KEEP_MS + 2 * 3_600_000;
    const r = await sweepTrashBlobs({ db, client: c, keyring: c.keyring, deviceId: 'dev-a', now: clock });
    expect(r.deleted).toBe(2);
    expect(c.files.size).toBe(0);
    expect(db.prepare('select count(*) n from blob_uploads').get()).toEqual({ n: 0 });
  });
});
