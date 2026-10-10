import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildManifest, platformOf, readEntries } from '../scripts/updater-manifest.ts';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// release.yml の updater-manifest ジョブが、各 OS の更新物の .sig から updater の目録（latest.json）を作る。
// 形は tauri-plugin-updater の静的な目録（version、notes、pub_date、platforms の url と signature）である。
describe('updater の目録', () => {
  it('Release の資産の名前から、updater の platform を決める', () => {
    expect(platformOf('Hangar-v1.5.0-macos-arm64.app.tar.gz')).toBe('darwin-aarch64');
    expect(platformOf('Hangar-v1.5.0-macos-x64.app.tar.gz')).toBe('darwin-x86_64');
    expect(platformOf('Hangar-v1.5.0-windows-x64-setup.exe')).toBe('windows-x86_64');
    // 手で入れる zip と checksum は更新物ではない。
    expect(platformOf('Hangar-v1.5.0-macos-arm64.zip')).toBeNull();
    expect(platformOf('Hangar-v1.5.0-windows-x64-setup.exe.sha256')).toBeNull();
  });

  it('タグの版、各 OS の取得先と署名を並べる', () => {
    const m = buildManifest({
      tag: 'v1.5.0', repo: 'owner/repo', pubDate: '2026-10-10T00:00:00.000Z', notes: '',
      entries: [{ asset: 'Hangar-v1.5.0-macos-arm64.app.tar.gz', signature: 'SIG-MAC' }, { asset: 'Hangar-v1.5.0-windows-x64-setup.exe', signature: 'SIG-WIN' }],
    });
    expect(m).toEqual({
      version: '1.5.0', notes: '', pub_date: '2026-10-10T00:00:00.000Z',
      platforms: {
        'darwin-aarch64': { url: 'https://github.com/owner/repo/releases/download/v1.5.0/Hangar-v1.5.0-macos-arm64.app.tar.gz', signature: 'SIG-MAC' },
        'windows-x86_64': { url: 'https://github.com/owner/repo/releases/download/v1.5.0/Hangar-v1.5.0-windows-x64-setup.exe', signature: 'SIG-WIN' },
      },
    });
  });

  it('更新物が 1 つも無いか、platform の分からない署名があれば作らない', () => {
    const base = { tag: 'v1.5.0', repo: 'owner/repo', pubDate: 'x', notes: '' };
    expect(() => buildManifest({ ...base, entries: [] })).toThrow();
    expect(() => buildManifest({ ...base, entries: [{ asset: 'Hangar-v1.5.0-macos-arm64.zip', signature: 's' }] })).toThrow();
    expect(() => buildManifest({ ...base, tag: '1.5.0', entries: [{ asset: 'Hangar-v1.5.0-macos-arm64.app.tar.gz', signature: 's' }] })).toThrow();
  });

  it('置き場の .sig を読み、名前と中身の組にする', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-'));
    fs.writeFileSync(path.join(dir, 'Hangar-v1.5.0-macos-arm64.app.tar.gz'), 'bin');
    fs.writeFileSync(path.join(dir, 'Hangar-v1.5.0-macos-arm64.app.tar.gz.sig'), 'SIG-MAC\n');
    fs.writeFileSync(path.join(dir, 'Hangar-v1.5.0-windows-x64-setup.exe.sig'), 'SIG-WIN');
    expect(readEntries(dir)).toEqual([
      { asset: 'Hangar-v1.5.0-macos-arm64.app.tar.gz', signature: 'SIG-MAC' },
      { asset: 'Hangar-v1.5.0-windows-x64-setup.exe', signature: 'SIG-WIN' },
    ]);
  });

  // CI の updater-manifest ジョブは npm ci をしないので、Node がそのまま型を剥がして動かせる形でなければならない。
  it('Node だけで動き、目録を標準出力に書く', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-'));
    fs.writeFileSync(path.join(dir, 'Hangar-v1.5.0-macos-arm64.app.tar.gz.sig'), 'SIG-MAC');
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(app, 'scripts/updater-manifest.ts'), dir, 'v1.5.0', 'owner/repo'], { encoding: 'utf8' });
    const m = JSON.parse(out);
    expect(m.version).toBe('1.5.0');
    expect(m.platforms['darwin-aarch64'].signature).toBe('SIG-MAC');
  });
});
