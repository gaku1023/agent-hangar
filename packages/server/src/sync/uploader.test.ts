import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import type { FileMetaIn } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb, type Db } from '../db/open.ts';
import { CloudError } from './client.ts';
import { decryptBuffer, deriveFileKey, sha256Hex } from './crypto.ts';
import { SyncStateStore } from './state.ts';
import { TranscriptUploader } from './uploader.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const key = deriveFileKey('join-secret');
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
const make = () => new TranscriptUploader({ db, deviceId: 'dev-a', claudeDir, client: cloud, key, state, now: () => timers.now, timers, isPaused: () => paused, onError: (p, m) => errors.push({ path: p, message: m }) });
const plainBuf = async (k: string) => gunzipSync(await decryptBuffer(key, cloud.files.get(k)!.body));
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
    expect([...cloud.files.keys()]).toEqual([MAIN_KEY]);
    expect(await plain(MAIN_KEY)).toBe('{"a":1}\n');
    expect(cloud.files.get(MAIN_KEY)!.entry).toMatchObject({
      path: `projects/-Users-me-workspace-alpha/${UUID}.jsonl`, kind: 'transcript', encrypted: true, size: 8, sha256: sha256Hex('{"a":1}\n'),
    });
    expect(db.prepare('select * from file_sync where key = ?').get(MAIN_KEY)).toMatchObject({ kind: 'transcript', device_id: 'dev-a', sha256: sha256Hex('{"a":1}\n'), size: 8, remote_seq: 1 });
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

  it('サブエージェントは subagents の鍵で上げる', async () => {
    const sub = path.join(projDir(), UUID, 'subagents', 'agent-abc123.jsonl');
    write(sub, '{"s":1}\n');
    const up = make();
    expect(await up.uploadFile({ path: sub, sessionId: UUID, agentId: 'abc123' })).toBe('uploaded');
    expect([...cloud.files.keys()]).toEqual([`transcripts/dev-a/${UUID}/subagents/agent-abc123.jsonl.gz`]);
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
    const entry = cloud.files.get(MAIN_KEY)!.entry;
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

  it.each([500, 503, 408, 429])('%i は一時の失敗として待ち行列に残し、復帰で送る', async (status) => {
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
    expect(cloud.files.get(MAIN_KEY)!.entry).toMatchObject({ size: 0, sha256: sha256Hex('') });
    up.stop();
  });
});
