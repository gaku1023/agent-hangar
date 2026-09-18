import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    const r = await runCli(['setup', '--skip-statusline']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('データディレクトリ:');
    expect(r.out).toContain('MCP の登録は hangar mcp install で行えます。');
    const h = await runCli(['setup', '--help']);
    expect(h.out).toContain('--skip-statusline');
    expect(h.out).toContain('--workspace');
    // setup cloud がぶら下がっている。
    expect(h.out).toContain('cloud');
  });
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

  it('サーバが居れば、鍵付きの URL を印字してから開く', async () => {
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
    expect(r.out).not.toContain(readToken());
  }, 90_000);
});
