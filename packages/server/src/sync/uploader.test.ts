import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { COMPAT_VERSION, fromBase64Url, transcriptBlobKey, type FileMetaIn } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient, MAX_BODY_BYTES } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { CloudError, LimitError } from './client.ts';
import { testCloudConfig, testKey } from '../../test/cloudConfig.ts';
import { sha256Hex } from './crypto.ts';
import { Keyring } from './keyring.ts';
import { ledgerKeyOfPath } from './ledgerKey.ts';
import { SyncStateStore } from './state.ts';
import { TRANSCRIPTS_FROM } from './transcriptsFrom.ts';
import { REUPLOAD_GAP_MS, TranscriptUploader } from './uploader.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
/** 手元の台帳（file_sync）の鍵。R2 の鍵名は HMAC で、blobOf で求める。 */
const MAIN_KEY = `transcripts/dev-a/${UUID}.jsonl.gz`;

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let claudeDir: string;
let state: SyncStateStore;
let paused = false;
const errors: { path: string; message: string }[] = [];

const projDir = () => path.join(claudeDir, 'projects', '-Users-me-workspace-alpha');
const mainFile = () => path.join(projDir(), `${UUID}.jsonl`);
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const make = () => new TranscriptUploader({ db, deviceId: 'dev-a', claudeDir, client: cloud, keyring: cloud.keyring, state, now: () => timers.now, timers, isPaused: () => paused, onError: (p, m) => errors.push({ path: p, message: m }) });
/** 台帳の鍵から、偽の Worker に置かれる R2 の鍵名を求める。 */
const blobOf = async (ledger: string): Promise<string> => {
  const m = /^transcripts\/dev-a\/([^/]+?)(?:\/subagents\/agent-([^/]+))?\.jsonl\.gz$/.exec(ledger)!;
  return cloud.transcriptKey(m[1]!, m[2] ?? null);
};
/** 偽の Worker に置かれたものを開き、台帳の鍵の形で並べる。 */
const storedKeys = async (): Promise<string[]> => (await cloud.openedFiles()).map((e) => ledgerKeyOfPath(e.deviceId, e.path)!);
const opened = async (k: string) => (await cloud.openedFile(await blobOf(k)))!;
const plainBuf = async (k: string) => (await opened(k)).body;
const plain = async (k: string) => (await plainBuf(k)).toString();
const puts = () => cloud.calls.filter((c) => c.method === 'putFile').length;
const skipRow = () => state.get(`skipped:${MAIN_KEY}`);

/** putFile を指定の状態で断る。呼ばれた回数は puts() で数えられるように calls に残す。 */
const failPut = (status: number) => {
  cloud.putFile = (meta: FileMetaIn, body: Readable) => {
    cloud.calls.push({ method: 'putFile', args: [meta] });
    body.resume();
    return Promise.reject(new CloudError(status, `HTTP ${status}`));
  };
};

/** 索引が済んだ状態を作る。sessions と transcript_files の形は IndexerService が書くものに合わせる。 */
const addSession = (uuid: string) => {
  db.prepare('insert or ignore into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
    .run(`s-${uuid}`, 'claude-code', uuid, '/Users/me/workspace/alpha', 1, 1, 'dev-a', 'dev-a', 1);
};
const addIndexed = (file: string, uuid: string, agentId: string | null, deviceId: string | null = null) => {
  addSession(uuid);
  const st = fs.statSync(file);
  db.prepare('insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?,?)')
    .run(file, `s-${uuid}`, agentId, deviceId, st.size, Math.floor(st.mtimeMs), st.size, 2);
};
/** 索引が本文の続きを見た状態にする（手元の方が上げたものより新しい）。 */
const reindexed = (file: string) => {
  const st = fs.statSync(file);
  db.prepare('update transcript_files set size = ?, mtime = ? where path = ?').run(st.size, Math.floor(st.mtimeMs), file);
};

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'dev-a' });
  timers = new FakeTimers();
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
  state = new SyncStateStore(db);
  paused = false;
  errors.length = 0;
  write(mainFile(), '{"a":1}\n');
});

