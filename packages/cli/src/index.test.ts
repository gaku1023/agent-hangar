import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE_DB_VERSION, dbVersionOf, seedDbAt } from '../../server/test/oldDb.ts';
import { posixIt } from '../../server/test/platform.ts';
import { probeHealth } from './probe.ts';

/** 実物の hangar を子プロセスで動かす。実物の ~/.claude と ~/.agent-hangar には触らせない。 */
const CLI = fileURLToPath(new URL('../bin/hangar.mjs', import.meta.url));

let home: string;
let claudeDir: string;
let fakeBin: string;
let marker: string;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-'));
  home = path.join(dir, 'home');
  claudeDir = path.join(dir, 'claude');
  fakeBin = path.join(dir, 'bin');
  marker = path.join(dir, 'opened.txt');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  // ブラウザは開かせない。呼ばれたことだけを控えに残す。
  for (const name of ['osascript', 'open']) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\necho "called ${name}" >> "$HANGAR_TEST_MARKER"\ncat >> "$HANGAR_TEST_MARKER" 2>/dev/null\nexit 0\n`, { mode: 0o755 });
  }
});

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

/** hangar を 1 回走らせる。標準出力と標準エラーはまとめて見る。 */
function runCli(args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: path.dirname(home),
        HANGAR_HOME: home,
        HANGAR_CLAUDE_DIR: claudeDir,
        HANGAR_TEST_MARKER: marker,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    const timer = setTimeout(() => { if (child.pid) process.kill(child.pid, 'SIGKILL'); reject(new Error(`時間切れ: ${args.join(' ')}\n${out}`)); }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

/** 使い捨ての受け口。自分で起こしたものだけを閉じる。 */
async function listenHealth(): Promise<number> {
  const server = createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' }).end('{"ok":true}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => { server.close(() => r()); }));
  return (server.address() as AddressInfo).port;
}

/** 誰も待ち受けていないポートを 1 つ取る。 */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise((r) => server.close(r));
  return port;
}

const readToken = (): string => fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
const opened = (): string => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');

/** ブラウザを起こす子は切り離されているので、控えが書かれるのは親が終わった後になりうる。 */
async function waitOpened(timeoutMs = 3000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = opened();
    if (got !== '' || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('hangar setup', () => {
  it('サブコマンドを足しても setup 自身の動作は変わらない', async () => {
    const r = await runCli(['setup', '--skip-statusline', '--skip-shell']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('データディレクトリ:');
    expect(r.out).toContain('MCP の登録は hangar mcp install で行えます。');
    const h = await runCli(['setup', '--help']);
    expect(h.out).toContain('--skip-statusline');
    expect(h.out).toContain('--skip-shell');
    expect(h.out).toContain('--workspace');
    // setup cloud がぶら下がっている。
    expect(h.out).toContain('cloud');
  // CLI を 2 回起こす。Windows の全体の試験の中では 3 秒あまりかかり（実測）、既定の 5 秒に時々届く。
  }, 20_000);
});

describe('hangar cloud', () => {
  it('未参加の端末では、status は未設定と言い、teardown は断る', async () => {
    const s = await runCli(['cloud', 'status']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('未設定');

    const t = await runCli(['cloud', 'teardown']);
    expect(t.code).not.toBe(0);
    expect(t.out).toContain('クラウド同期は未設定です');
  });

  it('join は標準入力が対話でなければ、トークンを読む前に断る', async () => {
    // 子プロセスの標準入力はパイプなので、確認を取れない。秘密を受け取る前に止まる。
    const r = await runCli(['join']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--force');
  });
});

describe('hangar url', () => {
  it('鍵付きの URL を印字するだけで、ブラウザは開かない', async () => {
    const port = await listenHealth();
    const r = await runCli(['url', '--port', String(port)]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`http://127.0.0.1:${port}/?t=${readToken()}`);
    expect(await waitOpened(400)).toBe('');
  });

  it('サーバが居なくても印字する。URL を見直すための道だからである', async () => {
    const port = await deadPort();
    const r = await runCli(['url', '--port', String(port)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`?t=${readToken()}`);
  });
});

