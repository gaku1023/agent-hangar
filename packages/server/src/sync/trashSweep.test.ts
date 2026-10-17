import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOB_DELETE_DAILY, BLOB_DELETE_GRACE_MS, MAX_BLOB_DELETE_KEYS, TRASH_KEEP_MS, transcriptBlobKey } from '@agent-hangar/shared';
import { testCloudConfig, testKey } from '../../test/cloudConfig.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { setSessionTrashed } from '../sessions/states.ts';
import { trashedLongAgo } from '../sessions/trash.ts';
import { Keyring } from './keyring.ts';
import { transcriptLedgerKey } from './ledgerKey.ts';
import { SyncStateStore } from './state.ts';
import { noteBlobUpload, sweepSupersededBlobs, sweepTrashBlobs } from './trashSweep.ts';
import { TranscriptUploader } from './uploader.ts';

const DAY = 86_400_000;
const OLD = '11111111-1111-4111-8111-111111111111';
const YOUNG = '22222222-2222-4222-8222-222222222222';
const LIVE = '33333333-3333-4333-8333-333333333333';

let db: Db;
let clock: number;
let ring: Keyring;
let cloud: FakeCloudClient;

const addSession = (uuid: string) => {
  db.prepare('insert or ignore into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`s-${uuid}`, 'claude-code', uuid, '/w/alpha', 1, 1, 'dev-a', 'dev-a', 1);
};
/** そのセッションを at にゴミ箱へ入れた（印だけ。sessions の行は論理削除する）。 */
const trash = (uuid: string, at: number) => {
  setSessionTrashed(db, 'dev-a', `s-${uuid}`, at, at);
  db.prepare('update sessions set deleted_at = ? where id = ?').run(at, `s-${uuid}`);
};
/** この PC がその世代で上げたことにし、偽の Worker にも置く（置いた時刻は偽の Worker の時計）。 */
const uploaded = async (uuid: string, agentId: string | null, epoch: number) => {
  noteBlobUpload(db, transcriptLedgerKey('dev-a', uuid, agentId), epoch);
  const keys = (await Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: epoch }))).current();
  const at = cloud.asDevice('dev-a', { keyring: Keyring.fromConfig(testCloudConfig({ epochs: { [String(epoch)]: epoch === 1 ? testKey(3) : testKey(4) }, currentEpoch: epoch })) });
  const rel = agentId === null ? `projects/-w-alpha/${uuid}.jsonl` : `projects/-w-alpha/${uuid}/subagents/agent-${agentId}.jsonl`;
  const { key } = await at.putText({ path: rel }, `{"e":${epoch}}\n`);
  expect(key).toBe(await transcriptBlobKey(keys.index, 'dev-a', 'dev-a', uuid, agentId));
  return key;
};
const deletes = () => cloud.calls.filter((c) => c.method === 'deleteBlobs').map((c) => (c.args[0] as string[]).length);
const remembered = () => (db.prepare('select count(*) c from blob_uploads').get() as { c: number }).c;
const sweep = () => sweepTrashBlobs({ db, client: cloud, keyring: ring, deviceId: 'dev-a', now: clock });

beforeEach(async () => {
  db = openDb(':memory:');
  clock = 100 * DAY;
  ring = await Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 }));
  cloud = new FakeCloudClient({ deviceId: 'dev-a', keyring: ring, now: () => clock });
  for (const u of [OLD, YOUNG, LIVE]) addSession(u);
});

describe('trashedLongAgo', () => {
  it('印から 30 日を過ぎたセッションだけを返し、戻したものと生きているものは返さない', () => {
    trash(OLD, clock - TRASH_KEEP_MS - 1);
    trash(YOUNG, clock - TRASH_KEEP_MS + DAY);
    trash(LIVE, clock - 60 * DAY);
    setSessionTrashed(db, 'dev-a', `s-${LIVE}`, null, clock - 59 * DAY);
    expect(trashedLongAgo(db, clock - TRASH_KEEP_MS)).toEqual([{ sessionId: `s-${OLD}`, uuid: OLD }]);
  });
});

