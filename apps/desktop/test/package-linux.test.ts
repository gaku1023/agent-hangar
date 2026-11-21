import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linuxTarballName, packageLinux } from '../scripts/package-linux.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pkglinux-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 束（bundle-server の出力）の代わり。中身は最小でよい。 */
function fakeBundle(): string {
  const dir = path.join(tmp, 'bundle');
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'cli.mjs'), '// cli\n');
  fs.writeFileSync(path.join(dir, 'server.mjs'), '// server\n');
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"arch":"x64"}\n');
  fs.writeFileSync(path.join(dir, 'bin', 'hangar'), '#!/bin/sh\necho mac-launcher\n');
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  return dir;
}

/** node の代わり。引数と HANGAR_UI_DIST を 1 行ずつ出す。 */
function fakeNode(): string {
  const file = path.join(tmp, 'node');
  fs.writeFileSync(file, '#!/bin/sh\necho "ui=$HANGAR_UI_DIST"\nfor a in "$@"; do echo "arg=$a"; done\n', { mode: 0o755 });
  return file;
}

function pack(arch: 'x64' | 'arm64' = 'x64'): { tarball: string; sha: string; out: string } {
  const out = path.join(tmp, 'out');
  const r = packageLinux({ bundleDir: fakeBundle(), nodeBinary: fakeNode(), tag: 'v1.2.3', arch, outDir: out });
  return { tarball: r.tarball, sha: r.sha256File, out };
}

function extract(tarball: string): string {
  const dest = path.join(tmp, 'x');
  fs.mkdirSync(dest);
  execFileSync('tar', ['-xzf', tarball, '-C', dest]);
  return path.join(dest, 'hangar');
}

describe('linuxTarballName', () => {
  it('Release の資産の名前は Hangar-<タグ>-linux-<arch>.tar.gz', () => {
    expect(linuxTarballName('v0.24.0', 'arm64')).toBe('Hangar-v0.24.0-linux-arm64.tar.gz');
  });
});

describe('packageLinux', () => {
  it('node、app、bin/hangar、VERSION を hangar/ の下に置く。.gitkeep は入れない', () => {
    const { tarball } = pack();
    const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const f of ['hangar/node/bin/node', 'hangar/app/cli.mjs', 'hangar/app/server.mjs', 'hangar/app/ui/index.html', 'hangar/bin/hangar', 'hangar/VERSION']) {
      expect(files, f).toContain(f);
    }
    expect(files.some((f) => f.endsWith('.gitkeep'))).toBe(false);
    // Mac 用の起動の台本（Node を探して回る）は持ち込まず、同梱の Node を使う台本に置き換える。
    expect(fs.readFileSync(path.join(extract(tarball), 'bin/hangar'), 'utf8')).not.toContain('mac-launcher');
  });

  it('sha256 の資産は「ハッシュ  名前」の 1 行で、sha256sum -c が通る形', () => {
    const { tarball, sha } = pack('arm64');
    expect(path.basename(tarball)).toBe('Hangar-v1.2.3-linux-arm64.tar.gz');
    const line = fs.readFileSync(sha, 'utf8');
    expect(line).toMatch(/^[0-9a-f]{64} {2}Hangar-v1\.2\.3-linux-arm64\.tar\.gz\n$/);
  });

  it('VERSION にタグを書く', () => {
    const { tarball } = pack();
    expect(fs.readFileSync(path.join(extract(tarball), 'VERSION'), 'utf8').trim()).toBe('v1.2.3');
  });

  it('bin/hangar は同梱の node で cli.mjs を起こし、HANGAR_UI_DIST を渡す', () => {
    const root = extract(pack().tarball);
    const out = execFileSync(path.join(root, 'bin/hangar'), ['status', '--port', '1'], { encoding: 'utf8' });
    expect(out).toContain(`ui=${root}/app/ui`);
    expect(out).toContain(`arg=${root}/app/cli.mjs`);
    expect(out).toContain('arg=status');
    expect(out).toContain('arg=--port');
  });

  it('bin/hangar はシンボリックリンク（~/.local/bin/hangar）経由でも、実体の置き場から node と app を探す', () => {
    const root = extract(pack().tarball);
    const link = path.join(tmp, 'link-hangar');
    fs.symlinkSync(path.join(root, 'bin/hangar'), link);
    const out = execFileSync(link, ['url'], { encoding: 'utf8' });
    expect(out).toContain(`arg=${root}/app/cli.mjs`);
  });

  it('同梱の node が無ければ、tar を作らずに断る', () => {
    expect(() => packageLinux({ bundleDir: fakeBundle(), nodeBinary: path.join(tmp, 'none'), tag: 'v1.2.3', arch: 'x64', outDir: path.join(tmp, 'o') })).toThrow(/node/);
  });
});
