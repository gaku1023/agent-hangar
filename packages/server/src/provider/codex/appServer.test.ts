import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeCodex } from '../../../test/fake-codex.ts';
import { isWindows } from '../../../test/platform.ts';
import { ServeStartError, isProcessAlive } from '../opencode/serve/spawn.ts';
import {
  CodexRpc, CodexRpcError, appServerArgs, startAppServer, stopAppServer, trustedProjectsConfig, tuiRemote, watchStartedThread, TUI_TOKEN_ENV,
  type AppServerProcess,
} from './appServer.ts';
import { codexBaseEnv } from './env.ts';
import { LaunchQueue } from '../opencode/serve/queue.ts';
import { launchCodexAppServer } from './launch.ts';

const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('app-server の argv と TUI の渡し方', () => {
  it('待ち受けは 127.0.0.1 の ws と capability-token で、token は argv に載らずファイルで渡す', () => {
    const a = appServerArgs({ port: 4567, tokenFile: '/t/x.token', trustedDirs: ['/w/a'], config: ['model_reasoning_effort="low"'] });
    expect(a.slice(0, 7)).toEqual(['app-server', '--listen', 'ws://127.0.0.1:4567', '--ws-auth', 'capability-token', '--ws-token-file', '/t/x.token']);
    expect(a).toContain('projects={"/w/a"={trust_level="trusted"}}');
    expect(a).toContain('model_reasoning_effort="low"');
  });
  it('信頼のフォルダは TOML の文字列として引用符を逃がす', () => {
    expect(trustedProjectsConfig(['/w/a"b', '/w/c'])).toBe('projects={"/w/a\\"b"={trust_level="trusted"},"/w/c"={trust_level="trusted"}}');
  });
  it('TUI へは env の名前で渡し、値は env にだけある', () => {
    const r = tuiRemote('ws://127.0.0.1:1', 'sekret');
    expect(r.args).toEqual(['--remote', 'ws://127.0.0.1:1', '--remote-auth-token-env', TUI_TOKEN_ENV]);
    expect(r.args.join(' ')).not.toContain('sekret');
    expect(r.env).toEqual({ [TUI_TOKEN_ENV]: 'sekret' });
  });
});

