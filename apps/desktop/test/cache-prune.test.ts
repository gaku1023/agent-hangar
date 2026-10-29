import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cacheFamily, staleCaches } from '../scripts/cache-prune.ts';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '../..');
const script = path.join(app, 'scripts/cache-prune.ts');

// Actions のキャッシュはリポジトリで 10GB までで、超えると古いものから消える。
// main には、package-lock.json や Cargo.lock が変わるたびに鍵の違う npm と Rust のキャッシュが積もり、
// 使われない分が main の Rust のキャッシュを押し出しうる（2026-10-29 に合計 10.8GB、うち main の古い npm が約 6.4GB）。
describe('main の古いキャッシュを選ぶ', () => {
  it('鍵から、ロックファイルの指紋を除いた族を取る', () => {
    expect(cacheFamily('node-cache-Linux-x64-npm-011186114ce7921f5e3f1e51de04b0b79cefbac7358e3952fbe3171a965e085f')).toBe('node-cache-Linux-x64-npm');
    // rust-cache は「接頭辞-ジョブ-OS-arch-環境の指紋-ロックの指紋」。Rust の版が上がると環境の指紋も変わるので、両方を除く。
    expect(cacheFamily('v0-rust-desktop-Darwin-arm64-fc985acc-9ff33c2c')).toBe('v0-rust-desktop-Darwin-arm64');
    expect(cacheFamily('v0-rust-windows-release-Windows_NT-x64-e70cdc14-9ff33c2c')).toBe('v0-rust-windows-release-Windows_NT-x64');
    // 知らない形の鍵は族を決めない（消さない）。
    expect(cacheFamily('something-else')).toBeUndefined();
  });
  it('族ごとに、いちばん新しく使われた 1 つを残し、ほかを古いものとして返す', () => {
    const list = [
      { id: 1, key: 'node-cache-Linux-x64-npm-aaa', lastAccessedAt: '2026-10-28T00:00:00Z' },
      { id: 2, key: 'node-cache-Linux-x64-npm-bbb', lastAccessedAt: '2026-10-29T00:00:00Z' },
      { id: 3, key: 'node-cache-Windows-x64-npm-aaa', lastAccessedAt: '2026-10-27T00:00:00Z' },
      { id: 4, key: 'v0-rust-desktop-Darwin-arm64-a0000000-11111111', lastAccessedAt: '2026-10-20T00:00:00Z' },
      { id: 5, key: 'v0-rust-desktop-Darwin-arm64-b0000000-22222222', lastAccessedAt: '2026-10-29T00:00:00Z' },
      { id: 6, key: 'something-else', lastAccessedAt: '2026-01-01T00:00:00Z' },
    ];
    expect(staleCaches(list).map((c) => c.id).sort()).toEqual([1, 4]);
  });
  it('使われた時刻が同じなら、鍵の順で決まった 1 つを残す（実行のたびに選ぶものが変わらない）', () => {
    const at = '2026-10-29T00:00:00Z';
    const a = staleCaches([{ id: 1, key: 'node-cache-Linux-x64-npm-a', lastAccessedAt: at }, { id: 2, key: 'node-cache-Linux-x64-npm-b', lastAccessedAt: at }]);
    const b = staleCaches([{ id: 2, key: 'node-cache-Linux-x64-npm-b', lastAccessedAt: at }, { id: 1, key: 'node-cache-Linux-x64-npm-a', lastAccessedAt: at }]);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });
  it('台本は gh cache list の JSON を読み、消す id を 1 行に 1 つ書く', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-prune-'));
    const file = path.join(dir, 'caches.json');
    fs.writeFileSync(file, JSON.stringify([
      { id: 10, key: 'node-cache-Linux-x64-npm-aaa', lastAccessedAt: '2026-10-28T00:00:00Z' },
      { id: 11, key: 'node-cache-Linux-x64-npm-bbb', lastAccessedAt: '2026-10-29T00:00:00Z' },
    ]));
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, 'stale', file], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('10\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('cache-prune.yml', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/cache-prune.yml'), 'utf8');
  it('閉じた PR のキャッシュを消し、main の古いキャッシュは週 1 回と手動で片付ける', () => {
    expect(wf).toMatch(/pull_request_target:\n {4}types: \[closed\]\n/);
    expect(wf).toMatch(/schedule:\n {4}- cron: /);
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).toContain('refs/pull/${{ github.event.pull_request.number }}/merge');
    expect(wf).toContain('cache-prune.ts stale');
    expect(wf).toContain('--ref refs/heads/main');
  });
  it('pull_request_target のジョブは PR のコードを取り出さない（書き込みの token で他人のコードを走らせない）', () => {
    const pr = wf.slice(wf.indexOf('\n  pr:\n'), wf.indexOf('\n  main:\n'));
    expect(pr).not.toContain('actions/checkout');
    expect(wf).toMatch(/permissions:\n {6}actions: write\n/);
  });
});