describe('hangar open', () => {
  it('サーバが居なければ、開かずに起動を促して 0 以外で終わる', async () => {
    const port = await deadPort();
    const r = await runCli(['open', '--port', String(port)]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('サーバが動いていません');
    expect(r.out).toContain('hangar start');
    // 開かない。鍵も出さない。
    expect(await waitOpened(400)).toBe('');
    expect(r.out).not.toContain('?t=');
  });

  // osascript でブラウザを開く。Windows で開く経路は次の区切りで作る。
  posixIt('サーバが居れば、鍵付きの URL を印字してから開く', async () => {
    const port = await listenHealth();
    const r = await runCli(['open', '--port', String(port)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`http://127.0.0.1:${port}/?t=${readToken()}`);
    expect(await waitOpened()).toContain('called ');
  });
});

describe('hangar start', () => {
  it('使われているポートでは、生のスタックではなく日本語の 1 行を出す', async () => {
    const port = await listenHealth();
    const r = await runCli(['start', '--port', String(port), '--no-open']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`ポート ${port} は既に使われています`);
    expect(r.out).not.toContain('EADDRINUSE');
    expect(r.out).not.toContain('node:net');
    expect(r.out).not.toMatch(/^\s+at /m);
    // 子を起こす前に断るので、鍵のファイルはまだ作られていないことがある。鍵付きの URL が出ないことを見る。
    expect(r.out).not.toContain('?t=');
  }, 90_000);

  // 子を SIGTERM で止める。Windows の信号の扱いは移植の区切りで作る。
  posixIt('子のサーバを起こし、起動が済んでから鍵付きの URL を出し、SIGTERM で子も降りる', async () => {
    const port = await deadPort();
    const root = path.dirname(home);
    const ws = path.join(root, 'ws');
    const tmuxDir = path.join(root, 'tmux');
    fs.mkdirSync(ws);
    fs.mkdirSync(tmuxDir);
    fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
    // hangar の中から試験を走らせたときに、外のサーバ向けの値を子へ持ち込まない。
    const { HANGAR_PARENT_PID: _pid, HANGAR_UI_DIST: _ui, HANGAR_PORT: _port, ...base } = process.env;
    const child = spawn(process.execPath, [CLI, 'start', '--port', String(port), '--no-open'], {
      env: {
        ...base,
        HOME: root,
        HANGAR_HOME: home,
        HANGAR_CLAUDE_DIR: claudeDir,
        HANGAR_TEST_MARKER: marker,
        // 存在する場所を渡す。無い場所だと tmux は黙って本物のサーバへつなぐ。
        TMUX_TMPDIR: tmuxDir,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    const closed = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    try {
      const until = Date.now() + 60_000;
      while (!out.includes('?t=') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain(`この URL から開いてください: http://127.0.0.1:${port}/?t=${readToken()}`);
      // URL を出した時点で、サーバは起動を済ませている。
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { ok: boolean; ready: boolean };
      expect(health).toMatchObject({ ok: true, ready: true });
      expect(await waitOpened(400)).toBe('');
    } finally {
      child.kill('SIGTERM');
    }
    expect(await closed).toBe(0);
    // 子のサーバも降りていて、ポートを掴んだまま残らない。
    expect(await probeHealth(port, 500)).toBe(false);
  }, 90_000);

  // 子プロセスには仮の次の版を渡せないので、ここでは「DB を開けずに起動を止める」流れを、起点より古い版の DB で確かめる。
  // 控えが取れないときに止まることは、同じプロセスで走る試験（server.test.ts と cloud.test.ts）が見ている。
  it('起点より古い版の DB のときは、子のサーバの理由を出して止まり、DB に触らない', async () => {
    const port = await deadPort();
    const root = path.dirname(home);
    const ws = path.join(root, 'ws');
    const tmuxDir = path.join(root, 'tmux');
    fs.mkdirSync(ws);
    fs.mkdirSync(tmuxDir);
    fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
    // 起点の 1 つ前の版までの DB を置く。
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, BASELINE_DB_VERSION - 1);
    const before = fs.readFileSync(file);
    // hangar の中から試験を走らせたときに、外のサーバ向けの値を子へ持ち込まない。
    const { HANGAR_PARENT_PID: _pid, HANGAR_UI_DIST: _ui, HANGAR_PORT: _port, ...base } = process.env;
    const r = await new Promise<{ code: number; out: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'start', '--port', String(port), '--no-open'], {
        env: {
          ...base,
          HOME: root,
          HANGAR_HOME: home,
          HANGAR_CLAUDE_DIR: claudeDir,
          HANGAR_TEST_MARKER: marker,
          // 存在する場所を渡す。無い場所だと tmux は黙って本物のサーバへつなぐ。
          TMUX_TMPDIR: tmuxDir,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      });
      let out = '';
      // 止め方を SIGTERM にするのは、CLI が子のサーバへ渡して両方を降ろすため（SIGKILL では子が取り残される）。
      // 守りが外れて URL まで出たら、待たずに止めて、下の断言で落とす。
      const collect = (b: Buffer): void => {
        out += b.toString();
        if (out.includes('?t=')) child.kill('SIGTERM');
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`時間切れ\n${out}`)); }, 60_000);
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`版 ${BASELINE_DB_VERSION - 1} で、このアプリが開けるのは版 ${BASELINE_DB_VERSION} 以降です`);
    expect(r.out).toContain('マイグレーションも当てずに止めました');
    expect(r.out).toContain('起動の途中で終わりました');
    expect(r.out).not.toContain('?t=');
    expect(dbVersionOf(file)).toBe(BASELINE_DB_VERSION - 1);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(home, 'backups'))).toBe(false);
    expect(await probeHealth(port, 500)).toBe(false);
  }, 90_000);
});
