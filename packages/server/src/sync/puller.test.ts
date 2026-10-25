import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPAT_VERSION, encodeEpochList, generateKeyPair, sealFileMeta, sealKeybox, toBase64Url, transcriptBlobKey, type FileEntry } from '@agent-hangar/shared';
import { testCloudConfig, testKey } from '../../test/cloudConfig.ts';
import type { CloudConfig } from '../config/cloud.ts';
import { RosterStore, rosterRefresh } from './roster.ts';
import { CompatError, LimitError, type CloudClient } from './client.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { openDb, type Db } from '../db/open.ts';
import { sha256Hex } from './crypto.ts';
import { Keyring } from './keyring.ts';
import { RemotePuller, remoteTranscriptPath, RETRY_SKIPPED_AFTER_MS, rewindSkippedFiles } from './puller.ts';
import { SyncStateStore } from './state.ts';
import { expectMode } from '../../test/platform.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
let db: Db;
let cloud: FakeCloudClient;
let home: string;
let state: SyncStateStore;
const errors: { key: string; message: string }[] = [];

/** device として平文の本文を上げる。R2 の鍵名は中身のパスから今の世代で求める（uploader と同じ）。 */
const putRemote = async (device: string, rel: string, text: string, kind: 'transcript' | 'config' = 'transcript', o: { sha256?: string } = {}) =>
  cloud.asDevice(device).putText({ path: rel, kind, sha256: o.sha256 }, text);
