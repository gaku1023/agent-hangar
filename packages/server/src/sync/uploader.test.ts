import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import type { FileMetaIn } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient, MAX_BODY_BYTES } from '../../test/fake-cloud.ts';
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
    expect([...cloud.files.keys()].sort()).toEqual([SUB_KEY, MAIN_KEY].sort());
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
    expect([...cloud.files.keys()]).toEqual([]);
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
