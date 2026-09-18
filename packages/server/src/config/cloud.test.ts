import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupsRoot, cloudConfigPath, loadCloudConfig, readCloudConfig, remoteRoot, saveCloudConfig } from './cloud.ts';

describe('cloud.json', () => {
  it('無ければ null、保存したら 0600 で読み戻せる', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    expect(loadCloudConfig(home)).toBeNull();
    const c = { url: 'https://h.workers.dev', joinSecret: 's', deviceToken: 't', workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files', joinedAt: 1 };
    saveCloudConfig(home, c);
    expect(loadCloudConfig(home)).toEqual(c);
    expect(fs.statSync(cloudConfigPath(home)).mode & 0o777).toBe(0o600);
    expect(remoteRoot(home)).toBe(path.join(home, 'remote'));
    expect(backupsRoot(home)).toBe(path.join(home, 'backups'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('壊れたファイルは null', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    fs.writeFileSync(cloudConfigPath(home), '{');
    expect(loadCloudConfig(home)).toBeNull();
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify({ url: 'x' }));
    expect(loadCloudConfig(home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('入れ物が無ければ 0700 で作り、上書きしても 0600 のままである', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    const home = path.join(tmp, 'nested');
    const c = { url: 'https://h.workers.dev', joinSecret: 's', deviceToken: 't', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 0 };
    saveCloudConfig(home, c);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    fs.chmodSync(cloudConfigPath(home), 0o644);
    saveCloudConfig(home, { ...c, deviceToken: 't2' });
    expect(fs.statSync(cloudConfigPath(home)).mode & 0o777).toBe(0o600);
    expect(loadCloudConfig(home)?.deviceToken).toBe('t2');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it('欠けている項目は null と 0 で埋める', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify({ url: 'u', joinSecret: 's', deviceToken: 't' }));
    expect(loadCloudConfig(home)).toEqual({ url: 'u', joinSecret: 's', deviceToken: 't', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 0 });
    fs.rmSync(home, { recursive: true, force: true });
  });
});

const SAMPLE = { url: 'https://h.workers.dev', joinSecret: 's', deviceToken: 't', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 0 };

describe('cloud.json の書き方', () => {
  it('置き換えであって、書きかけを晒さない', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    fs.writeFileSync(cloudConfigPath(home), 'old\n', { mode: 0o644 });
    fs.chmodSync(cloudConfigPath(home), 0o644);
    const before = fs.statSync(cloudConfigPath(home)).ino;
    saveCloudConfig(home, SAMPLE);
    const after = fs.statSync(cloudConfigPath(home));
    // 切り詰めて書き直すのではなく、0600 で作った別のファイルを rename で被せる。
    // 同じ inode に書いていたら、0644 のまま秘密が置かれる一瞬ができる。
    expect(after.ino).not.toBe(before);
    expect(after.mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home)).toEqual(['cloud.json']);
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('書けなかったら元のファイルを壊さず、書きかけも残さない', () => {
    if (process.getuid?.() === 0) return;   // root は権限を無視するので試さない
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    saveCloudConfig(home, SAMPLE);
    fs.chmodSync(home, 0o500);
    try {
      expect(() => saveCloudConfig(home, { ...SAMPLE, joinSecret: 's2' })).toThrow();
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
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
    expect(JSON.stringify(torn)).not.toContain('joinSecret');
    expect(JSON.stringify(torn)).not.toContain('h.workers.dev');
    // 読めるが必須の項目が欠けているものも壊れている扱いにする。
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify({ url: 'x' }));
    expect(readCloudConfig(home)).toEqual({ config: null, state: 'broken' });
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('loadCloudConfig は readCloudConfig の config と同じ', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    expect(loadCloudConfig(home)).toBe(readCloudConfig(home).config);
    saveCloudConfig(home, SAMPLE);
    expect(loadCloudConfig(home)).toEqual(readCloudConfig(home).config);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
