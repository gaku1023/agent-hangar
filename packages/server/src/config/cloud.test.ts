import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backupsRoot,
  checkCloudConfigPerms,
  cloudConfigPath,
  icaclsReaders,
  loadCloudConfig,
  loadLegacyCloudConfig,
  readCloudConfig,
  readLegacyCloudConfig,
  remoteRoot,
  saveCloudConfig,
  saveLegacyCloudConfig,
} from './cloud.ts';
import { expectMode, isWindows, posixIt } from '../../test/platform.ts';
import { testCloudConfig, testKey } from '../../test/cloudConfig.ts';

const SAMPLE = testCloudConfig();
const LEGACY = { url: 'https://h.workers.dev', joinSecret: 's', deviceToken: 't', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 0 };

const tmpHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));

describe('cloud.json（版 2）', () => {
  it('無ければ null、保存したら 0600 で読み戻せる', () => {
    const home = tmpHome();
    expect(loadCloudConfig(home)).toBeNull();
    const c = testCloudConfig({ workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files', phoneKey: { epoch: 1, key: testKey(9) }, rosterVersion: 4 });
    saveCloudConfig(home, c);
    expect(loadCloudConfig(home)).toEqual(c);
    expect(JSON.parse(fs.readFileSync(cloudConfigPath(home), 'utf8')).v).toBe(2);
    expectMode(cloudConfigPath(home), 0o600);
    expect(remoteRoot(home)).toBe(path.join(home, 'remote'));
    expect(backupsRoot(home)).toBe(path.join(home, 'backups'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('版 2 は世代鍵を何世代でも往復する', () => {
    const home = tmpHome();
    const c = testCloudConfig({ epochs: { '1': testKey(3), '2': testKey(4), '3': testKey(5) }, currentEpoch: 3 });
    saveCloudConfig(home, c);
    expect(readCloudConfig(home)).toEqual({ config: c, state: 'ok' });
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('joinSecret を持つ cloud.json は legacy で、中身を 1 文字も持ち出さない', () => {
    const home = tmpHome();
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify(LEGACY));
    const r = readCloudConfig(home);
    expect(r).toEqual({ config: null, state: 'legacy' });
    expect(loadCloudConfig(home)).toBeNull();
    // 版の印が付いていても、joinSecret があれば古い形である。
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify({ ...LEGACY, v: 1 }));
    expect(readCloudConfig(home).state).toBe('legacy');
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('壊れたファイルと、欠けたり形の違う項目は broken', () => {
    const home = tmpHome();
    const broken = (v: unknown): string => {
      fs.writeFileSync(cloudConfigPath(home), typeof v === 'string' ? v : JSON.stringify(v));
      return readCloudConfig(home).state;
    };
    expect(broken('{')).toBe('broken');
    expect(broken({ url: 'x' })).toBe('broken');
    expect(broken({ ...SAMPLE, v: 3 })).toBe('broken');
    expect(broken({ ...SAMPLE, cloudId: undefined })).toBe('broken');
    expect(broken({ ...SAMPLE, deviceToken: 5 })).toBe('broken');
    expect(broken({ ...SAMPLE, keyPair: { pub: testKey(1) } })).toBe('broken');
    expect(broken({ ...SAMPLE, keyPair: { pub: 'short', priv: testKey(2) } })).toBe('broken');
    expect(broken({ ...SAMPLE, epochs: {} })).toBe('broken');
    expect(broken({ ...SAMPLE, epochs: { '0': testKey(3) }, currentEpoch: 0 })).toBe('broken');
    expect(broken({ ...SAMPLE, epochs: { '1': 'short' } })).toBe('broken');
    // 今の世代の鍵が手元に無いなら、書くことも読むこともできない。
    expect(broken({ ...SAMPLE, currentEpoch: 2 })).toBe('broken');
    expect(broken({ ...SAMPLE, phoneKey: { epoch: 1 } })).toBe('broken');
    expect(broken({ ...SAMPLE, phoneKey: { epoch: 0, key: testKey(9) } })).toBe('broken');
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('欠けている任意の項目は null と 0 で埋める', () => {
    const home = tmpHome();
    const { v, url, cloudId, deviceToken, keyPair, epochs, currentEpoch } = SAMPLE;
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify({ v, url, cloudId, deviceToken, keyPair, epochs, currentEpoch }));
    expect(loadCloudConfig(home)).toEqual(testCloudConfig({ joinedAt: 0 }));
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('入れ物が無ければ 0700 で作り、上書きしても 0600 のままである', () => {
    const tmp = tmpHome();
    const home = path.join(tmp, 'nested');
    saveCloudConfig(home, SAMPLE);
    expectMode(home, 0o700);
    fs.chmodSync(cloudConfigPath(home), 0o644);
    saveCloudConfig(home, { ...SAMPLE, deviceToken: 't2' });
    expectMode(cloudConfigPath(home), 0o600);
    expect(loadCloudConfig(home)?.deviceToken).toBe('t2');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('cloud.json（版 1）の読み書き', () => {
  // CLI の setup と参加は、Task 13 で版 2 に移るまで版 1 の形で読み書きする。
  it('版 1 を往復し、版 2 は読めないものとして扱う', () => {
    const home = tmpHome();
    saveLegacyCloudConfig(home, LEGACY);
    expectMode(cloudConfigPath(home), 0o600);
    expect(readLegacyCloudConfig(home)).toEqual({ config: LEGACY, state: 'ok' });
    expect(loadLegacyCloudConfig(home)).toEqual(LEGACY);
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify({ url: 'u', joinSecret: 's', deviceToken: 't' }));
    expect(loadLegacyCloudConfig(home)).toEqual({ url: 'u', joinSecret: 's', deviceToken: 't', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 0 });
    saveCloudConfig(home, SAMPLE);
    expect(readLegacyCloudConfig(home)).toEqual({ config: null, state: 'broken' });
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('cloud.json の書き方', () => {
  it('置き換えであって、書きかけを晒さない', () => {
    const home = tmpHome();
    fs.writeFileSync(cloudConfigPath(home), 'old\n', { mode: 0o644 });
    fs.chmodSync(cloudConfigPath(home), 0o644);
    const before = fs.statSync(cloudConfigPath(home)).ino;
    saveCloudConfig(home, SAMPLE);
    const after = fs.statSync(cloudConfigPath(home));
    // 切り詰めて書き直すのではなく、0600 で作った別のファイルを rename で被せる。
    // 同じ inode に書いていたら、0644 のまま秘密が置かれる一瞬ができる。
    expect(after.ino).not.toBe(before);
    if (!isWindows) expect(after.mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home)).toEqual(['cloud.json']);
    fs.rmSync(home, { recursive: true, force: true });
  });
  // 書けない・読めない状態を chmod で作る。Windows の chmod ではできない。
  posixIt('書けなかったら元のファイルを壊さず、書きかけも残さない', () => {
    if (process.getuid?.() === 0) return;   // root は権限を無視するので試さない
    const home = tmpHome();
    saveCloudConfig(home, SAMPLE);
    fs.chmodSync(home, 0o500);
    try {
      expect(() => saveCloudConfig(home, { ...SAMPLE, deviceToken: 't2' })).toThrow();
      expect(fs.readdirSync(home)).toEqual(['cloud.json']);
    } finally {
      fs.chmodSync(home, 0o700);
    }
    expect(loadCloudConfig(home)).toEqual(SAMPLE);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('readCloudConfig', () => {
  it('無いのと壊れているのを見分ける', () => {
    const home = tmpHome();
    expect(readCloudConfig(home)).toEqual({ config: null, state: 'absent' });
    saveCloudConfig(home, SAMPLE);
    expect(readCloudConfig(home)).toEqual({ config: SAMPLE, state: 'ok' });
    // 途中で切れたファイル。
    const text = fs.readFileSync(cloudConfigPath(home), 'utf8');
    fs.writeFileSync(cloudConfigPath(home), text.slice(0, 40));
    const torn = readCloudConfig(home);
    expect(torn.state).toBe('broken');
    expect(torn.config).toBeNull();
    // 壊れていることだけを伝え、読めた断片は 1 文字も持たない。
    expect(JSON.stringify(torn)).not.toContain('h.workers.dev');
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('loadCloudConfig は readCloudConfig の config と同じ', () => {
    const home = tmpHome();
    expect(loadCloudConfig(home)).toBe(readCloudConfig(home).config);
    saveCloudConfig(home, SAMPLE);
    expect(loadCloudConfig(home)).toEqual(readCloudConfig(home).config);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('一時ファイルの残骸', () => {
  it('次に書くときに古い残骸を掃き、いま書いている最中のものは残す', () => {
    const home = tmpHome();
    saveCloudConfig(home, SAMPLE);
    // SIGKILL で openSync と renameSync の間に落ちた残骸。中身は古い鍵の写しである。
    const stale = path.join(home, 'cloud.json.tmp-9999-deadbeefdead');
    fs.writeFileSync(stale, JSON.stringify({ ...SAMPLE, deviceToken: 'OLD-TOKEN' }), { mode: 0o600 });
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(stale, old, old);
    // 別のプロセスがいま書いている最中の一時ファイル。これは消さない。
    const fresh = path.join(home, 'cloud.json.tmp-1234-abcdefabcdef');
    fs.writeFileSync(fresh, 'writing', { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'keep.txt'), 'x');
    saveCloudConfig(home, { ...SAMPLE, deviceToken: 't2' });
    expect(fs.readdirSync(home).sort()).toEqual(['cloud.json', 'cloud.json.tmp-1234-abcdefabcdef', 'keep.txt']);
    expect(loadCloudConfig(home)?.deviceToken).toBe('t2');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('checkCloudConfigPerms', () => {
  it('cloud.json が無ければ漏れるものも無い', () => {
    const home = tmpHome();
    expect(checkCloudConfigPerms(home)).toEqual({ ok: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  // mode で他人の読み取りを作る。Windows の chmod ではできない。
  posixIt('0600 は ok、他人に読める mode は ng', () => {
    const home = tmpHome();
    saveCloudConfig(home, SAMPLE);
    expect(checkCloudConfigPerms(home)).toEqual({ ok: true });
    fs.chmodSync(cloudConfigPath(home), 0o644);
    const r = checkCloudConfigPerms(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('644');
    fs.chmodSync(cloudConfigPath(home), 0o640);
    expect(checkCloudConfigPerms(home).ok).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const FILE = 'C:\\Users\\pc-a\\.agent-hangar\\cloud.json';
  const pad = ' '.repeat(FILE.length + 1);
  const OWNER_ONLY = [
    `${FILE} NT AUTHORITY\\SYSTEM:(F)`,
    `${pad}BUILTIN\\Administrators:(F)`,
    `${pad}PC-A\\owner:(F)`,
    '',
    'Successfully processed 1 files; Failed processing 0 files',
    '',
  ].join('\r\n');
  const USERS_READ = [
    `${FILE} NT AUTHORITY\\SYSTEM:(I)(F)`,
    `${pad}BUILTIN\\Administrators:(I)(F)`,
    `${pad}PC-A\\owner:(I)(F)`,
    `${pad}BUILTIN\\Users:(I)(RX)`,
    '',
    'Successfully processed 1 files; Failed processing 0 files',
    '',
  ].join('\r\n');

  it('icacls の出力：本人と SYSTEM と Administrators だけなら ok、Users に R があれば ng', () => {
    const home = tmpHome();
    saveCloudConfig(home, SAMPLE);
    const run = (out: string) => checkCloudConfigPerms(home, 'win32', { icacls: () => out, user: 'owner' });
    expect(run(OWNER_ONLY)).toEqual({ ok: true });
    const ng = run(USERS_READ);
    expect(ng.ok).toBe(false);
    if (!ng.ok) expect(ng.detail).toContain('BUILTIN\\Users');
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('icacls の行の読み方', () => {
    // 拒否、継承だけの印（IO）、読み取りの無い権利は数えない。
    const lines = [
      `${FILE} PC-A\\owner:(F)`,
      `${pad}Everyone:(DENY)(R)`,
      `${pad}CREATOR OWNER:(OI)(CI)(IO)(F)`,
      `${pad}PC-A\\other:(W)`,
      `${pad}PC-A\\guest:(RD,WD)`,
      `${pad}NT AUTHORITY\\Authenticated Users:(I)(M)`,
    ].join('\n');
    expect(icaclsReaders(lines, FILE, 'OWNER')).toEqual(['PC-A\\guest', 'NT AUTHORITY\\Authenticated Users']);
    // 名前を引けない SID も見る。SYSTEM と Administrators の SID は許す。
    expect(icaclsReaders(`${FILE} *S-1-5-18:(F)\n${pad}*S-1-5-32-544:(F)\n${pad}S-1-5-21-1-2-3-1001:(R)`, FILE, 'owner')).toEqual(['S-1-5-21-1-2-3-1001']);
  });
  it('icacls を呼べなければ ng にする', () => {
    const home = tmpHome();
    saveCloudConfig(home, SAMPLE);
    const r = checkCloudConfigPerms(home, 'win32', { icacls: () => { throw new Error('ENOENT'); }, user: 'owner' });
    expect(r.ok).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
