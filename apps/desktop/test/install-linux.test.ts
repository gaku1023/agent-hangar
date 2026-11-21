import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageLinux } from '../scripts/package-linux.ts';

const installSh = path.resolve(import.meta.dirname, '../../../install.sh');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-install-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 偽の node と束から、ふだんと同じ形の tar を作る。 */
function makeTarball(tag: string, arch: 'x64' | 'arm64' = 'x64'): string {
  const bundle = path.join(tmp, 'bundle');
  fs.mkdirSync(path.join(bundle, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'cli.mjs'), '//\n');
  fs.writeFileSync(path.join(bundle, 'server.mjs'), '//\n');
  fs.writeFileSync(path.join(bundle, 'ui', 'index.html'), '<html></html>');
  const node = path.join(tmp, 'node');
  fs.writeFileSync(node, '#!/bin/sh\nfor a in "$@"; do echo "arg=$a"; done\n', { mode: 0o755 });
  return packageLinux({ bundleDir: bundle, nodeBinary: node, tag, arch, outDir: path.join(tmp, 'dl') }).tarball;
}

function run(env: Record<string, string>): { code: number; out: string } {
  const r = spawnSync('sh', [installSh], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: tmp, HANGAR_NO_SERVICE: '1', HANGAR_INSTALL_OS: 'Linux', HANGAR_INSTALL_ARCH: 'x86_64', HANGAR_INSTALL_UID: '1000', ...env },
  });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

describe('install.sh', () => {
  it('手元の tar（と同じ場所の .sha256）を、版ごとのディレクトリに展開し、current と ~/.local/bin/hangar を張る', () => {
    const tarball = makeTarball('v1.2.3');
    const r = run({ HANGAR_TARBALL: tarball });
    expect(r.code, r.out).toBe(0);
    const prefix = path.join(tmp, '.local/share/agent-hangar');
    expect(fs.existsSync(path.join(prefix, 'versions/v1.2.3/bin/hangar'))).toBe(true);
    expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe('versions/v1.2.3');
    const bin = path.join(tmp, '.local/bin/hangar');
    expect(fs.lstatSync(bin).isSymbolicLink()).toBe(true);
    // 張ったリンク経由で、同梱の node が cli.mjs を起こす。
    const out = execFileSync(bin, ['status'], { encoding: 'utf8' });
    expect(out).toContain('arg=status');
    expect(out).toMatch(/arg=.*\/current\/app\/cli\.mjs/);
  });

  it('入れ直すと current が新しい版に移り、古い版は残る', () => {
    expect(run({ HANGAR_TARBALL: makeTarball('v1.0.0') }).code).toBe(0);
    fs.rmSync(path.join(tmp, 'bundle'), { recursive: true });
    expect(run({ HANGAR_TARBALL: makeTarball('v1.1.0') }).code).toBe(0);
    const prefix = path.join(tmp, '.local/share/agent-hangar');
    expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe('versions/v1.1.0');
    expect(fs.existsSync(path.join(prefix, 'versions/v1.0.0'))).toBe(true);
  });

  it('checksum が合わなければ、何も置かずに断る', () => {
    const tarball = makeTarball('v1.2.3');
    fs.writeFileSync(`${tarball}.sha256`, `${'0'.repeat(64)}  ${path.basename(tarball)}\n`);
    const r = run({ HANGAR_TARBALL: tarball });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('checksum');
    expect(fs.existsSync(path.join(tmp, '.local/share/agent-hangar'))).toBe(false);
  });

  it('Linux 以外では断る', () => {
    const r = run({ HANGAR_INSTALL_OS: 'Darwin', HANGAR_TARBALL: makeTarball('v1.2.3') });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Linux');
  });

  it('root では断り、非 root 利用者の作り方を案内する', () => {
    const r = run({ HANGAR_INSTALL_UID: '0', HANGAR_TARBALL: makeTarball('v1.2.3') });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('useradd');
  });

  it('対応しない CPU（armv7 など）は断る', () => {
    const r = run({ HANGAR_INSTALL_ARCH: 'armv7l', HANGAR_TARBALL: makeTarball('v1.2.3') });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('armv7l');
  });

  it('arm64（aarch64）は arm64 用の tar を選ぶ', () => {
    // ダウンロードの URL を組むだけ確かめる。実際には取りに行かず、HANGAR_DRY_RUN で URL を出して終わる。
    const r = run({ HANGAR_INSTALL_ARCH: 'aarch64', HANGAR_VERSION: 'v9.9.9', HANGAR_DRY_RUN: '1' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Hangar-v9.9.9-linux-arm64.tar.gz');
  });

  it('PATH に ~/.local/bin が無ければ、足し方を案内する', () => {
    const r = run({ HANGAR_TARBALL: makeTarball('v1.2.3') });
    expect(r.out).toContain('PATH');
  });
});
