import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_ONE_TURN, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../test/codexFixtures.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { codexHomePath, codexSyncPath } from './agentSync.ts';
import { sha256Hex } from './crypto.ts';
import { RemotePuller, remoteTranscriptPath } from './puller.ts';
import { SyncStateStore } from './state.ts';
import { REUPLOAD_GAP_MS, TranscriptUploader } from './uploader.ts';

// Codex の本文（rollout 1 ファイル）の上げ下ろし。振る舞いの見本は実機の記録（trials の probe-codex-e0）で、本文は合成の見本（test/fixtures/codex）を使う。
// CODEX_HOME はどれも一時のディレクトリで、本物の ~/.codex は読まない・書かない。

const ID = CODEX_ONE_TURN.id;
const { name: NAME, rel: REL } = rolloutName(ID);
const SESSIONS_PATH = `codex/sessions/2026/10/26/${NAME}`;
const ARCHIVED_PATH = `codex/archived_sessions/${NAME}`;
const LEDGER = (dev: string) => `codex/${dev}/${ID}.jsonl.gz`;
const BODY = fixtureBytes(CODEX_ONE_TURN.file);
const ZST = fixtureBytes(`${CODEX_ONE_TURN.file}.zst`);
/** resume しただけで末尾に足される 1 行（thread_settings_applied）を真似た追記。 */
const RESUME_LINE = '{"type":"event_msg","payload":{"type":"thread_settings_applied","cwd":"/w/alpha"}}\n';

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let state: SyncStateStore;
let codexHome: string;
let claudeDir: string;
let remoteHome: string;
let codexOn: boolean;
const errors: { path: string; message: string }[] = [];

const logical = () => path.join(codexHome, REL);
const archivedFile = () => path.join(codexHome, 'archived_sessions', NAME);
const make = (o: { db?: Db; deviceId?: string; client?: FakeCloudClient; home?: () => string } = {}) => {
  const c = o.client ?? cloud;
  return new TranscriptUploader({
    db: o.db ?? db, deviceId: o.deviceId ?? 'dev-a', claudeDir, client: c, keyring: c.keyring, state: o.db ? new SyncStateStore(o.db) : state,
    now: () => timers.now, timers, isPaused: () => false,
    onError: (p, m) => errors.push({ path: p, message: m }),
    codex: () => (codexOn ? { home: o.home ? o.home() : codexHome } : null),
  });
};
const target = (p = logical()) => ({ provider: 'codex' as const, path: p, sessionId: ID, agentId: null });
const puts = () => cloud.calls.filter((c) => c.method === 'putFile').length;
const openedCodex = async () => (await cloud.openedFile(await cloud.codexKey(ID)))!;
const ledgerRows = (d: Db = db) => d.prepare("select key, path, sha256, size from file_sync where key like 'codex/%'").all() as { key: string; path: string; sha256: string; size: number }[];

/** 索引が済んだ状態を作る。sessions と transcript_files の形は IndexerService が書くもの（論理パス、実体の大きさ）に合わせる。 */
const addIndexed = (d: Db, file: string) => {
  d.prepare('insert or ignore into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`s-${ID}`, 'codex', ID, '/w/alpha', 1, 1, 'dev-a', 'dev-a', 1);
  const phys = fs.existsSync(file) ? file : `${file}.zst`;
  const st = fs.statSync(phys);
  d.prepare('insert or replace into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?,?)')
    .run(file, `s-${ID}`, null, null, st.size, Math.floor(st.mtimeMs), st.size, 2);
};

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'dev-a' });
  timers = new FakeTimers();
  state = new SyncStateStore(db);
  codexHome = makeCodexHome();
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
  remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  codexOn = true;
  errors.length = 0;
  putRollout(codexHome, REL, BODY);
});
afterEach(() => {
  for (const d of [codexHome, claudeDir, remoteHome]) fs.rmSync(d, { recursive: true, force: true });
});

