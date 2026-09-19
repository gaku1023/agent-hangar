import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleServer, NATIVE_MODULES, PREBUILD_ARCH } from '../scripts/bundle-server.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * 配布物は Apple silicon 向けにしか作らない。
 * ネイティブモジュールの prebuild が他の環境には無いので、そこでは試しても意味が無い。
 */
const onAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64';

const dirSize = (dir: string): number => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath, e.name);
    if (e.isFile()) total += fs.lstatSync(p).size;
  }
  return total;
};

async function waitHealth(url: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok && ((await r.json()) as { ok?: boolean }).ok === true) return true;
    } catch {
      // まだ起きていない
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe.skipIf(!onAppleSilicon)('bundleServer', () => {
  it('server.mjs、cli.mjs、ui、ネイティブモジュール、cloud、manifest、bin/hangar を出し、tsx 無しで起動する', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    const home = tmp('hangar-home-');
    const claude = tmp('hangar-claude-');
    const ws = tmp('hangar-ws-');
    dirs.push(out, ui, home, claude, ws);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    fs.mkdirSync(path.join(claude, 'projects'));
    fs.mkdirSync(path.join(claude, 'sessions'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir: claude }));

    const r = await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    expect(r.files.sort()).toEqual(['.gitkeep', 'bin', 'cli.mjs', 'cloud', 'manifest.json', 'node_modules', 'server.mjs', 'ui']);

    // 同梱するネイティブは better-sqlite3 と node-pty の二つだけで、実体は prebuildify 形式の prebuilds にある。
    expect(NATIVE_MODULES).toEqual(['better-sqlite3', 'node-pty']);
    for (const f of [
      'ui/index.html',
      'node_modules/better-sqlite3/package.json',
      'node_modules/better-sqlite3/lib/index.js',
      `node_modules/better-sqlite3/prebuilds/${PREBUILD_ARCH}.node`,
      'node_modules/node-pty/package.json',
      'node_modules/node-pty/lib/index.js',
      `node_modules/node-pty/prebuilds/${PREBUILD_ARCH}/pty.node`,
      `node_modules/node-pty/prebuilds/${PREBUILD_ARCH}/spawn-helper`,
      'cloud/src/index.ts',
      'cloud/wrangler.jsonc',
      'cloud/package.json',
    ]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }

    // 実行に要らない重い中身は落とす。特に他のアーキの prebuild を入れると 90MB 近くなる。
    for (const f of [
      'node_modules/better-sqlite3/deps',
      'node_modules/better-sqlite3/src',
      'node_modules/better-sqlite3/prebuilds/linux-x64.node',
      'node_modules/better-sqlite3/prebuilds/win32-x64.node',
      'node_modules/node-pty/deps',
      'node_modules/node-pty/third_party',
      'node_modules/node-pty/prebuilds/win32-x64',
      'node_modules/node-pty/prebuilds/darwin-x64',
      'cloud/test',
      'cloud/node_modules',
    ]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(false);
    }
    expect(dirSize(path.join(out, 'node_modules'))).toBeLessThan(15 * 1024 * 1024);

    expect(fs.statSync(path.join(out, 'bin/hangar')).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(out, 'bin/hangar'), 'utf8')).toContain('HANGAR_CLOUD_DIR');
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ version: '0.1.0', nodeMajor: Number(process.versions.node.split('.')[0]), arch: process.arch });
    expect(typeof m.builtAt).toBe('string');
    const js = fs.readFileSync(path.join(out, 'server.mjs'), 'utf8');
    expect(js).not.toContain('from "tsx"');
    expect(js).not.toContain('./server.ts');

    const child = spawn(process.execPath, [path.join(out, 'server.mjs')], {
      env: { ...process.env, HANGAR_HOME: home, HANGAR_CLAUDE_DIR: claude, HANGAR_PORT: '4199', HANGAR_UI_DIST: path.join(out, 'ui') },
      stdio: 'ignore',
    });
    try {
      expect(await waitHealth('http://127.0.0.1:4199/health', 30_000)).toBe(true);
      // 素の GET / は 401 の案内を返す。UI は鍵付きの URL でだけ配られる。
      const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
      const html = await (await fetch(`http://127.0.0.1:4199/?t=${token}`)).text();
      expect(html).toContain('bundled-ui');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
  });

  it('bin/hangar が同梱の Node で cli.mjs を動かす', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    const home = tmp('hangar-home-');
    dirs.push(out, ui, home);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });

    const { stdout } = await promisify(execFile)(path.join(out, 'bin/hangar'), ['--help'], {
      env: { ...process.env, HANGAR_HOME: home, HANGAR_NODE: process.execPath },
    });
    expect(stdout).toContain('hangar');
    expect(stdout).toContain('setup');
  });

  it('UI のビルドが無ければ、何をすればよいかを述べて止まる', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    dirs.push(out, ui);
    await expect(bundleServer({ repoRoot, outDir: out, uiDist: ui })).rejects.toThrow(/npm run build/);
  });
});
