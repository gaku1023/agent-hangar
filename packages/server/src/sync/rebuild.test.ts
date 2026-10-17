import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ConfigSyncService } from './config/service.ts';
import { sha256Hex } from './crypto.ts';
import { SyncEngine } from './engine.ts';
import { RemotePuller, remoteTranscriptPath } from './puller.ts';
import { RELAY_HOLD_MS, rebuildIfCloudChanged } from './rebuild.ts';
import type { RosterRead } from './roster.ts';
import { SyncStateStore } from './state.ts';
import { TranscriptUploader } from './uploader.ts';

/**
 * 作り直しの 3 つの道（設計書「作り直しの手順」）。
 * 接続先（cloudId）が変わったら、台帳を捨てて本文を上げ直し、共有テーブルの全行を積み直し、remote/ の写しも上げる。
 */

const UUID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const UUID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const UUID_R = 'cccccccc-3333-4333-8333-333333333333';
const FOLDER = '-w-proj';

let db: Db;
let state: SyncStateStore;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let home: string;
let claudeDir: string;

const write = (file: string, text: string): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const mainFile = (uuid: string): string => path.join(claudeDir, 'projects', FOLDER, `${uuid}.jsonl`);

const addIndexed = (uuid: string, text: string): void => {
  const file = mainFile(uuid);
  write(file, text);
  db.prepare('insert or ignore into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`s-${uuid}`, 'claude-code', uuid, '/w/proj', 1, 1, 'dev-a', 'dev-a', 1);
  const st = fs.statSync(file);
  db.prepare('insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?,?)')
    .run(file, `s-${uuid}`, null, null, st.size, Math.floor(st.mtimeMs), st.size, 2);
};

/** 前のクラウドへ上げ済みの印を台帳に残す（指紋も大きさも手元と同じ）。 */
const markUploaded = (uuid: string, text: string): void => {
  db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`transcripts/dev-a/${uuid}.jsonl.gz`, 'transcript', `projects/${FOLDER}/${uuid}.jsonl`, 'dev-a', sha256Hex(Buffer.from(text)), Buffer.byteLength(text), 1, 7, 1);
};

/** 名簿の写し（RosterStore.cached の代わり）。ids は名簿に居る PC の ID。null は「まだ読んでいない」。 */
const rosterOf = (ids: string[] | null): { cached(): RosterRead | null } => ({
  cached: () => (ids === null ? null : { version: 1, roster: { v: 1, entries: ids.map((id) => ({ id, kind: 'pc' as const, name: id, os: 'darwin', pub: '', joinedAt: 1 })), recoveryPub: '', phoneKey: null } }),
});
let roster: { cached(): RosterRead | null };

const uploader = (): TranscriptUploader => new TranscriptUploader({ db, deviceId: 'dev-a', claudeDir, home, client: cloud, keyring: cloud.keyring, state, roster, now: () => timers.now, timers, isPaused: () => false });