describe('Codex の本文を上げる', () => {
  it('本文の変化から 30 秒の窓で、rollout 全体を jsonl として上げ、台帳を thread の UUID で引く', async () => {
    const up = make();
    up.noteChanged(target());
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(1);
    const o = await openedCodex();
    expect(o.body.equals(BODY)).toBe(true);
    expect(o.entry).toMatchObject({ path: SESSIONS_PATH, kind: 'transcript', origin: 'dev-a', size: BODY.length, sha256: sha256Hex(BODY) });
    // R2 の鍵名とメタの外側には、thread の UUID も名前も出ない。
    const stored = [...cloud.files.values()][0]!;
    expect(stored.entry.key.includes(ID)).toBe(false);
    expect(JSON.stringify(stored.entry).includes(ID)).toBe(false);
    expect(ledgerRows()).toEqual([{ key: LEDGER('dev-a'), path: SESSIONS_PATH, sha256: sha256Hex(BODY), size: BODY.length }]);
    // Claude の台帳の鍵（transcripts/）には混ざらない。
    expect(db.prepare("select count(*) n from file_sync where key like 'transcripts/%'").get()).toEqual({ n: 0 });
    expect(errors).toEqual([]);
    up.stop();
  });

  it('追記だけの変化（resume の 1 行、ターン）は全体を上げ直し、中身が同じなら PUT しない', async () => {
    addIndexed(db, logical());
    const up = make();
    await up.flushSession(ID);
    expect(puts()).toBe(1);
    // 終了の 2 度目（flushOnRunEnded の 5 秒後）は、中身が同じなので送らない。
    await up.flushSession(ID);
    expect(puts()).toBe(1);
    fs.appendFileSync(logical(), RESUME_LINE);
    await up.flushSession(ID);
    expect(puts()).toBe(2);
    const body = (await openedCodex()).body;
    // 上げた版は、前に上げた版をそのまま先頭に持つ（追記だけ）。
    expect(body.subarray(0, BODY.length).equals(BODY)).toBe(true);
    expect(body.toString('utf8').endsWith(RESUME_LINE)).toBe(true);
    expect(ledgerRows()).toHaveLength(1);
    expect(cloud.files.size).toBe(1);
    up.stop();
  });

  it('一度上げた会話は、変化が続いても上げてから 10 分たつまで上げ直さない（Claude と同じ間隔）', async () => {
    const up = make();
    up.noteChanged(target());
    await timers.advance(30_000);
    await up.idle();
    fs.appendFileSync(logical(), RESUME_LINE);
    for (let i = 0; i < 3; i++) {
      up.noteChanged(target());
      await timers.advance(60_000);
      await up.idle();
    }
    expect(puts()).toBe(1);
    await timers.advance(REUPLOAD_GAP_MS);
    await up.idle();
    expect(puts()).toBe(2);
    up.stop();
  });

  it('.jsonl.zst は展開してから指紋を取り、jsonl として上げる', async () => {
    fs.rmSync(logical());
    fs.writeFileSync(`${logical()}.zst`, ZST);
    const up = make();
    expect(await up.uploadFile(target())).toBe('uploaded');
    const o = await openedCodex();
    expect(o.body.equals(BODY)).toBe(true);
    expect(o.entry).toMatchObject({ path: SESSIONS_PATH, size: BODY.length, sha256: sha256Hex(BODY) });
    expect(errors).toEqual([]);
    up.stop();
  });

  it('jsonl から zst へ名前が変わっても、展開した中身が同じなら上げず、台帳も鍵名も 1 つのまま。resume で jsonl に戻って伸びたら上げ直す', async () => {
    addIndexed(db, logical());
    const up = make();
    await up.flushSession(ID);
    expect(puts()).toBe(1);
    // 7 日たって圧縮された（.jsonl は消え、.jsonl.zst だけが残る。更新時刻は元のまま）。
    const mtime = fs.statSync(logical()).mtime;
    fs.rmSync(logical());
    fs.writeFileSync(`${logical()}.zst`, ZST);
    fs.utimesSync(`${logical()}.zst`, mtime, mtime);
    expect(await up.uploadFile(target())).toBe('unchanged');
    await up.flushSession(ID);
    expect(puts()).toBe(1);
    // resume すると .jsonl に展開され、.zst は消え、1 行足される。
    fs.rmSync(`${logical()}.zst`);
    fs.writeFileSync(logical(), Buffer.concat([BODY, Buffer.from(RESUME_LINE)]));
    await up.flushSession(ID);
    expect(puts()).toBe(2);
    expect(ledgerRows()).toEqual([{ key: LEDGER('dev-a'), path: SESSIONS_PATH, sha256: sha256Hex(Buffer.concat([BODY, Buffer.from(RESUME_LINE)])), size: BODY.length + Buffer.byteLength(RESUME_LINE) }]);
    expect(cloud.files.size).toBe(1);
    up.stop();
  });

  it('アーカイブ（archived_sessions へ移る）は、中身が同じでも置き場を変えて上げ直し、同じ鍵名に上書きする。戻したらまた上げ直す', async () => {
    const up = make();
    expect(await up.uploadFile(target())).toBe('uploaded');
    fs.mkdirSync(path.dirname(archivedFile()), { recursive: true });
    fs.renameSync(logical(), archivedFile());
    expect(await up.uploadFile(target(archivedFile()))).toBe('uploaded');
    expect((await openedCodex()).entry.path).toBe(ARCHIVED_PATH);
    expect(cloud.files.size).toBe(1);
    expect(ledgerRows()).toEqual([{ key: LEDGER('dev-a'), path: ARCHIVED_PATH, sha256: sha256Hex(BODY), size: BODY.length }]);
    // 消えた元の置き場は上げない。
    expect(await up.uploadFile(target())).toBe('skipped');
    // codex unarchive で sessions/YYYY/MM/DD/ へ戻った。
    fs.renameSync(archivedFile(), logical());
    expect(await up.uploadFile(target())).toBe('uploaded');
    expect((await openedCodex()).entry.path).toBe(SESSIONS_PATH);
    expect(puts()).toBe(3);
    up.stop();
  });

  it('CODEX_HOME の外や、rollout の形でない名前は上げない', async () => {
    const up = make();
    const stray = path.join(codexHome, 'elsewhere', NAME);
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, BODY);
    expect(await up.uploadFile(target(stray))).toBe('skipped');
    expect(puts()).toBe(0);
    up.stop();
  });

  it('Codex を有効にしていない PC では、変化の知らせも終了も走査も上げない', async () => {
    codexOn = false;
    addIndexed(db, logical());
    const up = make();
    up.noteChanged(target());
    await timers.advance(30_000);
    await up.idle();
    await up.flushSession(ID);
    expect(up.sweep()).toBe(0);
    await up.idle();
    expect(up.pendingSweep()).toBe(0);
    expect(puts()).toBe(0);
    // 口そのものを渡さない（Codex を知らない組み方）ときも同じ。
    const bare = new TranscriptUploader({ db, deviceId: 'dev-a', claudeDir, client: cloud, keyring: cloud.keyring, state, now: () => timers.now, timers, isPaused: () => false });
    await bare.flushSession(ID);
    expect(await bare.uploadFile(target())).toBe('skipped');
    expect(bare.pendingSweep()).toBe(0);
    expect(puts()).toBe(0);
    up.stop();
    bare.stop();
  });

  it('取り残しの走査は Codex の会話を Codex の台帳で数えて積み、Claude の数に混ぜない', async () => {
    addIndexed(db, logical());
    const up = make();
    expect(up.pendingSweep()).toBe(1);
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect(puts()).toBe(1);
    expect(up.pendingSweep()).toBe(0);
    expect(up.sweep()).toBe(0);
    up.stop();
  });
});