describe('TranscriptUploader', () => {
  it('変化の 30 秒後に gzip と暗号化で上げ、file_sync に記録する', async () => {
    const up = make();
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(29_000);
    await up.idle();
    expect(cloud.files.size).toBe(0);
    await timers.advance(1_000);
    await up.idle();
    expect((await storedKeys())).toEqual([MAIN_KEY]);
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n');
    expect((await opened(MAIN_KEY)).entry).toMatchObject({
      path: `projects/-Users-me-workspace-alpha/${UUID}.jsonl`, kind: 'transcript', epoch: 1, origin: 'dev-a', size: 8, sha256: sha256Hex('{"a":1}\n'),
    });
    expect(db.prepare('select * from file_sync where key = ?').get(MAIN_KEY)).toMatchObject({ kind: 'transcript', device_id: 'dev-a', sha256: sha256Hex('{"a":1}\n'), size: 8, remote_seq: 1 });
    up.stop();
  });

  it('R2 の鍵名と files の行にパスとセッションの UUID が無い', async () => {
    const sub = path.join(projDir(), UUID, 'subagents', 'agent-abc123.jsonl');
    write(sub, '{"sub":1}\n');
    const up = make();
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    expect(await up.uploadFile({ path: sub, sessionId: UUID, agentId: 'abc123' })).toBe('uploaded');
    const stored = [...cloud.files.values()];
    expect(stored).toHaveLength(2);
    for (const f of stored) expect(f.entry.key).toMatch(/^b\/dev-a\/[A-Za-z0-9_-]{43}$/);
    const dump = stored.map((f) => [JSON.stringify(f.entry), Buffer.from(fromBase64Url(f.entry.sealedMeta)!).toString('latin1'), f.body.toString('latin1')].join('|')).join('\n');
    for (const plainText of [UUID, UUID.slice(0, 8), 'abc123', 'subagents', 'workspace-alpha', 'projects', 'jsonl', sha256Hex('{"a":1}\n')]) expect(dump).not.toContain(plainText);
    // 開けば、パスと平文の指紋が戻る。
    expect((await storedKeys()).sort()).toEqual([MAIN_KEY, `transcripts/dev-a/${UUID}/subagents/agent-abc123.jsonl.gz`].sort());
    up.stop();
  });

  it('同じ本文の 2 回目の PUT は同じ鍵名に置き直す', async () => {
    const up = make();
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    const first = [...cloud.files.keys()];
    write(mainFile(), '{"a":1}\n{"a":2}\n');
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    expect([...cloud.files.keys()]).toEqual(first);
    expect(first).toEqual([await blobOf(MAIN_KEY)]);
    expect(cloud.files.get(first[0]!)!.entry.seq).toBe(2);
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n{"a":2}\n');
    up.stop();
  });

  it('鍵名を求めた世代が今の世代でなく client に断られたら、諦めずに待ち行列に残す', async () => {
    // client は世代 2 に進んでいるのに、uploader の鍵の束はまだ世代 1 にいる（世代を回した直後の食い違い）。
    const ring2 = await Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 }));
    cloud = new FakeCloudClient({ deviceId: 'dev-a', keyring: ring2 });
    const stale = await Keyring.fromConfig(testCloudConfig());
    const up = new TranscriptUploader({ db, deviceId: 'dev-a', claudeDir, client: cloud, keyring: stale, state, now: () => timers.now, timers, isPaused: () => paused, onError: (p, m) => errors.push({ path: p, message: m }) });
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/epoch/);
    // 直りうる失敗なので、諦めの控えを残さず、次の機会にまた試す。
    expect(skipRow()).toBeNull();
    expect(up.skippedUploads()).toEqual([]);
    await stale.addEpochs({ epochs: { '2': testKey(4) } });
    await up.flushAll();
    expect(puts()).toBe(1);
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n');
    up.stop();
  });

  it('世代を回した後の最初の PUT で古い世代の鍵名を消し、断られたら上げるたびには打ち直さない（6 時間ごとの掃除に任せる）', async () => {
    const ring = await Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 1 }));
    cloud = new FakeCloudClient({ deviceId: 'dev-a', keyring: ring });
    const up = new TranscriptUploader({ db, deviceId: 'dev-a', claudeDir, client: cloud, keyring: ring, state, now: () => timers.now, timers, isPaused: () => paused, onError: (p, m) => errors.push({ path: p, message: m }) });
    const deletes = () => cloud.calls.filter((c) => c.method === 'deleteBlobs').length;
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    ring.useEpoch(2);
    write(mainFile(), '{"a":1}\n{"a":2}\n');
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    // 置いてから 1 時間たっていないので断られる。
    expect(deletes()).toBe(1);
    expect(cloud.files.size).toBe(2);
    write(mainFile(), '{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    expect(deletes()).toBe(1);
    up.stop();
  });

  it('内容が同じなら上げ直さず、増えたら上げ直す', async () => {
    const up = make();
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    expect(await up.uploadFile(f)).toBe('uploaded');
    expect(await up.uploadFile(f)).toBe('unchanged');
    expect(puts()).toBe(1);
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    expect(await up.uploadFile(f)).toBe('uploaded');
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n{"a":2}\n');
    up.stop();
  });

  it('一時停止、譲ったセッション、無いファイル、claudeDir の外は skipped', async () => {
    const up = make();
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    paused = true;
    expect(await up.uploadFile(f)).toBe('skipped');
    paused = false;
    state.setYielded(UUID, true);
    expect(await up.uploadFile(f)).toBe('skipped');
    state.setYielded(UUID, false);
    expect(await up.uploadFile({ ...f, path: path.join(claudeDir, 'projects', 'none.jsonl') })).toBe('skipped');
    const outside = path.join(os.tmpdir(), 'hangar-outside.jsonl');
    fs.writeFileSync(outside, 'x');
    expect(await up.uploadFile({ ...f, path: outside })).toBe('skipped');
    expect(puts()).toBe(0);
    up.stop();
  });

  it('flushSession は待たずに上げ、noteChanged が来ていなくても手元の続きを拾う', async () => {
    const up = make();
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await up.flushSession(UUID);
    expect(puts()).toBe(1);
    await timers.advance(60_000);
    await up.idle();
    expect(puts()).toBe(1);
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    await up.flushSession(UUID);
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n{"a":2}\n');
    up.stop();
  });

  it('一度上げた本文は、伸び続けても上げてから 10 分たつまで上げ直さない', async () => {
    expect(REUPLOAD_GAP_MS).toBe(10 * 60_000);
    const up = make();
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    expect(await up.uploadFile(f)).toBe('uploaded');
    const syncedAt = timers.now;
    // 書き込みの続くセッションは 30 秒の窓のたびに知らせてくる。
    for (let i = 2; i <= 19; i++) {
      fs.appendFileSync(mainFile(), `{"a":${i}}\n`);
      up.noteChanged(f);
      await timers.advance(30_000);
      await up.idle();
    }
    expect(timers.now - syncedAt).toBe(9 * 60_000);
    expect(puts()).toBe(1);
    // 知らせが止んでも、間隔が明けたら自分で上げる。最後の中身まで載る。
    await timers.advance(REUPLOAD_GAP_MS - (timers.now - syncedAt));
    await up.idle();
    expect(puts()).toBe(2);
    expect((await plain(MAIN_KEY)).trim().split('\n')).toHaveLength(19);
    up.stop();
  });

  it('まだ上げていない本文は、間隔を待たずに 30 秒の窓で上げる', async () => {
    const other = path.join(projDir(), '22222222-2222-4222-8222-222222222222.jsonl');
    write(other, '{"b":1}\n');
    const up = make();
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    up.noteChanged({ path: other, sessionId: '22222222-2222-4222-8222-222222222222', agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(2);
    up.stop();
  });

  it('上げ直しを待っている本文があっても、新しい本文は 30 秒の窓で上げる', async () => {
    const otherUuid = '22222222-2222-4222-8222-222222222222';
    const other = path.join(projDir(), `${otherUuid}.jsonl`);
    const up = make();
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    expect(await up.uploadFile(f)).toBe('uploaded');
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    up.noteChanged(f);
    await timers.advance(30_000);
    await up.idle(); // ここで上げ直しの待ち（残り 9 分半）のタイマーが張られる。
    write(other, '{"b":1}\n');
    up.noteChanged({ path: other, sessionId: otherUuid, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect((await storedKeys()).sort()).toEqual([MAIN_KEY, `transcripts/dev-a/${otherUuid}.jsonl.gz`].sort());
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n'); // 待っている方はまだ上げない。
    up.stop();
  });

  it('上げた時刻が先の日付なら（時計が戻った）、待たずに上げ直す', async () => {
    const up = make();
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    expect(await up.uploadFile(f)).toBe('uploaded');
    db.prepare('update file_sync set synced_at = ? where key = ?').run(timers.now + 86_400_000, MAIN_KEY);
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    up.noteChanged(f);
    await timers.advance(30_000);
    await up.idle();
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n{"a":2}\n');
    up.stop();
  });

  it('flushSession（run の終わり）は間隔を待たずに上げる', async () => {
    const up = make();
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    expect(await up.uploadFile(f)).toBe('uploaded');
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    up.noteChanged(f);
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(1);
    await up.flushSession(UUID);
    expect(puts()).toBe(2);
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n{"a":2}\n');
    // 待ち行列からも下りているので、間隔が明けても同じ中身を送り直さない。
    await timers.advance(REUPLOAD_GAP_MS);
    await up.idle();
    expect(puts()).toBe(2);
    up.stop();
  });

  it('サブエージェントは subagents の鍵で上げる', async () => {
    const sub = path.join(projDir(), UUID, 'subagents', 'agent-abc123.jsonl');
    write(sub, '{"s":1}\n');
    const up = make();
    expect(await up.uploadFile({ path: sub, sessionId: UUID, agentId: 'abc123' })).toBe('uploaded');
    expect((await storedKeys())).toEqual([`transcripts/dev-a/${UUID}/subagents/agent-abc123.jsonl.gz`]);
    up.stop();
  });

  it('失敗は onError に流して待ち行列に残し、復帰で送る', async () => {
    cloud.offline = true;
    const up = make();
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(errors.map((e) => e.message)).toEqual(['offline']);
    expect((db.prepare('select count(*) c from file_sync').get() as { c: number }).c).toBe(0);
    cloud.offline = false;
    await up.flushAll();
    expect(cloud.files.size).toBe(1);
    up.stop();
  });

  it('stop の後は待ち行列に入れない', async () => {
    const up = make();
    up.stop();
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(60_000);
    await up.idle();
    expect(puts()).toBe(0);
    expect(timers.pendingCount()).toBe(0);
  });

  it('鍵の形が不正なセッションは onError に流し、黙って飲み込まず、繰り返しもしない', async () => {
    const bad = `../../${UUID}`;
    const up = make();
    up.noteChanged({ path: mainFile(), sessionId: bad, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).not.toContain(bad);
    expect(puts()).toBe(0);
    expect((db.prepare('select count(*) c from file_sync').get() as { c: number }).c).toBe(0);
    // 形が直ることはないので、待ち行列に残して毎回やり直す形にはしない。
    await up.flushAll();
    expect(errors).toHaveLength(1);
    up.stop();
  });

  it('上げている最中に本文が伸びても、送った中身と sha256 と size が食い違わない', async () => {
    const line = `{"a":"${'x'.repeat(120)}"}\n`;
    const big = line.repeat(20_000); // 2MB 強。1 チャンク（1MB）を超えるので backpressure が効く。
    write(mainFile(), big);
    const up = make();
    const orig = cloud.putFile.bind(cloud);
    // 本文を流している最中に追記が入る状況を作る。実行中のセッションでは普通に起きる。
    cloud.putFile = (meta: FileMetaIn, body: Readable) => { fs.appendFileSync(mainFile(), line); return orig(meta, body); };
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    const { entry } = await opened(MAIN_KEY);
    expect(entry.size).toBe(big.length);
    expect(entry.sha256).toBe(sha256Hex(big));
    expect(sha256Hex(await plainBuf(MAIN_KEY))).toBe(sha256Hex(big));
    expect(db.prepare('select sha256, size from file_sync where key = ?').get(MAIN_KEY)).toMatchObject({ sha256: sha256Hex(big), size: big.length });
    up.stop();
  });

  // 413（本文が 100MiB を超えた）、400（鍵や見出しの形）、403（他端末の鍵）は、
  // 何度送り直しても同じ答えが返る。待ち行列に残すと、その分の転送量を無料枠から永久に削り続ける。
  it.each([413, 400, 403])('直りようのない %i は諦めて送り直さず、知らせるのは 1 度だけ', async (status) => {
    const up = make();
    failPut(status);
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(1);
    expect(errors).toHaveLength(1);
    await up.flushAll();
    await up.flushAll();
    expect(puts()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(skipRow()).not.toBeNull();
    expect(up.skippedUploads()).toMatchObject([{ key: MAIN_KEY }]);
    up.stop();
  });

  it.each([500, 503, 408, 429, 426])('%i は一時の失敗として待ち行列に残し、復帰で送る', async (status) => {
    const up = make();
    const realPut = cloud.putFile.bind(cloud);
    failPut(status);
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(skipRow()).toBeNull();
    cloud.putFile = realPut;
    await up.flushAll();
    expect(cloud.files.size).toBe(1);
    up.stop();
  });

  it('互換の版で断られた本文は諦めず、版が合えば上げる', async () => {
    const up = make();
    cloud.minDeviceCompat = COMPAT_VERSION + 1;
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(1);
    expect(skipRow()).toBeNull();
    expect(up.skippedUploads()).toEqual([]);
    cloud.minDeviceCompat = 0;
    await up.flushAll();
    expect(cloud.files.size).toBe(1);
    up.stop();
  });

  it('上限で断られた本文は、状態番号が 4xx でも諦めず、上限が戻れば上げる', async () => {
    const up = make();
    const realPut = cloud.putFile.bind(cloud);
    cloud.putFile = (meta: FileMetaIn, body: Readable) => {
      cloud.calls.push({ method: 'putFile', args: [meta] });
      body.resume();
      return Promise.reject(new LimitError('requests', 403));
    };
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(1);
    expect(skipRow()).toBeNull();
    expect(up.skippedUploads()).toEqual([]);
    cloud.putFile = realPut;
    await up.flushAll();
    expect(cloud.files.size).toBe(1);
    up.stop();
  });

  it('諦めた項目は、30 分たつか起こし直すまで雲に触らない', async () => {
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    const up = make();
    failPut(413);
    expect(await up.uploadFile(f)).toBe('skipped');
    expect(puts()).toBe(1);
    expect(errors).toHaveLength(1);
    // 待ち行列に残さないだけでなく、直に呼ばれても雲に触らない。
    expect(await up.uploadFile(f)).toBe('skipped');
    expect(puts()).toBe(1);
    // 30 分たったら 1 度だけ試す。同じ中身で同じ相手なので、鳴らし直さない。
    timers.now += 30 * 60_000;
    expect(await up.uploadFile(f)).toBe('skipped');
    expect(puts()).toBe(2);
    expect(errors).toHaveLength(1);
    // 中身が伸びても窓は開かない。大きすぎて断られた相手に、大きくなった本文を送り直す意味は無い。
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    expect(await up.uploadFile(f)).toBe('skipped');
    expect(puts()).toBe(2);
    // 起こし直したら 1 度だけ試す。
    const up2 = make();
    expect(await up2.uploadFile(f)).toBe('skipped');
    expect(puts()).toBe(3);
    // 中身が入れ替わって小さくなったら、通るようになりうるのでその場で試す。
    fs.writeFileSync(mainFile(), '{}\n');
    expect(await up2.uploadFile(f)).toBe('skipped');
    expect(puts()).toBe(4);
    up.stop();
    up2.stop();
  });

  it('上げ直せたら諦めた記録を消す', async () => {
    const f = { path: mainFile(), sessionId: UUID, agentId: null };
    const up = make();
    const realPut = cloud.putFile.bind(cloud);
    failPut(400);
    expect(await up.uploadFile(f)).toBe('skipped');
    expect(skipRow()).not.toBeNull();
    cloud.putFile = realPut;
    timers.now += 30 * 60_000;
    expect(await up.uploadFile(f)).toBe('uploaded');
    expect(skipRow()).toBeNull();
    expect(up.skippedUploads()).toEqual([]);
    up.stop();
  });

  it('空のファイルも上げられる', async () => {
    write(mainFile(), '');
    const up = make();
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    expect(await plain(MAIN_KEY)).toBe('');
    expect((await opened(MAIN_KEY)).entry).toMatchObject({ size: 0, sha256: sha256Hex('') });
    up.stop();
  });
});

/**
 * 索引は「変化したファイル」しか知らせないので、参加より前に索引が済んでいた本文は誰も上げない。
 * 手元の台帳（transcript_files）と上げた台帳（file_sync）を突き合わせて拾い直す。
 */
describe('TranscriptUploader の取り残しの走査', () => {
  const sub = () => path.join(projDir(), UUID, 'subagents', 'agent-abc123.jsonl');
  const SUB_KEY = `transcripts/dev-a/${UUID}/subagents/agent-abc123.jsonl.gz`;

  it('参加より前に索引が済んでいた本文を積んで上げる', async () => {
    write(sub(), '{"s":1}\n');
    addIndexed(mainFile(), UUID, null);
    addIndexed(sub(), UUID, 'abc123');
    const up = make();
    expect(up.sweep()).toBe(2);
    await up.idle();
    expect((await storedKeys()).sort()).toEqual([SUB_KEY, MAIN_KEY].sort());
    expect((db.prepare('select count(*) c from file_sync').get() as { c: number }).c).toBe(2);
    // 上がってしまえば、次の走査は何も積まない。
    expect(up.sweep()).toBe(0);
    expect(puts()).toBe(2);
    up.stop();
  });

  it('消したセッションの本文は走査で拾わない', async () => {
    // 数える側は論理削除を見ていたが、拾う側が見ていなかった。
    // 見ないと、利用者が消したセッションの本文がそのままクラウドへ上がる。
    addIndexed(mainFile(), UUID, null);
    const up = make();
    expect(up.pendingSweep()).toBe(1);
    db.prepare('update sessions set deleted_at = ? where provider_session_id = ?').run(Date.now(), UUID);
    expect(up.pendingSweep()).toBe(0);
    expect(up.sweep()).toBe(0);
    await up.idle();
    expect((await storedKeys())).toEqual([]);
    up.stop();
  });

  it('取り残しの件数を数えて返す', async () => {
    // 画面に「未送信の本文 N」を出すための数である。走査と同じ突き合わせを数えるだけで、何も積まない。
    const up = make();
    expect(up.pendingSweep()).toBe(0);
    write(sub(), '{"s":1}\n');
    addIndexed(mainFile(), UUID, null);
    addIndexed(sub(), UUID, 'abc123');
    expect(up.pendingSweep()).toBe(2);
    // 数えるだけでは積まない。
    expect(puts()).toBe(0);
    expect(up.sweep()).toBe(2);
    await up.idle();
    // 上がれば 0 に戻る。
    expect(up.pendingSweep()).toBe(0);
    up.stop();
  });

  it('取り残しの件数は、消したセッションと諦めた本文を数えない', async () => {
    // 画面に出す「未送信の本文 N」は、これから上がるものの数である。
    // 消したセッションは掘り起こさないと決めた（f95b340）ので、その本文は上がる予定が無い。
    // 諦めた本文も走査が飛ばし続けるので、数に残すと N が減らないまま固まる。
    write(sub(), '{"s":1}\n');
    addIndexed(mainFile(), UUID, null);
    addIndexed(sub(), UUID, 'abc123');
    const up = make();
    expect(up.pendingSweep()).toBe(2);
    // 直りようのない 413 で 2 件とも諦めさせる。走査はもう積まない。
    failPut(413);
    expect(up.sweep()).toBe(2);
    await up.idle();
    expect(up.sweep()).toBe(0);
    expect(up.pendingSweep()).toBe(0);
    up.stop();
  });

  it('消したセッションの本文は取り残しに数えない', async () => {
    addIndexed(mainFile(), UUID, null);
    const up = make();
    expect(up.pendingSweep()).toBe(1);
    db.prepare('update sessions set deleted_at = ? where provider_session_id = ?').run(1, UUID);
    expect(up.pendingSweep()).toBe(0);
    up.stop();
  });

  it('手元の方が新しければ積み直す', async () => {
    addIndexed(mainFile(), UUID, null);
    const up = make();
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect(up.sweep()).toBe(0);
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    reindexed(mainFile());
    expect(up.sweep()).toBe(1);
    await up.idle();
    // 積みはするが、上げ直しの間隔が明けるまでは送らない。
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n');
    await timers.advance(REUPLOAD_GAP_MS);
    await up.idle();
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n{"a":2}\n');
    up.stop();
  });

  it('一度に積む数には上限がある', async () => {
    for (let i = 0; i < 5; i++) {
      const uuid = `22222222-2222-4222-8222-00000000000${i}`;
      const f = path.join(projDir(), `${uuid}.jsonl`);
      write(f, `{"n":${i}}\n`);
      addIndexed(f, uuid, null);
    }
    const up = make();
    expect(up.sweep(2)).toBe(2);
    await up.idle();
    expect(puts()).toBe(2);
    expect(up.sweep(2)).toBe(2);
    await up.idle();
    expect(puts()).toBe(4);
    up.stop();
  });

  it('上限を外すと、取り残しを 1 度に全部積む', async () => {
    // 一時停止中の「今すぐ同期」は 1 巡で上げきる。走査の余裕（上限の 5 倍）より多くても残さない。
    for (let i = 0; i < 7; i++) {
      const uuid = `33333333-3333-4333-8333-00000000000${i}`;
      const f = path.join(projDir(), `${uuid}.jsonl`);
      write(f, `{"n":${i}}\n`);
      addIndexed(f, uuid, null);
    }
    const up = make();
    expect(up.sweep(Infinity)).toBe(7);
    await up.idle();
    expect(puts()).toBe(7);
    expect(up.sweep(Infinity)).toBe(0);
    up.stop();
  });

  it('他端末から降ろした写しは積まない（持ち主が上げる）', () => {
    addIndexed(mainFile(), UUID, null, 'dev-b');
    const up = make();
    expect(up.sweep()).toBe(0);
    up.stop();
  });

  it('一時停止のあいだは積まない', () => {
    addIndexed(mainFile(), UUID, null);
    paused = true;
    const up = make();
    expect(up.sweep()).toBe(0);
    up.stop();
  });

  it('諦めた記録に載っているものを毎回また積まない', async () => {
    addIndexed(mainFile(), UUID, null);
    const up = make();
    failPut(413);
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect(puts()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(up.sweep()).toBe(0);
    expect(up.sweep()).toBe(0);
    expect(puts()).toBe(1);
    // 窓が開いたら、走査からも 1 度だけ試す。
    timers.now += 30 * 60_000;
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect(puts()).toBe(2);
    up.stop();
  });

  /**
   * 413 の経路を端から端まで通す。
   * 手で組み立てた CloudError では、実物が本当に断る大きさかどうかまでは分からない。
   * 偽物は実物の Worker と同じ 100MiB を持っているので、ここを通れば本番でも同じ道になる。
   */
  it('実物と同じ上限で断られた本文は、諦めて走査からも外れる', { timeout: 120_000 }, async () => {
    // gzip の効かない中身にする。圧縮で上限を下回ると、この検査は意味を失う。
    const block = randomBytes(1024 * 1024);
    fs.writeFileSync(mainFile(), '');
    for (let i = 0; i < MAX_BODY_BYTES / block.length + 1; i++) fs.appendFileSync(mainFile(), block);
    expect(fs.statSync(mainFile()).size).toBeGreaterThan(MAX_BODY_BYTES);
    addIndexed(mainFile(), UUID, null);
    const up = make();
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect(puts()).toBe(1);
    expect(cloud.files.size).toBe(0);
    expect((db.prepare('select count(*) c from file_sync').get() as { c: number }).c).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('413');
    expect(skipRow()).not.toBeNull();
    // 待ち行列から落ちている。走査も積み直さない。
    await up.flushAll();
    expect(up.sweep()).toBe(0);
    expect(up.sweep()).toBe(0);
    expect(puts()).toBe(1);
    up.stop();
  });

  it('stop の後は積まない', () => {
    addIndexed(mainFile(), UUID, null);
    const up = make();
    up.stop();
    expect(up.sweep()).toBe(0);
  });
});

/**
 * 本文は「クラウドを使い始めた後に動きのあったもの」だけを上げる。
 * メタデータ（セッションの一覧、要約、プロジェクト、TODO、メモ）は今までどおり全部同期する。
 * 参加より前に止まっている本文まで上げると、手元の 1.6GB をそのまま R2 へ押し込むことになる。
 */
describe('TranscriptUploader の走査は使い始めた時刻で区切る', () => {
  const JOINED = 1_700_000_000_000;
  const setMtime = (file: string, mtime: number) => {
    db.prepare('update transcript_files set mtime = ? where path = ?').run(mtime, file);
  };

  it('使い始めた時刻より前に止まった本文は拾わない', async () => {
    addIndexed(mainFile(), UUID, null);
    setMtime(mainFile(), JOINED - 1000);
    state.set(TRANSCRIPTS_FROM, JOINED);
    const up = make();
    expect(up.sweep()).toBe(0);
    await up.idle();
    expect((await storedKeys())).toEqual([]);
    up.stop();
  });

  it('使い始めた時刻より後に動いた本文は拾う', async () => {
    addIndexed(mainFile(), UUID, null);
    setMtime(mainFile(), JOINED + 1000);
    state.set(TRANSCRIPTS_FROM, JOINED);
    const up = make();
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect((await storedKeys())).toEqual([MAIN_KEY]);
    up.stop();
  });

  it('再開して中身が増えたら拾う', async () => {
    // 再開したセッションはファイルが伸びるので、索引が mtime を今の時刻へ書き直す。
    addIndexed(mainFile(), UUID, null);
    setMtime(mainFile(), JOINED - 1000);
    state.set(TRANSCRIPTS_FROM, JOINED);
    const up = make();
    expect(up.sweep()).toBe(0);
    fs.appendFileSync(mainFile(), '{"a":2}\n');
    reindexed(mainFile());
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n{"a":2}\n');
    up.stop();
  });

  it('刻んでいなければ今までどおり全部拾う', async () => {
    // 既に参加している端末の振る舞いを変えない。
    addIndexed(mainFile(), UUID, null);
    setMtime(mainFile(), JOINED - 1000);
    expect(state.get(TRANSCRIPTS_FROM)).toBeNull();
    const up = make();
    expect(up.pendingSweep()).toBe(1);
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect((await storedKeys())).toEqual([MAIN_KEY]);
    up.stop();
  });

  it('未送信の本文の数も同じ時刻で区切る', () => {
    // 区切らないと、上げる予定の無い本文が画面に何百件も並び続ける。
    const other = path.join(projDir(), '33333333-3333-4333-8333-333333333333.jsonl');
    write(other, '{"b":1}\n');
    addIndexed(mainFile(), UUID, null);
    addIndexed(other, '33333333-3333-4333-8333-333333333333', null);
    setMtime(mainFile(), JOINED - 1000);
    setMtime(other, JOINED + 1000);
    const up = make();
    expect(up.pendingSweep()).toBe(2);
    state.set(TRANSCRIPTS_FROM, JOINED);
    expect(up.pendingSweep()).toBe(1);
    up.stop();
  });

  it('床を 0 に落とすと、参加より前の本文もまた拾う', async () => {
    // hangar cloud backfill が書くのがこの 0 である。サーバを立て直さなくても次の走査から効く。
    addIndexed(mainFile(), UUID, null);
    setMtime(mainFile(), JOINED - 1000);
    state.set(TRANSCRIPTS_FROM, JOINED);
    const up = make();
    expect(up.sweep()).toBe(0);
    expect(up.pendingSweep()).toBe(0);
    state.set(TRANSCRIPTS_FROM, 0);
    expect(up.pendingSweep()).toBe(1);
    expect(up.sweep()).toBe(1);
    await up.idle();
    expect((await storedKeys())).toEqual([MAIN_KEY]);
    up.stop();
  });
});

/**
 * opencode の本文（docs/design.md「opencode の本文の同期」）。
 * 本文は opencode の SQLite にあり、見張れるファイルが無い。上げる直前に `session export` で書き出したファイルを、Claude の本文と同じ道で上げる。
 * 試験では書き出しの口を偽物にする（実物の書き出しは provider/opencode/export.test.ts）。
 */
describe('TranscriptUploader の opencode の本文', () => {
  const SES = 'ses_f55764078ffeDvMj180Fvan87g';
  const OC_KEY = `opencode/dev-a/${SES}.json.gz`;
  let exportDir: string;
  /** 書き出すたびに返す中身。null なら書き出しに失敗する。 */
  let content: string | null;
  let exports: string[];
  const source = () => ({
    dir: exportDir,
    async export(id: string): Promise<string | null> {
      exports.push(id);
      if (content === null) return null;
      const file = path.join(exportDir, `${id}.json`);
      write(file, content);
      return file;
    },
  });
  const makeOc = (o: { bound?: boolean } = {}) => new TranscriptUploader({
    db, deviceId: 'dev-a', claudeDir, client: cloud, keyring: cloud.keyring, state, now: () => timers.now, timers, isPaused: () => paused,
    onError: (p, m) => errors.push({ path: p, message: m }),
    opencode: () => (o.bound === false ? null : source()),
  });
  const addOpencodeSession = (id: string) => {
    db.prepare('insert or ignore into sessions (id, provider, provider_session_id, cwd, started_at, last_activity_at, home_device, origin_device, updated_at) values (?,?,?,?,?,?,?,?,?)')
      .run(`s-${id}`, 'opencode', id, '/Users/me/workspace/alpha', 1, 1, 'dev-a', 'dev-a', 1);
  };
  const openedOc = async () => (await cloud.openedFile(await cloud.opencodeKey(SES)))!;

  beforeEach(() => {
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ocx-'));
    content = '{"info":{"id":"ses_f55764078ffeDvMj180Fvan87g"},"messages":[]}\n';
    exports = [];
    addOpencodeSession(SES);
  });

  it('ターンの終わりから 30 秒の窓で書き出して上げる。path は projects/ の外、種類は transcript のまま', async () => {
    const up = makeOc();
    up.noteOpencode(SES);
    await timers.advance(29_000);
    await up.idle();
    // 書き出しは上げる直前に 1 回だけ行う（ターンの終わりのたびには書き出さない）。
    expect(exports).toEqual([]);
    await timers.advance(1_000);
    await up.idle();
    expect(exports).toEqual([SES]);
    expect(puts()).toBe(1);
    const o = await openedOc();
    expect(o.body.toString()).toBe(content);
    expect(o.entry).toMatchObject({ path: `opencode/${SES}.json`, kind: 'transcript', origin: 'dev-a', size: Buffer.byteLength(content!), sha256: sha256Hex(content!) });
    // R2 の鍵名にもメタの外側にも、会話の ID は出ない。
    const stored = [...cloud.files.values()][0]!;
    expect(stored.entry.key.includes(SES)).toBe(false);
    expect(JSON.stringify(stored.entry).includes(SES)).toBe(false);
    expect(db.prepare('select kind, path, device_id, sha256 from file_sync where key = ?').get(OC_KEY)).toEqual({ kind: 'transcript', path: `opencode/${SES}.json`, device_id: 'dev-a', sha256: sha256Hex(content!) });
    expect(errors).toEqual([]);
    up.stop();
  });

  it('一度上げた会話は、ターンが続いても上げてから 10 分たつまで書き出しも上げ直しもしない', async () => {
    const up = makeOc();
    up.noteOpencode(SES);
    await timers.advance(30_000);
    await up.idle();
    expect(exports).toHaveLength(1);
    content = '{"info":{"id":"ses_f55764078ffeDvMj180Fvan87g"},"messages":[1]}\n';
    for (let i = 0; i < 5; i++) {
      up.noteOpencode(SES);
      await timers.advance(60_000);
      await up.idle();
    }
    expect(exports).toHaveLength(1);
    expect(puts()).toBe(1);
    await timers.advance(REUPLOAD_GAP_MS);
    await up.idle();
    expect(exports).toHaveLength(2);
    expect(puts()).toBe(2);
    expect((await openedOc()).body.toString()).toBe(content);
    up.stop();
  });

  it('run の終わり（flushSession）は間隔を待たずに書き出して上げ、中身が同じなら送らない', async () => {
    const up = makeOc();
    up.noteOpencode(SES);
    await timers.advance(30_000);
    await up.idle();
    content = '{"info":{"id":"ses_f55764078ffeDvMj180Fvan87g"},"messages":[2]}\n';
    // 待ち行列に何も無くても、opencode の会話なら書き出し直す。
    await up.flushSession(SES);
    expect(exports).toHaveLength(2);
    expect(puts()).toBe(2);
    expect((await openedOc()).body.toString()).toBe(content);
    // run の終わりの 2 回目（5 秒後）。中身が変わらなければ PUT しない。
    await up.flushSession(SES);
    expect(exports).toHaveLength(3);
    expect(puts()).toBe(2);
    up.stop();
  });

  it('一時停止、譲った会話、書き出しの口が無いときは書き出さない。書き出しの失敗は黙って飛ばす', async () => {
    paused = true;
    const up = makeOc();
    await up.flushSession(SES);
    paused = false;
    state.setYielded(SES, true);
    await up.flushSession(SES);
    state.setYielded(SES, false);
    expect(exports).toEqual([]);
    const unbound = makeOc({ bound: false });
    unbound.noteOpencode(SES);
    await unbound.flushSession(SES);
    content = null;
    await up.flushSession(SES);
    expect(exports).toEqual([SES]);
    expect(puts()).toBe(0);
    expect(errors).toEqual([]);
    up.stop();
    unbound.stop();
  });

  it('Claude の会話の flushSession は書き出さない。Claude の本文の鍵名と台帳は今までと同じ', async () => {
    const up = makeOc();
    addSession(UUID);
    await up.flushSession(UUID);
    expect(await up.uploadFile({ path: mainFile(), sessionId: UUID, agentId: null })).toBe('uploaded');
    expect(exports).toEqual([]);
    const stored = [...cloud.files.values()].map((f) => f.entry.key);
    expect(stored).toEqual([await transcriptBlobKey((await cloud.keyring).current().index, 'dev-a', 'dev-a', UUID, null)]);
    expect((db.prepare('select key from file_sync').all() as { key: string }[]).map((r) => r.key)).toEqual([MAIN_KEY]);
    up.stop();
  });

  it('鍵に使えない会話の ID は書き出さずに知らせる', async () => {
    const up = makeOc();
    up.noteOpencode('../evil');
    await timers.advance(30_000);
    await up.idle();
    expect(exports).toEqual([]);
    expect(puts()).toBe(0);
    expect(errors).toHaveLength(1);
    up.stop();
  });

  it('世代を回した後に上げ直したら、古い世代の鍵名を消しにいく', async () => {
    const ring = await Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 1 }));
    cloud = new FakeCloudClient({ deviceId: 'dev-a', keyring: ring });
    const up = new TranscriptUploader({ db, deviceId: 'dev-a', claudeDir, client: cloud, keyring: ring, state, now: () => timers.now, timers, isPaused: () => paused, opencode: () => source() });
    await up.flushSession(SES);
    const first = await cloud.opencodeKey(SES);
    ring.useEpoch(2);
    content = '{"info":{"id":"ses_f55764078ffeDvMj180Fvan87g"},"messages":[3]}\n';
    await up.flushSession(SES);
    const del = cloud.calls.filter((c) => c.method === 'deleteBlobs');
    expect(del).toHaveLength(1);
    expect(del[0]!.args[0]).toEqual([first]);
    up.stop();
  });
});
