import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchSpec } from '../../agent/types.ts';
import { writeFakeCodex, type FakeCodexOptions } from '../../../test/fake-codex.ts';
import { posixDescribe } from '../../../test/platform.ts';
import { isProcessAlive } from '../opencode/serve/spawn.ts';
import { LaunchQueue } from '../opencode/serve/queue.ts';
import { TUI_TOKEN_ENV } from './appServer.ts';
import { createCodexDriver, type CodexDriver } from './driver.ts';
import { MCP_TOKEN_ENV } from './launcher.ts';

type Rec = { ev: 'rpc'; method: string; params: Record<string, unknown> } | { ev: 'sigterm' };
type Boot = { argv: string[]; env: Record<string, string> };

const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const alive = (pid: number): boolean => isProcessAlive(pid);

// 偽の codex の app-server を本当に起こす（tmux は使わない。TUI は呼び手が argv を見るだけにする）。Windows の孫の停止は別の試験が受け持つ。
posixDescribe('Codex の driver（materialize、plan、release、reattach）', () => {
  let dir: string;
  let cwd: string;
  let log: string;
  let rpcLog: string;
  const drivers: CodexDriver[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxd-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxdw-'));
    log = path.join(dir, 'boot.jsonl');
    rpcLog = path.join(dir, 'rpc.jsonl');
  });
  afterEach(async () => {
    for (const d of drivers.splice(0)) await d.launch.release({ sessionId: 's1', providerSessionId: '', cwd }, 'killed');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const make = (fake: FakeCodexOptions = {}, over: Partial<Parameters<typeof createCodexDriver>[0]> = {}) => {
    const bin = writeFakeCodex(path.join(dir, 'bin'), { logFile: log, rpcLogFile: rpcLog, ...fake });
    const reports: [string, string][] = [];
    const d = createCodexDriver({
      bin: () => bin, home: path.join(dir, 'home'), droppedEnv: ['HANGAR_SERVER_X'], graceMs: 500, mcpPollMs: 10, mcpWaitMs: 1000, queue: new LaunchQueue(),
      report: (what, e) => { reports.push([what, e instanceof Error ? e.message : String(e)]); }, ...over,
    });
    drivers.push(d);
    return { d, bin, reports };
  };
  const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
    cwd, hangarSessionId: 's1', instructions: [{ key: 'body', text: 'hello\n' }], mcp: { url: 'http://127.0.0.1:4177/mcp/s/s1', secret: 'mcp-secret' }, env: {}, ...over,
  });
  const rpcs = (): Rec[] => (fs.existsSync(rpcLog) ? fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);
  const methods = (): string[] => rpcs().flatMap((r) => (r.ev === 'rpc' ? [r.method] : [r.ev]));
  const boots = (): Boot[] => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Boot).filter((b) => b.argv[0] === 'app-server');
  const serverPid = (d: CodexDriver): number => d.served('s1')!.pid;

  it('初期プロンプトあり：thread/start（cwd、model、権限、追記）で ID を作り、MCP がつながってから turn/start で流す。TUI は resume <ID> でつなぐ', async () => {
    const { d } = make({ mcpPendingPolls: 2 });
    const r = await d.launch.materialize!({ kind: 'start' }, spec({ prompt: '直して', model: 'gpt-x', effort: 'low', mode: 'read-only' }));
    expect(r).toEqual({ providerSessionId: expect.stringMatching(/^01a/) });
    const id = (r as { providerSessionId: string }).providerSessionId;

    const ms = methods();
    const start = rpcs().find((x) => x.ev === 'rpc' && x.method === 'thread/start') as Extract<Rec, { ev: 'rpc' }>;
    expect(start.params).toMatchObject({ cwd, model: 'gpt-x', approvalPolicy: 'on-request', sandbox: 'read-only', developerInstructions: 'hello\n' });
    // MCP が connected になる（3 回目の問い合わせ）まで待ってから、最初の入力を流す。
    expect(ms.filter((m) => m === 'mcpServerStatus/list')).toHaveLength(3);
    expect(ms.indexOf('turn/start')).toBeGreaterThan(ms.lastIndexOf('mcpServerStatus/list'));
    const turn = rpcs().find((x) => x.ev === 'rpc' && x.method === 'turn/start') as Extract<Rec, { ev: 'rpc' }>;
    expect(turn.params).toMatchObject({ threadId: id, effort: 'low', input: [{ type: 'text', text: '直して' }] });

    // app-server の argv は token を載せない。MCP の token は環境にだけある。
    const b = boots()[0]!;
    expect(b.argv.join(' ')).not.toContain('mcp-secret');
    expect(b.argv).toContain('mcp_servers.hangar.url="http://127.0.0.1:4177/mcp/s/s1"');
    expect(b.env[MCP_TOKEN_ENV]).toBe('mcp-secret');
    expect(Object.keys(b.env)).not.toContain('CODEX_HOME');

    const plan = d.launch.plan('/bin/codex', { kind: 'start', id }, spec({ mode: 'read-only', model: 'gpt-x', effort: 'low' }));
    expect(plan.argv.slice(-2)).toEqual(['resume', id]);
    expect(plan.argv).toContain('--remote');
    expect(plan.secretEnv?.[TUI_TOKEN_ENV]).toBeTruthy();
    expect(plan.argv.join(' ')).not.toContain(plan.secretEnv![TUI_TOKEN_ENV]!);
  });

  it('MCP が failed でも起動は続け、知らせて、最初の入力を流す', async () => {
    const { d, reports } = make({ mcpPendingPolls: 'failed' });
    await d.launch.materialize!({ kind: 'start' }, spec({ prompt: 'x' }));
    expect(reports.map((x) => x[0])).toEqual(['mcp']);
    expect(methods()).toContain('turn/start');
  });

  it('初期プロンプトなし：thread/started を先に待ち、TUI（resume なし）がつないだら ID を拾う。拾うまでは resume を付けない', async () => {
    const { d } = make();
    const r = await d.launch.materialize!({ kind: 'start' }, spec());
    expect(r).toEqual({ providerSessionId: expect.stringMatching(/^pending:/), lateSessionId: expect.any(Promise) });
    expect(methods()).not.toContain('thread/start');
    expect(methods()).not.toContain('turn/start');

    const plan = d.launch.plan('/bin/codex', { kind: 'start', id: 'pending:abc' }, spec());
    expect(plan.argv).not.toContain('resume');
    // 実物の TUI の真似：つないだ時点で thread/started が全接続に届く。
    const info = d.served('s1')!;
    const ws = new WebSocket(`${info.url}/?tui=1&cwd=${encodeURIComponent(cwd)}`, { headers: { authorization: `Bearer ${info.token}` } });
    await new Promise((res) => ws.once('open', res));
    const id = await (r as { lateSessionId: Promise<string> }).lateSessionId;
    expect(id).not.toBe((r as { providerSessionId: string }).providerSessionId);
    expect(id).toMatch(/^01a/);
    ws.close();
  });

  it('release：TUI が先に閉じている前提で、動いているターンを interrupt してから app-server を止める。孫も残らない', async () => {
    const gc = path.join(dir, 'gc.pid');
    const { d } = make({ turnMs: 30_000, grandchildPidFile: gc });
    await d.launch.materialize!({ kind: 'start' }, spec({ prompt: '長い' }));
    const pid = serverPid(d);
    await until(() => fs.existsSync(gc));
    const gpid = Number(fs.readFileSync(gc, 'utf8'));
    expect(alive(pid) && alive(gpid)).toBe(true);

    const stopped = await d.launch.release({ sessionId: 's1', providerSessionId: 'x', cwd }, 'tui-gone');
    expect(stopped).toBe(true);
    const ms = methods();
    expect(ms.indexOf('turn/interrupt')).toBeGreaterThan(-1);
    expect(ms.indexOf('turn/interrupt')).toBeLessThan(ms.indexOf('sigterm'));
    await until(() => !alive(pid) && !alive(gpid));
    expect(d.served('s1')).toBeNull();
  });

  it('release：動いているターンが無ければ interrupt せずに止める。持っていない会話では何もしない', async () => {
    const { d } = make();
    expect(await d.launch.release({ sessionId: 's1', providerSessionId: 'x', cwd }, 'killed')).toBe(false);
    await d.launch.materialize!({ kind: 'start' }, spec({ prompt: 'x' }));
    await new Promise((r) => setTimeout(r, 200));
    const pid = serverPid(d);
    expect(await d.launch.release({ sessionId: 's1', providerSessionId: 'x', cwd }, 'killed')).toBe(true);
    expect(methods()).not.toContain('turn/interrupt');
    await until(() => !alive(pid));
  });

  it('権限や推論が Codex に通らない値なら、app-server を起こさずに断る', async () => {
    const { d } = make();
    await expect(d.launch.materialize!({ kind: 'start' }, spec({ mode: 'plan', prompt: 'x' }))).rejects.toThrow(/unknown codex permission/);
    await expect(d.launch.materialize!({ kind: 'start' }, spec({ effort: 'a"b', prompt: 'x' }))).rejects.toThrow(/reasoning effort/);
    expect(fs.existsSync(log)).toBe(false);
  });

  it('再開とフォークはまだ受けない（B3b）。実行ファイルが無ければ断る', async () => {
    const { d } = make();
    await expect(d.launch.materialize!({ kind: 'resume', id: 'a' }, spec())).rejects.toThrow(/cannot resume/);
    const none = createCodexDriver({ bin: () => null, home: path.join(dir, 'home'), droppedEnv: [] });
    await expect(none.launch.materialize!({ kind: 'start' }, spec())).rejects.toThrow(/not found/);
  });

  it('hangar を起こし直したあと：レジストリから app-server を引き継ぎ（reattach）、止められる。止まったものは引き継げない', async () => {
    const a = make({ turnMs: 30_000 });
    const r = await a.d.launch.materialize!({ kind: 'start' }, spec({ prompt: '長い' }));
    const id = (r as { providerSessionId: string }).providerSessionId;
    const pid = serverPid(a.d);
    const b = make({}, { home: path.join(dir, 'home') });
    expect(b.d.launch.reattach!({ sessionId: 's1', providerSessionId: id, cwd })).toBe(true);
    expect(b.d.served('s1')?.pid).toBe(pid);
    expect(await b.d.launch.release({ sessionId: 's1', providerSessionId: id, cwd }, 'killed')).toBe(true);
    expect(methods()).toContain('turn/interrupt');
    await until(() => !alive(pid));
    const c = make({}, { home: path.join(dir, 'home') });
    expect(c.d.launch.reattach!({ sessionId: 's1', providerSessionId: id, cwd })).toBe(false);
  });

  it('servedByHangar を持ち、状態・トランスクリプト・許可の面は B4 と B5 が載せるまで空である', () => {
    const { d } = make();
    expect(d.kind).toBe('codex');
    expect(d.launch.servedByHangar).toBe(true);
    expect(d.caps).toMatchObject({ accounts: false, effort: true, permissionMode: true, fork: false, remoteControl: false, attachExternal: false, promptJump: false });
    expect(d.live.current()).toEqual([]);
    expect(d.instructions.when).toBe('launch');
  });
});
