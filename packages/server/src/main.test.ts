import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_CHILD_ENV } from './provider/claude-code/compat/childEnv.ts';
import { SERVER_DROPPED_ENV } from './launch/env.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await cond()) return true;
    } catch {
      // まだ起きていない
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// tmux の新しいサーバは、起こした側（hangar のサーバ）の環境を全体の環境として持つ。
// 偽の tmux に環境を書き出させ、サーバが子へ渡す環境を外から見る。claude を起こす子（captureOutput など）も同じ環境を継ぐ。
// sh の台本を tmux に見立てるので、Windows では走らせない。
describe.skipIf(process.platform === 'win32')('サーバの起動（main.ts）', () => {
  it('受け継いだ Claude Code の印と hangar の受け渡しの変数を、子を起こす前に自分の環境から消す', async () => {
    const root = tmp('hangar-main-');
    const home = path.join(root, 'home');
    const claude = path.join(root, 'claude');
    const ws = path.join(root, 'ws');
    const ui = path.join(root, 'ui');
    for (const d of [home, path.join(claude, 'projects'), path.join(claude, 'sessions'), ws, ui]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>handed-ui</title>');
    const dump = path.join(root, 'tmux-env.txt');
    const fakeTmux = path.join(root, 'fake-tmux');
    fs.writeFileSync(fakeTmux, `#!/bin/sh\nenv > "${dump}.tmp" && mv "${dump}.tmp" "${dump}"\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir: claude, tmuxPath: fakeTmux, toolsResolved: true, claudePath: null }));
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'main.ts')], {
      cwd: path.resolve(here, '..'),
      stdio: 'ignore',
      env: {
        ...process.env,
        // Claude Code のセッションの Bash から起こされたときの印。値は形だけである。
        ...Object.fromEntries(CLAUDE_CHILD_ENV.map((n) => [n, 'x'])),
        HANGAR_RUN_ID: 'r', HANGAR_UNSET_ENV: 'A;B', HANGAR_CLOUD_DIR: path.join(root, 'cloud'),
        HANGAR_PORT: String(port), HANGAR_PARENT_PID: String(process.pid), HANGAR_UI_DIST: ui,
        HANGAR_HOME: home, HANGAR_CLAUDE_DIR: claude, HANGAR_CLAUDE_BIN: path.join(root, 'no-claude'),
        // 利用者の設定。消さずに子へ渡す。
        CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://gw.example',
      },
    });
    const exited = new Promise((r) => child.on('exit', r));
    try {
      // HANGAR_PORT と HANGAR_UI_DIST は読んでから消すので、待ち受けと UI の配り先は渡した値のままである。
      expect(await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 30_000)).toBe(true);
      const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
      expect(await (await fetch(`http://127.0.0.1:${port}/?t=${token}`)).text()).toContain('handed-ui');
      expect(await waitFor(() => fs.existsSync(dump), 30_000)).toBe(true);
      const names = new Set(fs.readFileSync(dump, 'utf8').split('\n').map((l) => l.split('=')[0]));
      for (const n of SERVER_DROPPED_ENV) expect(names.has(n), n).toBe(false);
      for (const n of ['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL', 'HANGAR_HOME', 'HANGAR_CLAUDE_DIR']) expect(names.has(n), n).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  }, 90_000);
});