describe('sweepTrashBlobs', () => {
  it('30 日を過ぎたものだけ消す。上げた世代ごとの鍵名を消し、控えも忘れる', async () => {
    const mainE1 = await uploaded(OLD, null, 1);
    const mainE2 = await uploaded(OLD, null, 2);
    const agent = await uploaded(OLD, 'abc', 2);
    const young = await uploaded(YOUNG, null, 2);
    const live = await uploaded(LIVE, null, 2);
    trash(OLD, clock - TRASH_KEEP_MS - 1);
    trash(YOUNG, clock - TRASH_KEEP_MS + DAY);
    clock += 2 * BLOB_DELETE_GRACE_MS;
    expect(await sweep()).toEqual({ deleted: 3, refused: 0 });
    const asked = cloud.calls.find((c) => c.method === 'deleteBlobs')!.args[0] as string[];
    expect(new Set(asked)).toEqual(new Set([mainE1, mainE2, agent]));
    expect([...cloud.files.keys()].sort()).toEqual([young, live].sort());
    expect(remembered()).toBe(2);
    // 消し終えたら次の回は Worker に何も送らない。
    expect(await sweep()).toEqual({ deleted: 0, refused: 0 });
    expect(deletes()).toEqual([3]);
  });

  it('refused は次の回に回す', async () => {
    trash(OLD, clock - TRASH_KEEP_MS - 1);
    const key = await uploaded(OLD, null, 2);
    // 置いてから 1 時間たっていないので Worker が断る。
    expect(await sweep()).toEqual({ deleted: 0, refused: 1 });
    expect(cloud.files.has(key)).toBe(true);
    expect(remembered()).toBe(1);
    clock += BLOB_DELETE_GRACE_MS + 1;
    expect(await sweep()).toEqual({ deleted: 1, refused: 0 });
    expect(cloud.files.has(key)).toBe(false);
    expect(remembered()).toBe(0);
  });

  it(`1 回の DELETE は ${MAX_BLOB_DELETE_KEYS} 件まで。1 日の上限（429）に当たったら黙って止め、残りは次の回に回す`, async () => {
    trash(OLD, clock - TRASH_KEEP_MS - 1);
    for (let i = 0; i < 60; i++) noteBlobUpload(db, transcriptLedgerKey('dev-a', OLD, `a${i}`), 2);
    expect(await sweep()).toEqual({ deleted: 60, refused: 0 });
    expect(deletes()).toEqual([50, 10]);

    for (let i = 0; i < 60; i++) noteBlobUpload(db, transcriptLedgerKey('dev-a', OLD, `b${i}`), 2);
    cloud.wire.blobDeletesToday = BLOB_DELETE_DAILY;
    expect(await sweep()).toEqual({ deleted: 0, refused: 0 });
    expect(remembered()).toBe(60);
    expect(deletes()).toEqual([50, 10, 50]);
  });

  it('同期で届いた印でも、この PC が上げたものだけを消す（ほかの PC の下の鍵は求めない）', async () => {
    trash(OLD, clock - TRASH_KEEP_MS - 1);
    clock += 2 * BLOB_DELETE_GRACE_MS;
    const other = await cloud.asDevice('dev-b', { keyring: ring }).putText({ path: `projects/-w-alpha/${OLD}.jsonl` }, '{}\n');
    clock += 2 * BLOB_DELETE_GRACE_MS;
    expect(await sweep()).toEqual({ deleted: 0, refused: 0 });
    expect(deletes()).toEqual([]);
    expect(cloud.files.has(other.key)).toBe(true);
  });

  it('ほかの道で同じ UUID のセッションが生きていれば消さない', async () => {
    trash(OLD, clock - TRASH_KEEP_MS - 1);
    await uploaded(OLD, null, 2);
    db.prepare('insert into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
      .run('s-other', 'codex', OLD, '/w/alpha', 1, 1, 'dev-a', 'dev-a', 1);
    clock += 2 * BLOB_DELETE_GRACE_MS;
    expect(await sweep()).toEqual({ deleted: 0, refused: 0 });
    expect(deletes()).toEqual([]);
  });

  describe('uploader との組み合わせ', () => {
    let claudeDir: string;
    beforeEach(() => { claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-')); });
    afterEach(() => { fs.rmSync(claudeDir, { recursive: true, force: true }); });

    it('世代 1 で上げて世代 2 で上げ直した本文は、2 つの鍵名を消す', async () => {
      const file = path.join(claudeDir, 'projects', '-w-alpha', `${OLD}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const state = new SyncStateStore(db);
      const timers = new FakeTimers();
      const upload = async (keyring: Keyring, text: string) => {
        fs.writeFileSync(file, text);
        const c = cloud.asDevice('dev-a', { keyring });
        const up = new TranscriptUploader({ db, deviceId: 'dev-a', claudeDir, client: c, keyring, state, now: () => clock, timers, isPaused: () => false, onError: (p, m) => { throw new Error(`${p}: ${m}`); } });
        up.noteChanged({ path: file, sessionId: OLD, agentId: null });
        await up.flushSession(OLD);
        up.stop();
      };
      const ring1 = await Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(3) }, currentEpoch: 1 }));
      await upload(ring1, '{"a":1}\n');
      await upload(ring, '{"a":1}\n{"a":2}\n');
      expect(cloud.files.size).toBe(2);
      expect(db.prepare('select epoch from blob_uploads order by epoch').all()).toEqual([{ epoch: 1 }, { epoch: 2 }]);
      trash(OLD, clock - TRASH_KEEP_MS - 1);
      clock += 2 * BLOB_DELETE_GRACE_MS;
      expect(await sweep()).toEqual({ deleted: 2, refused: 0 });
      expect(cloud.files.size).toBe(0);
    });
  });
});

describe('sweepSupersededBlobs（世代を回した後に上げ直した本文の、古い世代の鍵名）', () => {
  const superseded = (ledgerKey?: string) => sweepSupersededBlobs({ db, client: cloud, keyring: ring, deviceId: 'dev-a', ...(ledgerKey ? { ledgerKey } : {}) });

  it('新しい世代で上げ直した本文の、古い世代の鍵名だけを消す。1 つの世代にしか無い本文は消さない', async () => {
    const old1 = await uploaded(LIVE, null, 1);
    const only = await uploaded(YOUNG, null, 1);
    clock += 2 * BLOB_DELETE_GRACE_MS;
    const new2 = await uploaded(LIVE, null, 2);
    expect(await superseded()).toEqual({ deleted: 1, refused: 0 });
    expect(cloud.files.has(old1)).toBe(false);
    expect(cloud.files.has(new2)).toBe(true);
    expect(cloud.files.has(only)).toBe(true);
    expect(db.prepare('select ledger_key k, epoch from blob_uploads order by k, epoch').all()).toEqual([
      { k: transcriptLedgerKey('dev-a', YOUNG, null), epoch: 1 },
      { k: transcriptLedgerKey('dev-a', LIVE, null), epoch: 2 },
    ]);
    // 消すものが無ければ Worker に何も送らない。
    const before = deletes().length;
    expect(await superseded()).toEqual({ deleted: 0, refused: 0 });
    expect(deletes().length).toBe(before);
  });

  it('置いてから 1 時間たっていない古い鍵名は断られ、控えに残して次の回に消す。ledgerKey でその本文だけに絞れる', async () => {
    const old1 = await uploaded(LIVE, 'abc', 1);
    await uploaded(OLD, null, 1);
    await uploaded(LIVE, 'abc', 2);
    await uploaded(OLD, null, 2);
    expect(await superseded(transcriptLedgerKey('dev-a', LIVE, 'abc'))).toEqual({ deleted: 0, refused: 1 });
    clock += 2 * BLOB_DELETE_GRACE_MS;
    expect(await superseded(transcriptLedgerKey('dev-a', LIVE, 'abc'))).toEqual({ deleted: 1, refused: 0 });
    expect(cloud.files.has(old1)).toBe(false);
    expect(remembered()).toBe(3);
    expect(await superseded()).toEqual({ deleted: 1, refused: 0 });
    expect(remembered()).toBe(2);
  });
});
