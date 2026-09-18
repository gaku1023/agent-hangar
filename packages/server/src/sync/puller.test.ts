import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptKey, type FileEntry, type FileMetaIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { openDb, type Db } from '../db/open.ts';
import { deriveFileKey, encryptBuffer, sha256Hex } from './crypto.ts';
import { RemotePuller, remoteTranscriptPath } from './puller.ts';
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
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

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
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config/CLAUDE.md', 'config');
    const seen: FileEntry[][] = [];
    const p = make({ onConfigEntries: async (e) => { seen.push(e); } });
    expect(await p.pullNow()).toEqual({ downloaded: 0, configEntries: 1 });
    expect(seen[0]!.map((e) => e.key)).toEqual(['config/CLAUDE.md']);
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
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config/CLAUDE.md', 'config');
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
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config/CLAUDE.md', 'config');
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
});