beforeEach(() => {
  db = openDb(':memory:');
  state = new SyncStateStore(db);
  cloud = new FakeCloudClient({ deviceId: 'dev-a' });
  timers = new FakeTimers();
  roster = rosterOf(['dev-a']);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rebuild-home-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rebuild-claude-'));
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

describe('rebuildIfCloudChanged', () => {
  it('接続先が変わると、全部のトランスクリプトが上がる（skip: の記録があっても）', async () => {
    addIndexed(UUID_A, '{"a":1}\n');
    addIndexed(UUID_B, '{"b":1}\n');
    markUploaded(UUID_A, '{"a":1}\n');
    markUploaded(UUID_B, '{"b":1}\n');
    // 前のクラウドで諦めた控えと、上げた世代の控え。
    state.set(`skipped:transcripts/dev-a/${UUID_B}.jsonl.gz`, JSON.stringify({ sha: 'x', size: 1, status: 413, message: 'too large', at: 1 }));
    db.prepare('insert into blob_uploads (ledger_key, epoch) values (?, ?)').run(`transcripts/dev-a/${UUID_A}.jsonl.gz`, 4);
    state.set('cloudId', 'cloud-old');

    // 作り直しの前は、台帳が「上げ済み」と言うので何も上がらない。
    const before = uploader();
    expect(before.sweep()).toBe(0);
    before.stop();

    expect(rebuildIfCloudChanged({ db, state, health: { cloudId: 'cloud-new' }, home, deviceId: 'dev-a' })).toEqual({ rebuilt: true });
    expect(state.get('cloudId')).toBe('cloud-new');
    expect(state.get(`skipped:transcripts/dev-a/${UUID_B}.jsonl.gz`)).toBeNull();
    // 前のクラウドの世代の控えは捨てる（ゴミ箱の掃除が、もう無い鍵名を求めない）。
    expect(db.prepare('select count(*) n from blob_uploads where epoch = 4').get()).toEqual({ n: 0 });

    const up = uploader();
    expect(up.sweep()).toBe(2);
    await up.idle();
    const stored = (await cloud.openedFiles()).map((e) => e.path).sort();
    expect(stored).toEqual([`projects/${FOLDER}/${UUID_A}.jsonl`, `projects/${FOLDER}/${UUID_B}.jsonl`]);
    up.stop();
  });

  it('共有テーブルの全行が送られる（backfill の床を 0 にするだけではない）', async () => {
    upsertShared(db, 'projects', { id: 'proj-1', name: 'alpha', status: 'active' }, 'dev-a');
    upsertShared(db, 'projects', { id: 'proj-2', name: 'beta', status: 'active' }, 'dev-b');
    db.prepare('update projects set deleted_at = 5 where id = ?').run('proj-2');
    // 前のクラウドへ送り済みの状態。
    db.prepare('update changes set pushed_at = 1').run();
    state.set('lastSeq', 500);
    state.set('filesSeq', 300);
    state.set('snapshotDone', true);
    state.set('rowsSkippedFrom', 90);
    state.set('filesSkippedFrom', 80);
    state.set('cloudId', 'cloud-old');

    expect(rebuildIfCloudChanged({ db, state, health: { cloudId: 'cloud-new' }, home, deviceId: 'dev-a' }).rebuilt).toBe(true);
    for (const k of ['lastSeq', 'filesSeq', 'snapshotDone', 'rowsSkippedFrom', 'filesSkippedFrom'] as const) expect(state.get(k)).toBeNull();
    const unsent = db.prepare("select table_name t, row_id id, op from changes where pushed_at is null and table_name = 'projects' order by row_id").all();
    // 他の PC が書いた行も、消した行も積み直す。消した行は delete で送る。
    expect(unsent).toEqual([{ t: 'projects', id: 'proj-1', op: 'upsert' }, { t: 'projects', id: 'proj-2', op: 'delete' }]);

    const engine = new SyncEngine({ db, deviceId: 'dev-a', client: cloud, timers, now: () => timers.now });
    await engine.pushNow();
    const sent = (await cloud.opened()).filter((c) => c.tableName === 'projects').map((c) => [c.rowId, c.op, c.payload.origin_device]);
    expect(sent).toEqual([['proj-1', 'upsert', 'dev-a'], ['proj-2', 'delete', 'dev-b']]);
    engine.stop();
  });

  it('remote/ の写しが自分の device_id の下に、origin つきで上がる', async () => {
    const rel = `projects/${FOLDER}/${UUID_R}.jsonl`;
    const sub = `projects/${FOLDER}/${UUID_R}/subagents/agent-a1b2.jsonl`;
    write(remoteTranscriptPath(home, 'dev-b', rel), '{"from":"b"}\n');
    write(remoteTranscriptPath(home, 'dev-b', sub), '{"sub":"b"}\n');
    // 書きかけの一時ファイルと、自分の ID の下の写しは上げない。
    write(`${remoteTranscriptPath(home, 'dev-b', rel)}.part`, 'half');
    write(remoteTranscriptPath(home, 'dev-a', `projects/${FOLDER}/${UUID_A}.jsonl`), '{"mine":1}\n');

    rebuildIfCloudChanged({ db, state, health: { cloudId: 'cloud-new' }, home, deviceId: 'dev-a', now: timers.now });
    // 元の PC が参加し直すのを待つ日数を過ぎても、名簿に居ない。
    timers.now += RELAY_HOLD_MS + 1;
    const up = uploader();
    expect(up.pendingSweep()).toBe(2);
    expect(up.sweep()).toBe(2);
    await up.idle();
    const files = await cloud.openedFiles();
    expect(files.map((e) => [e.deviceId, e.origin, e.path]).sort()).toEqual([['dev-a', 'dev-b', rel], ['dev-a', 'dev-b', sub]]);
    expect(files.every((e) => e.key.startsWith('b/dev-a/'))).toBe(true);
    // 上げ終えたら、次の走査では積まない。
    expect(up.sweep()).toBe(0);
    expect(up.pendingSweep()).toBe(0);
    up.stop();

    // 3 台目は元の PC の ID（origin）の下へ降ろす。
    const dbC = openDb(':memory:');
    const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rebuild-c-'));
    try {
      const pullC = new RemotePuller({ db: dbC, deviceId: 'dev-c', home: homeC, client: cloud.asDevice('dev-c'), state: new SyncStateStore(dbC) });
      expect((await pullC.pullNow()).downloaded).toBe(2);
      expect(fs.readFileSync(remoteTranscriptPath(homeC, 'dev-b', rel), 'utf8')).toBe('{"from":"b"}\n');
      expect(fs.existsSync(path.join(homeC, 'remote', 'dev-a'))).toBe(false);
    } finally {
      dbC.close();
      fs.rmSync(homeC, { recursive: true, force: true });
    }

    // 元の PC は、自分の本文の写しを降ろさない（原本が手元にある）。
    const dbB = openDb(':memory:');
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rebuild-b-'));
    try {
      const pullB = new RemotePuller({ db: dbB, deviceId: 'dev-b', home: homeB, client: cloud.asDevice('dev-b'), state: new SyncStateStore(dbB) });
      expect((await pullB.pullNow()).downloaded).toBe(0);
      expect(fs.existsSync(path.join(homeB, 'remote'))).toBe(false);
    } finally {
      dbB.close();
      fs.rmSync(homeB, { recursive: true, force: true });
    }
  });

  it('同じ cloudId なら何もしない', () => {
    addIndexed(UUID_A, '{"a":1}\n');
    markUploaded(UUID_A, '{"a":1}\n');
    upsertShared(db, 'projects', { id: 'proj-1', name: 'alpha', status: 'active' }, 'dev-a');
    db.prepare('update changes set pushed_at = 1').run();
    state.set('lastSeq', 500);
    state.set('cloudId', 'cloud-1');

    expect(rebuildIfCloudChanged({ db, state, health: { cloudId: 'cloud-1' }, home, deviceId: 'dev-a' })).toEqual({ rebuilt: false });
    expect(state.get('lastSeq')).toBe('500');
    expect(db.prepare('select count(*) n from file_sync').get()).toEqual({ n: 1 });
    expect(db.prepare('select count(*) n from changes where pushed_at is null').get()).toEqual({ n: 0 });
    // cloudId が空（読めなかった）ときも、何もしない。
    expect(rebuildIfCloudChanged({ db, state, health: { cloudId: '' }, home, deviceId: 'dev-a' }).rebuilt).toBe(false);
  });

  it('降ろした写しの台帳は残す（同じ本文を新しいクラウドから降ろし直さない）', () => {
    db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
      .run(`transcripts/dev-b/${UUID_R}.jsonl.gz`, 'transcript', `projects/${FOLDER}/${UUID_R}.jsonl`, 'dev-b', 'f'.repeat(64), 1, 1, 3, 1);
    rebuildIfCloudChanged({ db, state, health: { cloudId: 'cloud-new' }, home, deviceId: 'dev-a' });
    expect(db.prepare("select key from file_sync where kind = 'transcript'").all()).toEqual([{ key: `transcripts/dev-b/${UUID_R}.jsonl.gz` }]);
  });

  it('作り直しの後の最初の send で、設定の同期の束が新しいクラウドへ上がる', async () => {
    // 本物の同期は起動のときに Worker と話して版を知る。偽のクラウドにも 1 度話しかけたことにする。
    void cloud.health();
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# rules');
    const service = new ConfigSyncService({
      db, deviceId: 'dev-a', deviceName: 'pc-a', claudeDir, home, cloud, keyring: cloud.keyring,
      enabled: () => true, switchedOn: () => true, approval: () => 'each', now: () => timers.now,
    });
    state.set('cloudId', 'cloud-old');
    expect((await service.send()).sent).toBe(true);
    expect((await service.send()).sent).toBe(false);

    rebuildIfCloudChanged({ db, state, health: { cloudId: 'cloud-new' }, home, deviceId: 'dev-a' });
    expect((await service.send()).sent).toBe(true);
  });

  it('前のクラウドの recovery の箱の印、上限で退く時刻、他の PC の最終接続を消す', () => {
    state.set('cloudId', 'cloud-old');
    state.set('recoveryBoxPending', '1');
    state.set('limitedUntil', 9_999_999_999_999);
    state.set('peers', JSON.stringify({ 'dev-b': 1 }));
    rebuildIfCloudChanged({ db, state, health: { cloudId: 'cloud-new' }, home, deviceId: 'dev-a' });
    expect([state.get('recoveryBoxPending'), state.get('limitedUntil'), state.get('peers')]).toEqual([null, null, null]);
  });
});

describe('remote/ の写しの保留', () => {
  const rel = `projects/${FOLDER}/${UUID_R}.jsonl`;
  const relayRows = (): unknown[] => db.prepare("select key from file_sync where kind = 'remote_copy'").all();
  const placeCopy = (): void => {
    write(remoteTranscriptPath(home, 'dev-b', rel), '{"from":"b"}\n');
    rebuildIfCloudChanged({ db, state, health: { cloudId: 'cloud-new' }, home, deviceId: 'dev-a', now: timers.now });
  };

  it('元の PC が新しいクラウドの名簿に居れば上げず、台帳の行を消す', async () => {
    placeCopy();
    roster = rosterOf(['dev-a', 'dev-b']);
    timers.now += RELAY_HOLD_MS + 1;
    const up = uploader();
    expect(up.pendingSweep()).toBe(0);
    expect(up.sweep()).toBe(0);
    await up.idle();
    expect(await cloud.openedFiles()).toEqual([]);
    expect(relayRows()).toEqual([]);
    up.stop();
  });

  it('作り直しから 3 日のうちは、名簿に居なくても上げない', async () => {
    placeCopy();
    timers.now += RELAY_HOLD_MS - 1;
    const up = uploader();
    expect(up.pendingSweep()).toBe(0);
    expect(up.sweep()).toBe(0);
    await up.idle();
    expect(await cloud.openedFiles()).toEqual([]);
    // 台帳の行は残し、日数が過ぎたら上げる。
    expect(relayRows()).toHaveLength(1);
    timers.now += 2;
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect((await cloud.openedFiles()).map((e) => [e.origin, e.path])).toEqual([['dev-b', rel]]);
    up.stop();
  });

  it('名簿の写しがまだ無ければ、今回は上げない（GET /roster を増やさない）', async () => {
    placeCopy();
    roster = rosterOf(null);
    timers.now += RELAY_HOLD_MS + 1;
    const up = uploader();
    expect(up.sweep()).toBe(0);
    await up.idle();
    expect(cloud.calls.some((c) => c.method === 'getRoster')).toBe(false);
    expect(relayRows()).toHaveLength(1);
    up.stop();
  });

  it('ファイルの消えた写しは数えず、台帳から落とす', async () => {
    placeCopy();
    fs.rmSync(remoteTranscriptPath(home, 'dev-b', rel));
    timers.now += RELAY_HOLD_MS + 1;
    const up = uploader();
    expect(up.pendingSweep()).toBe(0);
    expect(up.sweep()).toBe(0);
    expect(relayRows()).toEqual([]);
    up.stop();
  });
});

describe('SyncEngine の起動', () => {
  it('作り直しに失敗したら、同期の失敗として見せ、push も pull も始めない', async () => {
    upsertShared(db, 'projects', { id: 'proj-1', name: 'alpha', status: 'active' }, 'dev-a');
    state.set('cloudId', 'cloud-old');
    // 作り直しの transaction の途中で転ぶようにする。
    db.exec('drop table blob_uploads');
    const engine = new SyncEngine({ db, deviceId: 'dev-a', client: cloud, timers, now: () => timers.now, home, cloudId: 'cloud-new' });
    await engine.start();
    await engine.idle();
    expect(engine.status().state).toBe('error');
    expect(engine.status().error).toBeTruthy();
    expect(state.get('lastError')).toBeTruthy();
    // 前の記録のまま、新しいクラウドに送らない。
    expect(state.get('cloudId')).toBe('cloud-old');
    expect(cloud.calls.filter((c) => c.method === 'pushChanges' || c.method === 'pullChanges' || c.method === 'snapshot')).toEqual([]);
    // 定期の pull も走らない。今すぐ同期でも送らない。
    await timers.advance(10 * 60_000);
    await engine.syncNow();
    await engine.idle();
    expect(cloud.calls.filter((c) => c.method === 'pushChanges' || c.method === 'pullChanges' || c.method === 'snapshot')).toEqual([]);
    engine.stop();
  });

  it('cloud.json の cloudId が前と違えば、作り直してから送る', async () => {
    upsertShared(db, 'projects', { id: 'proj-1', name: 'alpha', status: 'active' }, 'dev-a');
    db.prepare('update changes set pushed_at = 1').run();
    state.set('lastSeq', 500);
    state.set('snapshotDone', true);
    state.set('cloudId', 'cloud-old');
    const engine = new SyncEngine({ db, deviceId: 'dev-a', client: cloud, timers, now: () => timers.now, home, cloudId: 'cloud-new' });
    await engine.start();
    await engine.idle();
    expect(state.get('cloudId')).toBe('cloud-new');
    expect((await cloud.opened()).some((c) => c.tableName === 'projects' && c.rowId === 'proj-1')).toBe(true);
    engine.stop();
  });

  it('cloudId が同じなら、送り済みの行を積み直さない', async () => {
    upsertShared(db, 'projects', { id: 'proj-1', name: 'alpha', status: 'active' }, 'dev-a');
    db.prepare('update changes set pushed_at = 1').run();
    state.set('cloudId', 'cloud-1');
    const engine = new SyncEngine({ db, deviceId: 'dev-a', client: cloud, timers, now: () => timers.now, home, cloudId: 'cloud-1' });
    await engine.start();
    await engine.idle();
    expect((await cloud.opened()).some((c) => c.tableName === 'projects')).toBe(false);
    engine.stop();
  });
});