describe('Codex の本文を降ろす', () => {
  /** dev-b として、その CODEX_HOME の rollout を上げる。 */
  const uploadFromB = async (file: string) => {
    const dbB = openDb(':memory:');
    const upB = make({ db: dbB, deviceId: 'dev-b', client: cloud.asDevice('dev-b') });
    const r = await upB.uploadFile(target(file));
    upB.stop();
    return r;
  };
  const makePuller = (o: { codex?: boolean } = {}) => new RemotePuller({
    db, deviceId: 'dev-a', home: remoteHome, client: cloud, state,
    onError: (k, m) => errors.push({ path: k, message: m }),
    ...(o.codex === false ? {} : { codexEnabled: () => codexOn }),
  });
  const remoteTree = (): string[] => {
    const root = path.join(remoteHome, 'remote');
    if (!fs.existsSync(root)) return [];
    return (fs.readdirSync(root, { recursive: true }) as string[]).map((p) => p.split(path.sep).join('/')).filter((p) => fs.statSync(path.join(root, p)).isFile()).sort();
  };

  it('ほかの PC の rollout を remote/<元の PC>/codex/sessions/YYYY/MM/DD/<元の名前>.jsonl に降ろし、台帳を UUID で書く', async () => {
    expect(await uploadFromB(logical())).toBe('uploaded');
    const p = makePuller();
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(remoteTree()).toEqual([`dev-b/${SESSIONS_PATH}`]);
    const placed = remoteTranscriptPath(remoteHome, 'dev-b', SESSIONS_PATH);
    expect(fs.readFileSync(placed).equals(BODY)).toBe(true);
    expect(ledgerRows()).toEqual([{ key: LEDGER('dev-b'), path: SESSIONS_PATH, sha256: sha256Hex(BODY), size: BODY.length }]);
    // 同じ指紋のものは降ろし直さない。
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    // Codex の置き場の中の降ろし先は、元の名前のまま sessions/YYYY/MM/DD/ の下（「この PC で再開」が使う）。
    expect(codexHomePath('/c', SESSIONS_PATH)).toBe(path.join('/c', 'sessions', '2026', '10', '26', NAME));
    expect(errors).toEqual([]);
  });

  it('zst で上がった会話も、展開した jsonl として降りる', async () => {
    fs.rmSync(logical());
    fs.writeFileSync(`${logical()}.zst`, ZST);
    expect(await uploadFromB(logical())).toBe('uploaded');
    expect(await makePuller().pullNow()).toEqual({ downloaded: 1 });
    expect(remoteTree()).toEqual([`dev-b/${SESSIONS_PATH}`]);
    expect(fs.readFileSync(remoteTranscriptPath(remoteHome, 'dev-b', SESSIONS_PATH)).equals(BODY)).toBe(true);
  });

  it('アーカイブの印は置き場で届き、archived_sessions/ の下に置き直す。同じ会話の写しは 1 つだけ残す', async () => {
    expect(await uploadFromB(logical())).toBe('uploaded');
    const p = makePuller();
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    fs.mkdirSync(path.dirname(archivedFile()), { recursive: true });
    fs.renameSync(logical(), archivedFile());
    expect(await uploadFromB(archivedFile())).toBe('uploaded');
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(remoteTree()).toEqual([`dev-b/${ARCHIVED_PATH}`]);
    expect(ledgerRows()).toEqual([{ key: LEDGER('dev-b'), path: ARCHIVED_PATH, sha256: sha256Hex(BODY), size: BODY.length }]);
    expect(codexHomePath('/c', ARCHIVED_PATH)).toBe(path.join('/c', 'archived_sessions', NAME));
    // 戻した（unarchive）ら sessions/ の側へ置き直す。
    fs.renameSync(archivedFile(), logical());
    expect(await uploadFromB(logical())).toBe('uploaded');
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(remoteTree()).toEqual([`dev-b/${SESSIONS_PATH}`]);
  });

  it('Codex を有効にしていない PC は Codex の行を降ろさず、Claude の本文は降ろし続けて区切りを進める', async () => {
    codexOn = false;
    const devB = cloud.asDevice('dev-b');
    await devB.putText({ path: 'projects/-w-alpha/11111111-1111-4111-8111-111111111111.jsonl' }, '{"a":1}\n');
    codexOn = true;
    expect(await uploadFromB(logical())).toBe('uploaded');
    codexOn = false;
    await devB.putText({ path: 'projects/-w-alpha/22222222-2222-4222-8222-222222222222.jsonl' }, '{"b":2}\n');
    for (const p of [makePuller(), makePuller({ codex: false })]) {
      fs.rmSync(path.join(remoteHome, 'remote'), { recursive: true, force: true });
      db.prepare('delete from file_sync').run();
      state.set('filesSeq', 0);
      expect(await p.pullNow()).toEqual({ downloaded: 2 });
      expect(state.getNumber('filesSeq', -1)).toBe(3);
      expect(remoteTree().filter((r) => r.includes('/codex/'))).toEqual([]);
      expect(ledgerRows()).toEqual([]);
      expect(p.skippedEntries()).toEqual([]);
    }
    expect(errors).toEqual([]);
  });

  it('上げた写しの path は Codex の置き場の形にそろう（降ろした先をそのまま CODEX_HOME へ写せる）', () => {
    expect(codexSyncPath(NAME, false)).toBe(SESSIONS_PATH);
    expect(remoteTranscriptPath('/h', 'dev-b', SESSIONS_PATH)).toBe(path.join('/h', 'remote', 'dev-b', 'codex', 'sessions', '2026', '10', '26', NAME));
    expect(remoteTranscriptPath('/h', 'dev-b', ARCHIVED_PATH)).toBe(path.join('/h', 'remote', 'dev-b', 'codex', 'archived_sessions', NAME));
    for (const bad of [`codex/sessions/2026/10/27/${NAME}`, 'codex/../x.jsonl', `codex/${NAME}`]) expect(() => remoteTranscriptPath('/h', 'dev-b', bad)).toThrow();
  });
});