const make = (over: Partial<ConstructorParameters<typeof RemotePuller>[0]> = {}) =>
  new RemotePuller({ db, deviceId: 'dev-a', home, client: cloud, state, onError: (k, m) => errors.push({ key: k, message: m }), ...over });

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
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    const target = remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}\n');
    expect(Math.floor(fs.statSync(target).mtimeMs)).toBe(1_700_000_000_000);
    expect(db.prepare('select device_id, sha256, size from file_sync where key = ?').get(`transcripts/dev-b/${UUID}.jsonl.gz`)).toEqual({ device_id: 'dev-b', sha256: sha256Hex('{"a":1}\n'), size: 8 });
    expect(state.getNumber('filesSeq', 0)).toBe(1);
    // 同じ指紋のまま手元にあるものは降ろし直さない。
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    // 一時ファイルを残さない。
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('写しを置いた回だけ、置いた数を onDownloaded で知らせる', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const seen: number[] = [];
    const p = make({ onDownloaded: (n) => seen.push(n) });
    await p.pullNow();
    expect(seen).toEqual([1]);
    // 何も置かなかった回は知らせない。
    await p.pullNow();
    expect(seen).toEqual([1]);
  });

  it('自端末の分は降ろさず、設定（kind が config）も降ろさずに先へ進む', async () => {
    // 束の本体は、設定の同期が束の行を見て自分で取りに行く。ここでは降ろさず、filesSeq は通り過ぎる。
    await putRemote('dev-a', `projects/-w-alpha/${UUID}.jsonl`, 'mine\n');
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(fs.existsSync(path.join(home, 'remote'))).toBe(false);
    expect(state.getNumber('filesSeq', -1)).toBe(2);
    expect(p.skippedEntries()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('SHA-256 が合わなければ捨てて、次の pull でやり直す', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n', 'transcript', { sha256: 'f'.repeat(64) });
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(errors[0]!.message).toContain('SHA-256');
    const target = remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(state.getNumber('filesSeq', -1)).toBe(0);
  });

  it('鍵名と封じたメタが食い違う項目（Worker が付け替えた行）は開かずに飛ばし、先へ進む', async () => {
    // 2 件のメタを入れ替える。どちらも封じた宛先（鍵名）と合わなくなる。
    const other = '22222222-2222-4222-8222-222222222222';
    const a = await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'one\n');
    const b = await putRemote('dev-b', `projects/-w-alpha/${other}.jsonl`, 'two\n');
    const fa = cloud.files.get(a.key)!.entry;
    const fb = cloud.files.get(b.key)!.entry;
    [fa.sealedMeta, fb.sealedMeta] = [fb.sealedMeta, fa.sealedMeta];
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(fs.existsSync(path.join(home, 'remote'))).toBe(false);
    expect(state.getNumber('filesSeq', -1)).toBe(2);
    // 鍵があっても開けない行は、巻き戻しても開けないので控えない。
    expect(state.get('filesSkippedFrom')).toBeNull();
  });

  it('過去の世代で封じた本文を、世代 1 と 2 を持つ PC が降ろせる', async () => {
    const ring = await Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 }));
    cloud = new FakeCloudClient({ deviceId: 'dev-a', keyring: ring });
    // dev-b は世代 1 だけを持ったまま上げる。
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'old epoch\n');
    expect([...cloud.files.values()].map((f) => f.entry.epoch)).toEqual([1]);
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`), 'utf8')).toBe('old epoch\n');
  });

  it('鍵の届いていない世代の本文は控えて先へ進み、鍵が届いて巻き戻せば降ろす', async () => {
    const ringB = await Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 }));
    const devB2 = cloud.asDevice('dev-b', { keyring: ringB });
    // 世代 2 の本文（dev-a はまだ鍵を持たない）と、その後ろに世代 1 の本文。
    await devB2.putText({ path: `projects/-w-alpha/${UUID}.jsonl` }, 'new epoch\n');
    const other = '55555555-5555-4555-8555-555555555555';
    await putRemote('dev-b', `projects/-w-alpha/${other}.jsonl`, 'old epoch\n');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    // 区切りは止めずに進め、控えた所を覚える。
    expect(state.getNumber('filesSeq', -1)).toBe(2);
    expect(state.getNumber('filesSkippedFrom', -1)).toBe(1);
    // 後ろでまた控えても、小さい方を残す。
    await devB2.putText({ path: `projects/-w-alpha/${other}/subagents/agent-x1.jsonl` }, 'sub\n');
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(3);
    expect(state.getNumber('filesSkippedFrom', -1)).toBe(1);
    expect(errors).toEqual([]);
    // 名簿の読み直しで世代 2 の鍵が届いたら、巻き戻して読み直す。
    await (await cloud.keyring).addEpochs({ epochs: { '2': testKey(4) } });
    await p.rewindSkipped();
    expect(state.getNumber('filesSeq', -1)).toBe(0);
    expect(state.get('filesSkippedFrom')).toBeNull();
    expect(await p.pullNow()).toEqual({ downloaded: 2 });
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`), 'utf8')).toBe('new epoch\n');
    expect(state.get('filesSkippedFrom')).toBeNull();
    // 控えが無ければ巻き戻さない。
    await p.rewindSkipped();
    expect(state.getNumber('filesSeq', -1)).toBe(3);
  });

  it('知らない世代で封じた本文は、keybox が届いた後に降りる（名簿の読み直しから巻き戻す）', async () => {
    const ringB = await Keyring.fromConfig(testCloudConfig({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 }));
    await cloud.asDevice('dev-b', { keyring: ringB }).putText({ path: `projects/-w-alpha/${UUID}.jsonl` }, 'new epoch\n');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(state.getNumber('filesSkippedFrom', -1)).toBe(1);
    const cfgA = { current: testCloudConfig({ keyPair: await generateKeyPair() }), read: () => cfgA.current, write: (patch: Partial<CloudConfig>) => { cfgA.current = { ...cfgA.current, ...patch }; } };
    const store = new RosterStore(cloud.wire, await cloud.keyring, cfgA, 'dev-a');
    const rewinds: Promise<boolean>[] = [];
    const onRoster = rosterRefresh(store, () => { rewinds.push(p.rewindSkipped()); });
    cloud.wire.putKeybox('dev-a', 2, toBase64Url(await sealKeybox(cfgA.current.keyPair.pub, { epoch: 2, recipient: 'dev-a' }, encodeEpochList({ epochs: { '1': testKey(3), '2': testKey(4) } }))));
    await onRoster();
    expect(await Promise.all(rewinds)).toEqual([true]);
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`), 'utf8')).toBe('new epoch\n');
    // 鍵が増えなければ巻き戻さない。
    await onRoster();
    expect(rewinds.length).toBe(1);
  });

  it('巻き戻しは関数だけでも呼べ、手前の区切りを先へ進めない', () => {
    state.set('filesSeq', 2);
    state.set('filesSkippedFrom', 7);
    expect(rewindSkippedFiles(state)).toBe(true);
    // 控えより手前にいるなら、その位置のまま（先へは進めない）。
    expect(state.getNumber('filesSeq', -1)).toBe(2);
    expect(state.get('filesSkippedFrom')).toBeNull();
    expect(rewindSkippedFiles(state)).toBe(false);
  });

  it('上げた本文を別の PC が降ろせる（uploader と同じ鍵名の求め方）', async () => {
    const ring = await cloud.asDevice('dev-b').keyring;
    const key = await transcriptBlobKey(ring.current().index, 'dev-b', 'dev-b', UUID, null);
    await cloud.asDevice('dev-b').putText({ path: `projects/-w-alpha/${UUID}.jsonl`, key }, 'hello\n');
    expect([...cloud.files.keys()]).toEqual([key]);
    expect(await make().pullNow()).toEqual({ downloaded: 1 });
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`), 'utf8')).toBe('hello\n');
  });

  it('壊れた本文は書き掛けを残さず、次の pull でやり直す', async () => {
    const { key: k } = await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n');
    const f = cloud.files.get(k)!;
    f.body = f.body.subarray(0, f.body.length - 8);
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(errors).toHaveLength(1);
    const target = remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(state.getNumber('filesSeq', -1)).toBe(0);
  });

  it('サブエージェントの写しも降ろす', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}/subagents/agent-ab12.jsonl`, 'sub\n');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}/subagents/agent-ab12.jsonl`), 'utf8')).toBe('sub\n');
  });

  it('latestRemoteMain は更新時刻が最新の写しを返す', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'b-body\n');
    await putRemote('dev-c', `projects/-w-alpha/${UUID}.jsonl`, 'c-body-longer\n');
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
    // uploader は path に path.relative(claudeDir, ファイル) を、key に shared の transcriptBlobKey（セッションの UUID とサブエージェントの ID）を使う。
    // 降ろす側（SealedCloudClient）は中身のパスから鍵名を求め直して比べる。どちらか片方の形が変わったら、ここが落ちて気付けるようにしておく。
    const claudeDir = path.join(path.sep, 'c');
    const cases: { agentId: string | null; file: string }[] = [
      { agentId: null, file: path.join(claudeDir, 'projects', '-w-alpha', `${UUID}.jsonl`) },
      { agentId: 'abc123', file: path.join(claudeDir, 'projects', '-w-alpha', UUID, 'subagents', 'agent-abc123.jsonl') },
    ];
    for (const c of cases) {
      const rel = path.relative(claudeDir, c.file).split(path.sep).join('/');
      const ring = await cloud.asDevice('dev-b').keyring;
      const key = await transcriptBlobKey(ring.current().index, 'dev-b', 'dev-b', UUID, c.agentId);
      await cloud.asDevice('dev-b').putText({ path: rel, key }, `body-${c.agentId}\n`);
    }
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 2 });
    expect(errors).toEqual([]);
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`), 'utf8')).toBe('body-null\n');
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}/subagents/agent-abc123.jsonl`), 'utf8')).toBe('body-abc123\n');
  });

  it('同じ項目で続けて失敗したら 3 回で諦めて先に進む', async () => {
    const { key: badKey } = await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n', 'transcript', { sha256: 'f'.repeat(64) });
    const other = '33333333-3333-4333-8333-333333333333';
    await putRemote('dev-b', `projects/-w-alpha/${other}.jsonl`, 'good\n');
    const p = make();
    // 同じ回の後ろの項目は降ろす。止まるのは filesSeq を進めることだけである。
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(fs.existsSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${other}.jsonl`))).toBe(true);
    expect(state.getNumber('filesSeq', -1)).toBe(0);
    // 2 回目も手前で止まるので、降ろし終えた本文まで毎回読み直しに掛かる。
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(0);
    // 3 回目で諦め、ようやく filesSeq が進む。
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(2);
    // 鳴らすのは 1 回目と諦めたときだけで、間は黙る。
    expect(errors.map((e) => e.key)).toEqual([badKey, badKey]);
    expect(errors[0]!.message).toContain('SHA-256');
    expect(errors[1]!.message).toContain('飛ばします');
    expect(p.skippedEntries()).toEqual([{ key: badKey, attempts: 3, message: expect.stringContaining('SHA-256') }]);
    // 諦めた後はもう試さないし、鳴らさない。
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(errors).toHaveLength(2);
  });

  it('上げ直された本文は諦めた後でももう一度試す', async () => {
    const rel = `projects/-w-alpha/${UUID}.jsonl`;
    for (let i = 0; i < 3; i++) await putRemote('dev-b', rel, 'body\n', 'transcript', { sha256: 'f'.repeat(64) });
    const p = make();
    // 同じ指紋のまま置き直されても、数えるのは指紋ごとなので 3 回で諦める。
    for (let i = 0; i < 3; i++) await p.pullNow();
    expect(p.skippedEntries()).toHaveLength(1);
    // 中身が変わった（指紋が変わった）ら、数え直して取り直す。
    await putRemote('dev-b', rel, 'fixed\n');
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(p.skippedEntries()).toEqual([]);
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', rel), 'utf8')).toBe('fixed\n');
  });

  it('互換の版で断られた回は、項目を諦めに数えず、filesSeq も進めない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    const realGet = cloud.getFile.bind(cloud);
    cloud.getFile = async () => { throw new CompatError('device', COMPAT_VERSION, COMPAT_VERSION + 1); };
    for (let i = 0; i < 3; i++) await expect(p.pullNow()).rejects.toBeInstanceOf(CompatError);
    expect(p.skippedEntries()).toEqual([]);
    expect(errors).toEqual([]);
    expect(state.getNumber('filesSeq', 0)).toBe(0);
    // 版が合えば、同じ項目が降りてくる。
    cloud.getFile = realGet;
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
  });

  it('上限で断られた回は、項目を諦めに数えず、filesSeq も進めない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    const realGet = cloud.getFile.bind(cloud);
    cloud.getFile = async () => { throw new LimitError('d1-read', 429); };
    for (let i = 0; i < 3; i++) await expect(p.pullNow()).rejects.toBeInstanceOf(LimitError);
    expect(p.skippedEntries()).toEqual([]);
    expect(errors).toEqual([]);
    expect(state.getNumber('filesSeq', 0)).toBe(0);
    // 上限が戻れば、同じ項目が降りてくる。
    cloud.getFile = realGet;
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
  });

  it('諦めた項目の取り直しが上限で断られたら、回数と理由を書き換えず、残りの取り直しも打ち切る', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n');
    await putRemote('dev-b', `projects/-w-alpha/${other}.jsonl`, 'body2\n');
    fs.writeFileSync(path.join(home, 'remote'), 'ふさぐ');
    const p = make();
    for (let i = 0; i < 3; i++) await p.pullNow();
    const gaveUp = p.skippedEntries();
    expect(gaveUp).toHaveLength(2);
    fs.rmSync(path.join(home, 'remote'));
    // 起こし直した直後は諦めた項目を取り直す。その取り直しが上限で断られる。
    let gets = 0;
    cloud.getFile = async () => { gets++; throw new LimitError('d1-read', 429); };
    const p2 = make();
    await expect(p2.pullNow()).rejects.toBeInstanceOf(LimitError);
    // 上限はその項目のせいではないので、諦めの回数も理由も変えない。
    expect(p2.skippedEntries()).toEqual(gaveUp);
    // 1 件目で断られたら、その回の残りの取り直しには行かない。
    expect(gets).toBe(1);
  });

  it('置き場は 0700、降ろした本文は 0600 で置く', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    await p.pullNow();
    const target = remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`);
    expectMode(target, 0o600);
    const dirs = [path.join(home, 'remote'), path.join(home, 'remote', 'dev-b'), path.join(home, 'remote', 'dev-b', 'projects'), path.dirname(target)];
    for (const d of dirs) expectMode(d, 0o700);
  });

  it('諦めた本文は、原因が直ってサーバを起こし直せば降りてくる', async () => {
    // レビューの scratchpad/giveup2.ts の筋。置き場を普通のファイルで塞いで一時的な事故を作る。
    const { key } = await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, 'body\n');
    fs.writeFileSync(path.join(home, 'remote'), 'ふさぐ');
    const p = make();
    for (let i = 0; i < 3; i++) await p.pullNow();
    expect(p.skippedEntries()).toHaveLength(1);
    expect(state.getNumber('filesSeq', -1)).toBe(1);
    // 事故を直して、サーバを起こし直す（新しい RemotePuller を作る）。
    fs.rmSync(path.join(home, 'remote'));
    const p2 = make();
    // 諦めた記録は起こし直しても残っている。控えの鍵は R2 の鍵名である。
    expect(p2.skippedEntries()).toEqual([{ key, attempts: 3, message: expect.any(String) }]);
    // filesSeq は進んだままなので一覧には載らないが、諦めた記録から取り直す。
    expect(await p2.pullNow()).toEqual({ downloaded: 1 });
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
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(p.skippedEntries()).toHaveLength(1);
    // 間隔が空いたら取り直す。
    clock += RETRY_SKIPPED_AFTER_MS;
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(p.skippedEntries()).toEqual([]);
  });

  it('暗号化されていない本文は受け取らない', async () => {
    // 決定 5 は「本文は暗号化して R2 に置く」である。受け取る側は、本文が世代の鍵で開けることを確かめる。
    const body = '{"a":1}\n';
    const { key } = await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, body);
    // Worker の側で、本体を gzip だけの平文に差し替える。
    cloud.files.get(key)!.body = gzipSync(Buffer.from(body));
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(errors[0]!.message).toContain('暗号化');
    expect(fs.existsSync(remoteTranscriptPath(home, 'dev-b', `projects/-w-alpha/${UUID}.jsonl`))).toBe(false);
  });

  it('rename の前に fsync してから本物にする', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
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
      getFile: (k, e) => cloud.getFile(k, e),
      usage: () => cloud.usage(),
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
    await putRemote('dev-b', `projects/-w-alpha/${other}.jsonl`, 'body2\n');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 2 });
    expect(state.getNumber('filesSeq', -1)).toBe(2);
    state.set('filesSeq', 0);
    // 手元に実体があって指紋も合うので降ろし直しはしないが、filesSeq は先頭まで戻る。
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(2);
  });
});

