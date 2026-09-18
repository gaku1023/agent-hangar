import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupsRoot, cloudConfigPath, loadCloudConfig, remoteRoot, saveCloudConfig } from './cloud.ts';

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
  });
  it('壊れたファイルは null', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    fs.writeFileSync(cloudConfigPath(home), '{');
    expect(loadCloudConfig(home)).toBeNull();
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify({ url: 'x' }));
    expect(loadCloudConfig(home)).toBeNull();
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
  });
  it('欠けている項目は null と 0 で埋める', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloud-'));
    fs.writeFileSync(cloudConfigPath(home), JSON.stringify({ url: 'u', joinSecret: 's', deviceToken: 't' }));
    expect(loadCloudConfig(home)).toEqual({ url: 'u', joinSecret: 's', deviceToken: 't', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 0 });
  });
});
