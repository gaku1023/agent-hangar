import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transcriptKey, type FileEntry, type FileMetaIn } from '@agent-hangar/shared';
import type { CloudClient } from './client.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { openDb, type Db } from '../db/open.ts';
import { deriveFileKey, encryptBuffer, sha256Hex } from './crypto.ts';
import { RemotePuller, remoteTranscriptPath, RETRY_SKIPPED_AFTER_MS } from './puller.ts';
import { SyncStateStore } from './state.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const key = deriveFileKey('join-secret');
let db: Db;
let cloud: FakeCloudClient;
let home: string;
let state: SyncStateStore;
const errors: { key: string; message: string }[] = [];

const putRemote = async (device: string, rel: string, text: string, k = `transcripts/${device}/${UUID}.jsonl.gz`, kind: 'transcript' | 'config' = 'transcript') => {
  const enc = await encryptBuffer(key, gzipSync(Buffer.from(text)));
  const meta: FileMetaIn = { key: k, path: rel, kind, sha256: sha256Hex(text), size: Buffer.byteLength(text), mtime: 1_700_000_000_000, encrypted: true };
  await cloud.asDevice(device).putFile(meta, Readable.from([enc]));
};
const make = (over: Partial<ConstructorParameters<typeof RemotePuller>[0]> = {}) =>
  new RemotePuller({ db, deviceId: 'dev-a', home, client: cloud, key, state, onError: (k, m) => errors.push({ key: k, message: m }), ...over });

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'dev-a' });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  state = new SyncStateStore(db);
  errors.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

describe('remoteTranscriptPath', () => {
  it('remote/<端末>/<相対パス> を組み立て、怪しい相対パスは拒む', () => {
    expect(remoteTranscriptPath('/h', 'dev-b', `projects/-w-alpha/${UUID}.jsonl`)).toBe(path.join('/h', 'remote', 'dev-b', 'projects', '-w-alpha', `${UUID}.jsonl`));
    expect(() => remoteTranscriptPath('/h', 'dev-b', '../../etc/passwd')).toThrow();
    expect(() => remoteTranscriptPath('/h', 'dev-b', 'projects/../../x.jsonl')).toThrow();
    expect(() => remoteTranscriptPath('/h', '../evil', 'projects/x.jsonl')).toThrow();
    expect(() => remoteTranscriptPath('/h', 'dev-b', 'skills/x.md')).toThrow();
    expect(() => remoteTranscriptPath('/h', 'dev-b', '/projects/x.jsonl')).toThrow();
  });
});