describe('app-server の起動と接続', () => {
  let dir: string;
  let work: string;
  const servers: AppServerProcess[] = [];
  const rpcs: CodexRpc[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxas-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxw-'));
  });
  afterEach(async () => {
    for (const r of rpcs.splice(0)) r.close();
    for (const s of servers.splice(0)) await stopAppServer(s, { graceMs: 500 });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function start(o: Parameters<typeof writeFakeCodex>[1] = {}, extra: Partial<Parameters<typeof startAppServer>[0]> = {}): Promise<AppServerProcess> {
    const bin = writeFakeCodex(path.join(dir, 'bin'), o);
    const s = await startAppServer({ bin, env: codexBaseEnv(bin), directory: work, tokenDir: path.join(dir, 'tok'), ...extra });
    servers.push(s);
    return s;
  }
  async function connect(s: AppServerProcess): Promise<CodexRpc> {
    const r = await CodexRpc.connect({ url: s.url, token: s.token });
    rpcs.push(r);
    return r;
  }

  it('token は 0600 のファイルにあり、argv にも app-server の環境にも載らない', async () => {
    const log = path.join(dir, 'log.jsonl');
    const s = await start({ logFile: log });
    if (!isWindows) expect(fs.statSync(s.tokenFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(s.tokenFile, 'utf8')).toBe(s.token);
    const rec = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.argv[0] === 'app-server');
    expect(JSON.stringify(rec)).not.toContain(s.token);
    expect(rec.argv).toContain('--ws-token-file');
    expect(rec.argv).toContain(`projects={${JSON.stringify(work)}={trust_level="trusted"}}`);
  });

  it('token が無い、違う接続は 401 で断られ、/healthz は token 無しで 200', async () => {
    const s = await start();
    expect((await fetch(`http://127.0.0.1:${s.port}/healthz`)).status).toBe(200);
    await expect(CodexRpc.connect({ url: s.url, token: 'wrong' })).rejects.toThrow(/401/);
    const ws = new WebSocket(s.url);
    await expect(new Promise((_, rej) => { ws.once('error', rej); ws.once('unexpected-response', (_q, res) => rej(new Error(`HTTP ${res.statusCode}`))); })).rejects.toThrow(/401/);
  });

  it('initialize のあと thread/start、turn/start、通知（型つき）が流れる', async () => {
    const s = await start();
    const rpc = await connect(s);
    const seen: string[] = [];
    rpc.on('turn/started', (p) => seen.push(`started:${p.turn.id}`));
    rpc.on('turn/completed', (p) => seen.push(`completed:${p.turn.status}`));
    rpc.on('thread/status/changed', (p) => seen.push(`status:${p.status.type}`));
    const { thread } = await rpc.threadStart({ cwd: work, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(thread.id).toMatch(/^01a/);
    const { turn } = await rpc.turnStart({ threadId: thread.id, input: [{ type: 'text', text: 'hi' }] });
    await until(() => seen.includes('status:idle'));
    expect(seen).toEqual([`status:active`, `started:${turn.id}`, 'completed:completed', 'status:idle']);
  });

  it('turn/interrupt は interrupted で終わる。エラーは CodexRpcError になる', async () => {
    const s = await start();
    const rpc = await connect(s);
    const { thread } = await rpc.threadStart({ cwd: work });
    const done: string[] = [];
    rpc.on('turn/completed', (p) => done.push(String(p.turn.status)));
    const { turn } = await rpc.turnStart({ threadId: thread.id, input: [{ type: 'text', text: 'x' }] });
    await rpc.turnInterrupt(thread.id, turn.id);
    await until(() => done.length > 0);
    expect(done).toEqual(['interrupted']);
    const e = await rpc.request('nope').catch((x) => x);
    expect(e).toBeInstanceOf(CodexRpcError);
    expect((e as CodexRpcError).code).toBe(-32601);
  });

  it('入力の前のスレッドは thread/resume できない（実物と同じ -32600）が、最初のターンのあとは通る', async () => {
    const s = await start();
    const rpc = await connect(s);
    const { thread } = await rpc.threadStart({ cwd: work });
    const e = await rpc.threadResume({ threadId: thread.id, excludeTurns: true }).catch((x) => x);
    expect((e as CodexRpcError).code).toBe(-32600);
    expect((e as CodexRpcError).message).toMatch(/no rollout found/);
    await rpc.turnStart({ threadId: thread.id, input: [{ type: 'text', text: 'x' }] });
    await expect(rpc.threadResume({ threadId: thread.id, excludeTurns: true })).resolves.toMatchObject({ thread: { id: thread.id } });
  });

  it('TUI がつないだ時点の thread/started から ID を拾う。ephemeral のものは拾わない', async () => {
    const s = await start();
    const rpc = await connect(s);
    // 別の thread/start（ephemeral でないが cwd が違う）と、題名生成の ephemeral が先に来ても、cwd の合うものだけを採る。
    const w = watchStartedThread(rpc, { cwd: work, timeoutMs: 3000 });
    const other = await rpc.threadStart({ cwd: path.join(work, 'elsewhere') });
    await rpc.turnStart({ threadId: other.thread.id, input: [{ type: 'text', text: 'x' }] }); // ephemeral の thread/started が出る
    const tui = new WebSocket(`${s.url}/?tui=1&cwd=${encodeURIComponent(work)}`, { headers: { authorization: `Bearer ${s.token}` } });
    await new Promise((r) => tui.once('open', r));
    const t = await w.promise;
    tui.close();
    expect(t.ephemeral).toBe(false);
    expect(t.id).not.toBe(other.thread.id);
    expect(t.environments?.[0]?.cwd).toBe(work);
    expect(await rpc.threadLoadedList()).toContain(t.id);
  });

  it('thread/started が来なければ時間切れで投げる。cancel もできる', async () => {
    const s = await start();
    const rpc = await connect(s);
    await expect(watchStartedThread(rpc, { timeoutMs: 100 }).promise).rejects.toThrow(/timed out/);
    const w = watchStartedThread(rpc, { timeoutMs: 5000 });
    w.cancel();
    await expect(w.promise).rejects.toThrow(/cancelled/);
  });

  it('止めるのは SIGTERM。孫まで消え、token のファイルも消える', async () => {
    if (isWindows) return;
    const pidFile = path.join(dir, 'gc.pid');
    const s = await start({ grandchildPidFile: pidFile });
    await until(() => fs.existsSync(pidFile));
    const gc = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(isProcessAlive(gc)).toBe(true);
    await stopAppServer(s, { graceMs: 3000 });
    await until(() => !isProcessAlive(gc));
    expect(isProcessAlive(s.pid)).toBe(false);
    expect(fs.existsSync(s.tokenFile)).toBe(false);
  });

  it('SIGTERM で終わらなければ猶予のあと SIGKILL', async () => {
    if (isWindows) return;
    const s = await start({ ignoreSigterm: true });
    const signals: string[] = [];
    const t0 = Date.now();
    await stopAppServer(s, { graceMs: 300, kill: (pid, sig) => { signals.push(sig); try { process.kill(-pid, sig); return true; } catch { return false; } } });
    expect(signals[0]).toBe('SIGTERM');
    expect(signals).toContain('SIGKILL');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(isProcessAlive(s.pid)).toBe(false);
  });

  it('起動の直後に落ちたら ServeStartError(exited) で投げ、token のファイルを残さない', async () => {
    const bin = writeFakeCodex(path.join(dir, 'bin'), { crashOnStart: true });
    const tokenDir = path.join(dir, 'tok');
    const e = await startAppServer({ bin, env: codexBaseEnv(bin), directory: work, tokenDir }).catch((x) => x);
    expect(e).toBeInstanceOf(ServeStartError);
    expect((e as ServeStartError).reason).toBe('exited');
    expect(fs.readdirSync(tokenDir)).toEqual([]);
  });

  it('launchCodexAppServer は 1 本ずつ起こし、つないで initialize まで済ませる', async () => {
    const bin = writeFakeCodex(path.join(dir, 'bin'));
    const queue = new LaunchQueue();
    const opts = { bin, env: codexBaseEnv(bin), directory: work, tokenDir: path.join(dir, 'tok'), queue };
    const hs = await Promise.all([launchCodexAppServer(opts), launchCodexAppServer(opts)]);
    try {
      // 起動の仕事は待ち行列で 1 本ずつ（LaunchQueue の試験は opencode 側）。2 本とも別のポートと token を持つ。
      expect(new Set(hs.map((h) => h.server.port)).size).toBe(2);
      expect(hs[0].server.token).not.toBe(hs[1].server.token);
      expect(hs[0].tuiRemote.env[TUI_TOKEN_ENV]).toBe(hs[0].server.token);
      expect(hs[0].tuiRemote.args).toContain(hs[0].server.url);
      const { thread } = await hs[0].rpc.threadStart({ cwd: work });
      expect(thread.id).toBeTruthy();
    } finally {
      for (const h of hs) await h.stop({ graceMs: 500 });
    }
    expect(isProcessAlive(hs[0].server.pid)).toBe(false);
  });
});