/**
 * 止め方の作法。
 * SyncEngine と TranscriptUploader と同じく、
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
    expect(await first).toEqual({ downloaded: 1 });
    // 鎖に並んだ 2 件目は先頭の検査で譲る。
    expect(await second).toEqual({ downloaded: 0 });
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
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
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

describe('削除したセッションの写し', () => {
  const rel = `projects/-w-alpha/${UUID}.jsonl`;
  const trash = (at: number | null) => {
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', ?, '/w/alpha', 'dev-b', 1, 'dev-b') on conflict(id) do nothing").run(UUID);
    db.prepare("insert into session_states (session_id, trashed_at, updated_at, origin_device) values ('s1', ?, 1, 'dev-b') on conflict(session_id) do update set trashed_at = excluded.trashed_at").run(at);
  };
  it('削除の印のあるセッションの写しは降ろさない（区切りは先へ進める）', async () => {
    trash(1);
    await putRemote('dev-b', rel, '{"a":1}\n');
    expect(await make().pullNow()).toEqual({ downloaded: 0 });
    expect(fs.existsSync(remoteTranscriptPath(home, 'dev-b', rel))).toBe(false);
    expect(state.getNumber('filesSeq', 0)).toBe(1);
  });
  it('ほかの PC で戻されたら、台帳に残る写しを降ろし直す', async () => {
    await putRemote('dev-b', rel, '{"a":1}\n');
    const p = make();
    await p.pullNow();
    const target = remoteTranscriptPath(home, 'dev-b', rel);
    // 消したときに写しを消した形にする。台帳（file_sync）の行は残っている。
    fs.rmSync(target);
    expect(await p.refetchSession(UUID)).toEqual({ downloaded: 1 });
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}\n');
  });
  it('台帳に行が無くても（印の後に一覧を見た PC）、写しの一覧を引き直して降ろす', async () => {
    trash(1);
    await putRemote('dev-b', rel, '{"a":1}\n');
    const p = make();
    await p.pullNow();
    expect(db.prepare('select count(*) n from file_sync').get()).toEqual({ n: 0 });
    trash(null);
    expect(await p.refetchSession(UUID)).toEqual({ downloaded: 1 });
    expect(fs.readFileSync(remoteTranscriptPath(home, 'dev-b', rel), 'utf8')).toBe('{"a":1}\n');
    expect(errors).toEqual([]);
  });
  it('台帳の指紋が古くても、一覧の最新の項目を降ろす（指紋の食い違いを繰り返さない）', async () => {
    await putRemote('dev-b', rel, '{"a":1}\n');
    const p = make();
    await p.pullNow();
    const target = remoteTranscriptPath(home, 'dev-b', rel);
    fs.rmSync(target);
    // 消えている間に持ち主が続きを上げた。印があるので通常の pull では降ろさず、台帳は古い指紋のまま。
    trash(1);
    await putRemote('dev-b', rel, '{"a":1}\n{"b":2}\n');
    await p.pullNow();
    trash(null);
    expect(await p.refetchSession(UUID)).toEqual({ downloaded: 1 });
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
    expect(errors).toEqual([]);
  });
  it('ほかのセッションと自分の写しは降ろさない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/22222222-2222-4222-8222-222222222222.jsonl`, '{"x":1}\n');
    expect(await make().refetchSession(UUID)).toEqual({ downloaded: 0 });
  });
});

/**
 * opencode の本文の写しは、path が projects/ で始まらない（opencode/<セッション>.json）。
 * それを知らない版の PC が同じ一覧を pull しても、その行だけが降りてこず、Claude の本文は降り続けなければならない。
 * 守りは 2 段ある。
 * 1 段目は SealedCloudClient で、中身のパスから鍵名を求め直せない行を開かずに捨てる（puller まで届かない）。
 * 2 段目は puller で、届いてしまっても行ごとの失敗として数え、3 回で飛ばして先へ進む。
 */