describe('RemotePuller', () => {
  it('他端末の本文を復号して展開し、file_sync と mtime を揃える', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
    const target = remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}\n');
    expect(Math.floor(fs.statSync(target).mtimeMs)).toBe(1_700_000_000_000);
    expect(db.prepare('select device_id, sha256, size from file_sync where key = ?').get(`transcripts/dev-b/${UUID}.jsonl.gz`)).toEqual({ device_id: 'dev-b', sha256: sha256Hex('{"a":1}\n'), size: 8 });
    expect(state.getNumber('filesSeq', 0)).toBe(1);
    // 同じ指紋のまま手元にあるものは降ろし直さない。
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    // 一時ファイルを残さない。
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('自端末の分は降ろさず、設定は呼び出し側に渡す', async () => {
    await putRemote('dev-a', `projects/-w-alpha/${UUID}.jsonl`, 'mine\n');
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config/dev-b/CLAUDE.md', 'config');
    const seen: FileEntry[][] = [];
    const p = make({ onConfigEntries: async (e) => { seen.push(e); } });
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 1 });
    expect(seen[0]!.map((e) => e.key)).toEqual(['config/dev-b/CLAUDE.md']);
    expect(fs.existsSync(path.join(home, 'remote', 'dev-a'))).toBe(false);
  });

  it('SHA-256 が合わなければ捨てて、次の pull でやり直す', async () => {
    const enc = await encryptBuffer(key, gzipSync(Buffer.from('body\n')));
    await cloud.asDevice('dev-b').putFile({ key: `transcripts/dev-b/${UUID}.jsonl.gz`, path: `projects/-w-alpha/${UUID}.jsonl`, kind: 'transcript', sha256: 'f'.repeat(64), size: 5, mtime: 1, encrypted: true }, Readable.from([enc]));
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(errors[0]!.message).toContain('SHA-256');
    const target = remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(state.getNumber('filesSeq', -1)).toBe(0);
  });

  it('鍵と相対パスが食い違う項目は受け取らない', async () => {
    // 鍵は dev-b の UUID なのに、相対パスが別のセッションを指している。
    const other = '22222222-2222-4222-8222-222222222222';
    await putRemote('dev-b', `projects/-w-alpha/${other}.jsonl`, 'swapped\n');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(errors[0]!.message).toContain('鍵');
    expect(fs.existsSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${other}.jsonl`))).toBe(false);
    expect(state.getNumber('filesSeq', -1)).toBe(0);
  });

  it('壊れた本文は書き掛けを残さず、次の pull でやり直す', async () => {
    const enc = await encryptBuffer(key, gzipSync(Buffer.from('body\n')));
    await cloud.asDevice('dev-b').putFile({ key: `transcripts/dev-b/${UUID}.jsonl.gz`, path: `projects/-w-alpha/${UUID}.jsonl`, kind: 'transcript', sha256: sha256Hex('body\n'), size: 5, mtime: 1, encrypted: true }, Readable.from([enc.subarray(0, enc.length - 8)]));
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(errors).toHaveLength(1);
    const target = remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(state.getNumber('filesSeq', -1)).toBe(0);
  });

  it('サブエージェントの写しも降ろす', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}/subagents/agent-ab12.jsonl`, 'sub\n', `transcripts/dev-b/${UUID}/subagents/agent-ab12.jsonl.gz`);
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}/subagents/agent-ab12.jsonl`), 'utf8')).toBe('sub\n');
  });

  it('設定の取り込みが失敗した回は filesSeq を進めない', async () => {
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config/dev-b/CLAUDE.md', 'config');
    const p = make({ onConfigEntries: async () => { throw new Error('書けません'); } });
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 1 });
    expect(state.getNumber('filesSeq', -1)).toBe(0);
  });

  it('latestRemoteMain は更新時刻が最新の写しを返す', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'b-body\n');
    await putRemote('dev-c', `projects/-w-alpha/${UUID}.jsonl`, 'c-body-longer\n', `transcripts/dev-c/${UUID}.jsonl.gz`);
    const p = make();
    await p.pullNow();
    db.prepare('update file_sync set mtime = 1000 where device_id = ?').run('dev-b');
    db.prepare('update file_sync set mtime = 2000 where device_id = ?').run('dev-c');
    const best = p.latestRemoteMain(UUID)!;
    expect(best.deviceId).toBe('dev-c');
    expect(best.path).toBe(remoteTranscriptPath(home, 'dev-c', `projects/-w-alpha/${UUID}.jsonl`));
    expect(best.size).toBe(Buffer.byteLength('c-body-longer\n'));
    expect(p.latestRemoteMain('22222222-2222-4222-8222-222222222222')).toBeNull();
    // 台帳にあっても手元に実体が無ければ飛ばす。
    fs.rmSync(best.path);
    expect(p.latestRemoteMain(UUID)!.deviceId).toBe('dev-b');
  });

  it('上げる側の鍵の形と、降ろす側の鍵と相対パスの検査が一致する', async () => {
    // uploader は path に path.relative(claudeDir, ファイル) を、key に shared の transcriptKey を使う。
    // どちらか片方の形が変わったら、ここが落ちて気付けるようにしておく。
    const claudeDir = path.join(path.sep, 'c');
    const cases: { agentId: string | null; file: string }[] = [
      { agentId: null, file: path.join(claudeDir, 'projects', '-w-alpha', `${UUID}.jsonl`) },
      { agentId: 'abc123', file: path.join(claudeDir, 'projects', '-w-alpha', UUID, 'subagents', 'agent-abc123.jsonl') },
    ];
    for (const c of cases) {
      const rel = path.relative(claudeDir, c.file).split(path.sep).join('/');
      await putRemote('dev-b', rel, `body-${c.agentId}\n`, transcriptKey('dev-b', UUID, c.agentId));
    }
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 2, configEntries: 0 });
    expect(errors).toEqual([]);
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`), 'utf8')).toBe('body-null\n');
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}/subagents/agent-abc123.jsonl`), 'utf8')).toBe('body-abc123\n');
  });

  it('同じ項目で続けて失敗したら 3 回で諦めて先に進む', async () => {
    const enc = await encryptBuffer(key, gzipSync(Buffer.from('body\n')));
    const badKey = `transcripts/dev-b/${UUID}.jsonl.gz`;
    await cloud.asDevice('dev-b').putFile({ key: badKey, path: `projects/-w-alpha/${UUID}.jsonl`, kind: 'transcript', sha256: 'f'.repeat(64), size: 5, mtime: 1, encrypted: true }, Readable.from([enc]));
    const other = '33333333-3333-4333-8333-333333333333';
    await putRemote('dev-b', `projects/-w-alpha/${other}.jsonl`, 'good\n', `transcripts/dev-b/${other}.jsonl.gz`);
    const p = make();
    // 同じ回の後ろの項目は降ろす。止まるのは filesSeq を進めることだけである。
    expect(await p.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
    expect(fs.existsSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${other}.jsonl`))).toBe(true);
    expect(state.getNumber('filesSeq', -1)).toBe(0);
    // 2 回目も手前で止まるので、降ろし終えた本文まで毎回読み直しに掛かる。
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(0);
    // 3 回目で諦め、ようやく filesSeq が進む。
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(2);
    // 鳴らすのは 1 回目と諦めたときだけで、間は黙る。
    expect(errors.map((e) => e.key)).toEqual([badKey, badKey]);
    expect(errors[0]!.message).toContain('SHA-256');
    expect(errors[1]!.message).toContain('飛ばします');
    expect(p.skippedEntries()).toEqual([{ key: badKey, attempts: 3, message: expect.stringContaining('SHA-256') }]);
    // 諦めた後はもう試さないし、鳴らさない。
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(errors).toHaveLength(2);
  });

  it('上げ直された本文は諦めた後でももう一度試す', async () => {
    const enc = await encryptBuffer(key, gzipSync(Buffer.from('body\n')));
    const k = `transcripts/dev-b/${UUID}.jsonl.gz`;
    const rel = `projects/-w-alpha/${UUID}.jsonl`;
    for (let i = 0; i < 3; i++) {
      await cloud.asDevice('dev-b').putFile({ key: k, path: rel, kind: 'transcript', sha256: 'f'.repeat(64), size: 5, mtime: 1, encrypted: true }, Readable.from([enc]));
    }
    const p = make();
    // 同じ指紋のまま置き直されても、数えるのは指紋ごとなので 3 回で諦める。
    for (let i = 0; i < 3; i++) await p.pullNow();
    expect(p.skippedEntries()).toHaveLength(1);
    // 中身が変わった（指紋が変わった）ら、数え直して取り直す。
    await putRemote('dev-b', rel, 'fixed\n', k);
    expect(await p.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
    expect(p.skippedEntries()).toEqual([]);
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', rel), 'utf8')).toBe('fixed\n');
  });

  it('設定の取り込みも 3 回で諦めて先に進む', async () => {
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config/dev-b/CLAUDE.md', 'config');
    const p = make({ onConfigEntries: async () => { throw new Error('書けません'); } });
    await p.pullNow();
    expect(state.getNumber('filesSeq', -1)).toBe(0);
    await p.pullNow();
    expect(state.getNumber('filesSeq', -1)).toBe(0);
    await p.pullNow();
    expect(state.getNumber('filesSeq', -1)).toBe(1);
    expect(errors).toHaveLength(2);
    expect(errors[1]!.message).toContain('飛ばします');
  });

  it('置き場は 0700、降ろした本文は 0600 で置く', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    await p.pullNow();
    const target = remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    const dirs = [path.join(home, 'remote'), path.join(home, 'remote', 'dev-b'), path.join(home, 'remote', 'dev-b', 'projects'), path.dirname(target)];
    for (const d of dirs) expect([d, fs.statSync(d).mode & 0o777]).toEqual([d, 0o700]);
  });

  it('諦めた本文は、原因が直ってサーバを起こし直せば降りてくる', async () => {
    // レビューの scratchpad/giveup2.ts の筋。置き場を普通のファイルで塞いで一時的な事故を作る。
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n');
    fs.writeFileSync(path.join(home, 'remote'), 'ふさぐ');
    const p = make();
    for (let i = 0; i < 3; i++) await p.pullNow();
    expect(p.skippedEntries()).toHaveLength(1);
    expect(state.getNumber('filesSeq', -1)).toBe(1);
    // 事故を直して、サーバを起こし直す（新しい RemotePuller を作る）。
    fs.rmSync(path.join(home, 'remote'));
    const p2 = make();
    // 諦めた記録は起こし直しても残っている。
    expect(p2.skippedEntries()).toEqual([{ key: `transcripts/dev-b/${UUID}.jsonl.gz`, attempts: 3, message: expect.any(String) }]);
    // filesSeq は進んだままなので一覧には載らないが、諦めた記録から取り直す。
    expect(await p2.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`), 'utf8')).toBe('body\n');
    expect(p2.skippedEntries()).toEqual([]);
    expect((db.prepare('select count(*) c from file_sync').get() as { c: number }).c).toBe(1);
  });

  it('諦めた記録は起こし直しても数を引き継ぎ、鳴らし直さない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n');
    fs.writeFileSync(path.join(home, 'remote'), 'ふさぐ');
    const p = make();
    await p.pullNow();
    expect(errors).toHaveLength(1); // 1 回目だけ鳴る
    const p2 = make();
    await p2.pullNow();
    // 起こし直しても数は 1 から数え直さない。2 回目なので黙る。
    expect(errors).toHaveLength(1);
    const p3 = make();
    await p3.pullNow();
    // 3 回目で諦めたことだけを 1 度鳴らす。
    expect(errors).toHaveLength(2);
    expect(errors[1]!.message).toContain('飛ばします');
    expect(p3.skippedEntries()[0]!.attempts).toBe(3);
    // 以降、何度起こし直しても鳴らない。
    const p4 = make();
    await p4.pullNow();
    await p4.pullNow();
    expect(errors).toHaveLength(2);
    expect(p4.skippedEntries()[0]!.attempts).toBeGreaterThan(3);
  });

  it('諦めた本文は、起こし直さなくても時間が経てば取り直す', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n');
    fs.writeFileSync(path.join(home, 'remote'), 'ふさぐ');
    let clock = 1_000_000;
    const p = make({ now: () => clock });
    for (let i = 0; i < 3; i++) await p.pullNow();
    expect(p.skippedEntries()).toHaveLength(1);
    fs.rmSync(path.join(home, 'remote'));
    // 間隔が空くまでは取り直さない。
    clock += 60_000;
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(p.skippedEntries()).toHaveLength(1);
    // 間隔が空いたら取り直す。
    clock += RETRY_SKIPPED_AFTER_MS;
    expect(await p.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
    expect(p.skippedEntries()).toEqual([]);
  });

  it('諦めた設定も起こし直せば渡し直す', async () => {
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config/dev-b/CLAUDE.md', 'config');
    const p = make({ onConfigEntries: async () => { throw new Error('書けません'); } });
    for (let i = 0; i < 3; i++) await p.pullNow();
    expect(p.skippedEntries()).toHaveLength(1);
    expect(state.getNumber('filesSeq', -1)).toBe(1);
    const seen: FileEntry[][] = [];
    const p2 = make({ onConfigEntries: async (e) => { seen.push(e); } });
    expect(await p2.pullNow()).toEqual({ downloaded: 0, configEntries: 1 });
    expect(seen[0]!.map((e) => e.key)).toEqual(['config/dev-b/CLAUDE.md']);
    expect(p2.skippedEntries()).toEqual([]);
  });

  it('平文と申告された本文は受け取らない', async () => {
    // 決定 5 は「本文は暗号化して R2 に置く」である。受け取る側でも申告を鵜呑みにしない。
    const body = '{"a":1}\n';
    // 上げる側の検査を迂回して置く。
    // 実物の Worker も平文の本文を断るが、この試験が見るのは受け取る側の守りである。
    cloud.asDevice('dev-b').seedUnchecked(
      { key: `transcripts/dev-b/${UUID}.jsonl.gz`, path: `projects/-w-alpha/${UUID}.jsonl`, kind: 'transcript', sha256: sha256Hex(body), size: Buffer.byteLength(body), mtime: 1, encrypted: false },
      gzipSync(Buffer.from(body)),
    );
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(errors[0]!.message).toContain('暗号化');
    expect(fs.existsSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`))).toBe(false);
  });

  it('rename の前に fsync してから本物にする', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
    expect(fsyncSpy).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalled();
    // 電源が落ちても書き掛けが本物の名前で残らないよう、順序は fsync が先である（copy.ts と同じ規則）。
    expect(fsyncSpy.mock.invocationCallOrder[0]!).toBeLessThan(renameSpy.mock.invocationCallOrder[0]!);
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`), 'utf8')).toBe('{"a":1}\n');
  });

  it('一覧が手前を指す応答でも filesSeq を戻さない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n');
    // nextSeq が since より手前を指す壊れた応答。実物の Worker は返さないが、防具として確かめる。
    const rewinding: CloudClient = {
      health: () => cloud.health(),
      pushChanges: (c) => cloud.pushChanges(c),
      pullChanges: (s, l) => cloud.pullChanges(s, l),
      snapshot: (a, l) => cloud.snapshot(a, l),
      putFile: (m, b) => cloud.putFile(m, b),
      getFile: (k) => cloud.getFile(k),
      deleteFile: (k) => cloud.deleteFile(k),
      listFiles: async (s, l) => ({ ...(await cloud.listFiles(s, l)), files: [], nextSeq: 0, more: false }),
    };
    state.set('filesSeq', 5);
    await make({ client: rewinding }).pullNow();
    expect(state.getNumber('filesSeq', -1)).toBe(5);
  });

  it('filesSeq をわざと 0 に戻して取り直す筋は、後退を止める防具に邪魔されない', async () => {
    // 410 を受けた全件の取り直しのように、呼び手が意図して 0 に戻す道がある。
    // 後退を止める防具は「その回の since より下がらない」だけなので、この道は普通に進む。
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n');
    const other = '44444444-4444-4444-8444-444444444444';
    await putRemote('dev-b', `projects/-w-alpha/${other}.jsonl`, 'body2\n', `transcripts/dev-b/${other}.jsonl.gz`);
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 2, configEntries: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(2);
    state.set('filesSeq', 0);
    // 手元に実体があって指紋も合うので降ろし直しはしないが、filesSeq は先頭まで戻る。
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(2);
  });
});

/**
 * 止め方の作法。
 * SyncEngine と ClaudeConfigSync と TranscriptUploader と同じく、
 * 降ろしも 1 本の鎖に並べて `idle()` で待ち合わせ、`stop()` で以後を 1 件も出さない形にする。
 */
describe('RemotePuller の止め方', () => {
  it('止めたら、鎖に並んだ降ろしは 1 件も要求を出さない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const realList = cloud.listFiles.bind(cloud);
    let issued = 0;
    let answering = false;
    const waiting: (() => void)[] = [];
    // 応答が返らない状況を作る。クラウドへ届かないときは 30 秒待ちなので、鎖は減るより速く伸びる。
    cloud.listFiles = ((since: number, limit: number) => {
      issued++;
      if (answering) return realList(since, limit);
      return new Promise((resolve, reject) => { waiting.push(() => { realList(since, limit).then(resolve, reject); }); });
    }) as typeof cloud.listFiles;

    const p = make();
    const first = p.pullNow();
    // 1 件目が listFiles の中で止まるまで進める。
    for (let i = 0; i < 100 && waiting.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(waiting.length).toBe(1);

    // 1 件目が返らないあいだに、2 件目が鎖の後ろへ並ぶ。
    const second = p.pullNow();
    p.stop();
    const afterStop = issued;

    // 止めた後で応答を返す。
    answering = true;
    for (const w of waiting.splice(0)) w();
    // 既に走り出していた 1 件目は最後まで走る。
    expect(await first).toEqual({ downloaded: 1, configEntries: 0 });
    // 鎖に並んだ 2 件目は先頭の検査で譲る。
    expect(await second).toEqual({ downloaded: 0, configEntries: 0 });
    await p.idle();
    expect(issued - afterStop).toBe(0);
  });

  it('止めた後に頼んでも要求を出さない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    let issued = 0;
    const realList = cloud.listFiles.bind(cloud);
    cloud.listFiles = ((since: number, limit: number) => { issued++; return realList(since, limit); }) as typeof cloud.listFiles;
    const p = make();
    p.stop();
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 0 });
    await p.idle();
    expect(issued).toBe(0);
    expect(fs.existsSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`))).toBe(false);
  });

  it('鎖に並べるので、同時に頼んでも降ろしは重ならない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    // 重なると同じ鍵を 2 本の流れが同じ一時ファイルへ書き、filesSeq も互いに上書きし合う。
    const [a, b] = await Promise.all([p.pullNow(), p.pullNow()]);
    expect(a.downloaded + b.downloaded).toBe(1);
    expect(state.getNumber('filesSeq', -1)).toBe(1);
    p.stop();
  });
});