describe('projects/ で始まらない写し（opencode の本文）を知らない puller', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const LATER = '33333333-3333-4333-8333-333333333333';
  const OPENCODE_PATH = 'opencode/ses_0123456789abcdefABCDEF.json';

  /** dev-b として、opencode の本文の写しを置く。鍵名は Claude の求め方と別の入力の HMAC で、パスからは求め直せない。 */
  const seedOpencode = async (): Promise<{ seq: number; key: string }> => {
    const devB = cloud.asDevice('dev-b');
    const cur = (await devB.keyring).current();
    const key = await transcriptBlobKey(cur.index, 'dev-b', 'dev-b', 'opencode:ses_0123456789abcdefABCDEF', null);
    const text = '{"info":{"id":"ses_0123456789abcdefABCDEF"},"messages":[]}\n';
    const sealedMeta = await sealFileMeta(cur.row, { key, deviceId: 'dev-b', kind: 'transcript', epoch: cur.epoch }, { path: OPENCODE_PATH, sha256: sha256Hex(text), mtime: 1_700_000_000_000, origin: 'dev-b' });
    const body = await devB.sealBody(text);
    const { seq } = devB.wire.seedUnchecked({ key, kind: 'transcript', size: Buffer.byteLength(text), epoch: cur.epoch, sealedMeta: toBase64Url(sealedMeta) }, body);
    return { seq, key };
  };

  /** remote/ の下に置かれたものを、相対パスで全部返す。 */
  const remoteTree = (): string[] => {
    const root = path.join(home, 'remote');
    if (!fs.existsSync(root)) return [];
    return (fs.readdirSync(root, { recursive: true }) as string[]).map((p) => p.split(path.sep).join('/')).sort();
  };

  it('一覧の間に挟まっても、その行だけを捨てて Claude の本文を降ろし続け、区切りを先へ進める', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const oc = await seedOpencode();
    await putRemote('dev-b', `projects/-w-alpha/${OTHER}.jsonl`, '{"b":2}\n');
    expect(oc.seq).toBe(2);
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 2 });
    expect(state.getNumber('filesSeq', -1)).toBe(3);
    expect(state.get('filesSkippedFrom')).toBeNull();
    expect(p.skippedEntries()).toEqual([]);
    expect(errors).toEqual([]);
    // 後から上がった Claude の本文も、止まらずに降りてくる。
    await putRemote('dev-b', `projects/-w-alpha/${LATER}.jsonl`, '{"c":3}\n');
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(state.getNumber('filesSeq', -1)).toBe(4);
    expect(remoteTree()).toEqual([
      'dev-b', 'dev-b/projects', 'dev-b/projects/-w-alpha',
      `dev-b/projects/-w-alpha/${UUID}.jsonl`, `dev-b/projects/-w-alpha/${OTHER}.jsonl`, `dev-b/projects/-w-alpha/${LATER}.jsonl`,
    ].sort());
    expect(errors).toEqual([]);
    // opencode の本文の本体は一度も取りに行かない。
    expect(cloud.calls.filter((c) => c.method === 'getFile' && c.args[0] === oc.key)).toEqual([]);
  });

  it('client を通り抜けて puller に届いても、行ごとの失敗として 3 回で飛ばし、ほかの本文は止めない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    // 2 番目の行を、client が開いた後の opencode の写しに差し替える（鍵名の検査を持たない client を真似る）。
    const own = await putRemote('dev-a', `projects/-w-alpha/${OTHER}.jsonl`, 'mine\n');
    await putRemote('dev-b', `projects/-w-alpha/${OTHER}.jsonl`, '{"b":2}\n');
    const swap = (e: FileEntry): FileEntry => (e.key === own.key ? { ...e, deviceId: 'dev-b', origin: 'dev-b', path: OPENCODE_PATH } : e);
    const client = new Proxy(cloud, {
      get(t, prop) {
        if (prop === 'listFiles') {
          return async (since: number, limit: number) => {
            const page = await t.listFiles(since, limit);
            return { ...page, files: page.files.map(swap) };
          };
        }
        const v = Reflect.get(t, prop, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const p = make({ client });
    // 1 回目：後ろの Claude の本文はその回のうちに降りる。区切りは失敗した行の手前で止まる。
    expect(await p.pullNow()).toEqual({ downloaded: 2 });
    expect(state.getNumber('filesSeq', -1)).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(OPENCODE_PATH);
    // 2 回目：同じ所から読み直すが、降ろし済みの本文は降ろし直さない。鳴らさない。
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(1);
    expect(errors).toHaveLength(1);
    // 3 回目：諦めて飛ばし、区切りを先へ進める。
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(state.getNumber('filesSeq', -1)).toBe(3);
    expect(errors).toHaveLength(2);
    expect(p.skippedEntries()).toEqual([{ key: own.key, attempts: 3, message: expect.stringContaining(OPENCODE_PATH) }]);
    // 以後の Claude の本文は止まらずに降りてくる。
    await putRemote('dev-b', `projects/-w-alpha/${LATER}.jsonl`, '{"c":3}\n');
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    expect(state.getNumber('filesSeq', -1)).toBe(4);
    // projects/ の外へは何も書かない。
    expect(remoteTree().filter((r) => !r.startsWith('dev-b/projects') && r !== 'dev-b')).toEqual([]);
  });
});
