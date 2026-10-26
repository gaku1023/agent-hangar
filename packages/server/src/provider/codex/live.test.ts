import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import type { AgentAsk } from '../../agent/types.ts';
import { writeFakeCodex } from '../../../test/fake-codex.ts';
import { CodexRpc, CodexRpcError, startAppServer, stopAppServer, type AppServerProcess, type CodexNotification, type CodexServerRequest } from './appServer.ts';
import { codexPendingOf } from './asks.ts';
import { codexBaseEnv } from './env.ts';
import { createCodexLive, type CodexRpcLike } from './live.ts';

const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 接続のふり。通知と要求を手で流し、request の答えを差し替えられる。 */
class StubRpc implements CodexRpcLike {
  isClosed = false;
  requests: { method: string; params: unknown }[] = [];
  answer: (method: string, params: unknown) => unknown = () => ({});
  private typed = new Map<string, Set<(p: never) => void>>();
  private any = new Set<(n: CodexNotification) => void>();
  private reqs = new Set<(r: CodexServerRequest) => void>();
  private closers = new Set<() => void>();
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    return this.answer(method, params) as T;
  }
  on(method: string, h: (p: never) => void): () => void {
    const set = this.typed.get(method) ?? new Set();
    this.typed.set(method, set);
    set.add(h);
    return () => set.delete(h);
  }
  onAny(h: (n: CodexNotification) => void): () => void { this.any.add(h); return () => this.any.delete(h); }
  onServerRequest(h: (r: CodexServerRequest) => void): () => void { this.reqs.add(h); return () => this.reqs.delete(h); }
  onClose(h?: () => void): void { if (h) this.closers.add(h); }
  emit(method: string, params: unknown): void {
    for (const h of [...(this.typed.get(method) ?? [])]) h(params as never);
    for (const h of [...this.any]) h({ method, params });
  }
  ask(r: CodexServerRequest): void { for (const h of [...this.reqs]) h(r); }
  close(): void { this.isClosed = true; for (const h of [...this.closers]) h(); }
}
const asRpc = (s: StubRpc): CodexRpc => s as unknown as CodexRpc;
const T = 'thread-1';
const status = (type: string, activeFlags?: string[]) => ({ threadId: T, status: { type, ...(activeFlags ? { activeFlags } : {}) } });

describe('承認の要求の写し', () => {
  const req = (method: string, params: object): CodexServerRequest => ({ id: 7, method, params: { threadId: T, turnId: 'u', itemId: 'i1', ...params } });
  it('命令は Bash、ファイルの変更は Edit、権限は Permissions の許可の札にする', () => {
    expect(codexPendingOf(req('item/commandExecution/requestApproval', { command: 'rm x', reason: 'why' }))).toMatchObject({ key: '7', kind: 'permission', ask: { tool: 'Bash', input: 'rm x', description: 'why' } });
    expect(codexPendingOf(req('item/fileChange/requestApproval', { grantRoot: '/w', reason: null }))).toMatchObject({ kind: 'permission', ask: { tool: 'Edit', input: '/w', description: null } });
    expect(codexPendingOf(req('item/permissions/requestApproval', { cwd: '/w', permissions: { network: { enabled: true }, fileSystem: { write: ['/a', '/b'], read: ['/c'] } } }))).toMatchObject({ ask: { tool: 'Permissions', input: 'network\nwrite /a, /b\nread /c' } });
    expect(codexPendingOf(req('item/permissions/requestApproval', { cwd: '/w', permissions: {} }))).toMatchObject({ ask: { input: '/w' } });
  });
  it('質問は AskUserQuestion の形（最初の問いの文）にする', () => {
    expect(codexPendingOf(req('item/tool/requestUserInput', { questions: [{ id: 'q', header: 'H', question: 'Which?' }] }))).toMatchObject({ kind: 'question', toolId: 'i1', question: 'Which?' });
    expect(codexPendingOf(req('mcpServer/elicitation/request', { serverName: 'srv', message: 'Need it' }))).toMatchObject({ kind: 'question', question: 'Need it' });
  });
  it('知らない要求と threadId の無い要求は読まない', () => {
    expect(codexPendingOf(req('item/other', {}))).toBeNull();
    expect(codexPendingOf({ id: 1, method: 'item/tool/requestUserInput', params: {} })).toBeNull();
    expect(codexPendingOf({ id: 1, method: 'item/tool/requestUserInput', params: 'x' })).toBeNull();
  });
});

describe('状態の写し（接続のふり）', () => {
  let rpc: StubRpc;
  let alivePids: Set<number>;
  const mk = (o: { subscribed?: boolean; subscribeDelaysMs?: number[] } = {}) => {
    const { live, asks } = createCodexLive({ pidAlive: (p) => alivePids.has(p), subscribeDelaysMs: o.subscribeDelaysMs ?? [5], pidCheckMs: 20 });
    const asked: AgentAsk[] = [];
    asks.subscribe!((a) => asked.push(a));
    live.track({ providerSessionId: T, cwd: '/w', pid: 42, rpc: asRpc(rpc), subscribed: o.subscribed ?? true });
    return { live, asked };
  };
  const row = (live: { current(): LiveSessionDto[] }): LiveSessionDto | undefined => live.current()[0];
  beforeEach(() => { rpc = new StubRpc(); alivePids = new Set([42]); });

  it('載せた直後は休み。active で作業中、idle で休みに戻る', async () => {
    const { live } = mk();
    expect(row(live)).toMatchObject({ sessionId: T, status: 'idle', agent: 'codex', pid: 42, cwd: '/w' });
    rpc.emit('thread/status/changed', status('active', []));
    expect(row(live)?.status).toBe('busy');
    rpc.emit('thread/status/changed', status('idle'));
    expect(row(live)?.status).toBe('idle');
    rpc.emit('thread/status/changed', status('active', []));
    rpc.emit('thread/status/changed', status('systemError'));
    expect(row(live)?.status).toBe('idle');
  });
  it('turn/started で作業中、turn/completed で休み。ほかのスレッドの通知は読まない', () => {
    const { live } = mk();
    rpc.emit('turn/started', { threadId: 'other', turn: { id: 'u' } });
    expect(row(live)?.status).toBe('idle');
    rpc.emit('turn/started', { threadId: T, turn: { id: 'u' } });
    expect(row(live)?.status).toBe('busy');
    rpc.emit('turn/completed', { threadId: T, turn: { id: 'u' } });
    expect(row(live)?.status).toBe('idle');
  });
  it('旗 waitingOnApproval は許可の待ち、waitingOnUserInput は質問の待ち（要求の中身が無くても）', () => {
    const { live } = mk();
    rpc.emit('thread/status/changed', status('active', ['waitingOnApproval']));
    expect(row(live)).toMatchObject({ status: 'waiting', waitingFor: 'permission' });
    expect(row(live)?.permission).toBeUndefined();
    rpc.emit('thread/status/changed', status('active', ['waitingOnUserInput']));
    expect(row(live)).toMatchObject({ status: 'waiting', waitingFor: 'question' });
    rpc.emit('thread/status/changed', status('active', []));
    expect(row(live)?.status).toBe('busy');
  });
  it('承認の要求は許可の中身を行に載せ、subscribe へ 1 度だけ流す。答えは送らない', () => {
    const { live, asked } = mk();
    rpc.emit('thread/status/changed', status('active', ['waitingOnApproval']));
    rpc.ask({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: T, turnId: 'u', itemId: 'i', command: 'rm -rf x', reason: 'r' } });
    expect(row(live)).toMatchObject({ status: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'rm -rf x', description: 'r' } });
    expect(asked).toEqual([{ kind: 'permission', providerSessionId: T, ask: { tool: 'Bash', input: 'rm -rf x', description: 'r' } }]);
    expect(rpc.requests.filter((r) => r.method !== 'thread/read')).toEqual([]);
  });
  it('要求が先に届いて旗が後から付いても、消えない', () => {
    const { live } = mk();
    rpc.emit('thread/status/changed', status('active', []));
    rpc.ask({ id: 3, method: 'item/fileChange/requestApproval', params: { threadId: T, grantRoot: '/w' } });
    rpc.emit('thread/status/changed', status('active', ['waitingOnApproval']));
    expect(row(live)).toMatchObject({ status: 'waiting', permission: { tool: 'Edit' } });
  });
  it('TUI で解かれたら（serverRequest/resolved）写しから消える', () => {
    const { live } = mk();
    rpc.emit('thread/status/changed', status('active', ['waitingOnApproval']));
    rpc.ask({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: T, command: 'x' } });
    rpc.emit('serverRequest/resolved', { threadId: T, requestId: 3 });
    expect(row(live)?.permission).toBeUndefined();
    rpc.emit('thread/status/changed', status('active', []));
    expect(row(live)?.status).toBe('busy');
  });
  it('resolved を取りこぼしても、旗が消えれば消える。ターンの終わりと休みでも消える', () => {
    const { live } = mk();
    rpc.emit('thread/status/changed', status('active', ['waitingOnApproval']));
    rpc.ask({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: T, command: 'x' } });
    rpc.emit('thread/status/changed', status('active', []));
    expect(row(live)).toMatchObject({ status: 'busy' });
    expect(row(live)?.permission).toBeUndefined();
    rpc.emit('thread/status/changed', status('active', ['waitingOnApproval']));
    rpc.ask({ id: 4, method: 'item/commandExecution/requestApproval', params: { threadId: T, command: 'y' } });
    rpc.emit('turn/completed', { threadId: T, turn: { id: 'u' } });
    rpc.emit('thread/status/changed', status('idle'));
    expect(row(live)).toMatchObject({ status: 'idle' });
    expect(row(live)?.permission).toBeUndefined();
  });
  it('質問は asked を流し、解かれたら answered を流す', () => {
    const { live, asked } = mk();
    rpc.emit('thread/status/changed', status('active', ['waitingOnUserInput']));
    rpc.ask({ id: 5, method: 'item/tool/requestUserInput', params: { threadId: T, itemId: 'it', isBlocking: true, questions: [{ id: 'q', header: 'h', question: 'Which?' }] } });
    expect(row(live)).toMatchObject({ status: 'waiting', waitingFor: 'question' });
    expect(asked).toEqual([{ kind: 'question', providerSessionId: T, hook: { kind: 'asked', providerSessionId: T, toolId: 'it', summary: 'Which?', question: 'Which?' } }]);
    rpc.emit('serverRequest/resolved', { threadId: T, requestId: 5 });
    expect(asked[1]).toEqual({ kind: 'question', providerSessionId: T, hook: { kind: 'answered', providerSessionId: T, toolId: 'it' } });
    expect(row(live)?.status).toBe('busy');
  });

  it('接続が閉じたら行ごと外れ、「実行中」は残らない。待っていた問いは答えたと流す', () => {
    const { live, asked } = mk();
    rpc.emit('thread/status/changed', status('active', ['waitingOnUserInput']));
    rpc.ask({ id: 5, method: 'item/tool/requestUserInput', params: { threadId: T, itemId: 'it', isBlocking: true, questions: [] } });
    rpc.close();
    expect(live.current()).toEqual([]);
    expect(asked.at(-1)).toMatchObject({ kind: 'question', hook: { kind: 'answered', toolId: 'it' } });
    expect(live.isRunning(T, 42)).toBe(false);
  });
  it('接続が閉じていない作業中でも、app-server の pid が消えたら外れる', async () => {
    const { live } = mk();
    live.start();
    rpc.emit('thread/status/changed', status('active', []));
    expect(row(live)?.status).toBe('busy');
    expect(live.isRunning(T, 42)).toBe(true);
    expect(live.isRunning(T, 41)).toBe(false);
    alivePids.clear();
    await until(() => live.current().length === 0);
    live.stop();
  });
  it('閉じた接続は載せない。untrack で外れ、外したあとの通知は読まない', () => {
    rpc.isClosed = true;
    const closed = createCodexLive();
    closed.live.track({ providerSessionId: T, cwd: '/w', pid: 42, rpc: asRpc(rpc) });
    expect(closed.live.current()).toEqual([]);
    rpc.isClosed = false;
    const { live } = mk();
    live.untrack(T);
    rpc.emit('thread/status/changed', status('active', []));
    expect(live.current()).toEqual([]);
  });
  it('onChange は変わったときだけ呼ぶ', () => {
    const { live } = mk();
    const seen: string[] = [];
    live.onChange((l) => seen.push(l[0]?.status ?? 'none'));
    rpc.emit('thread/status/changed', status('active', []));
    rpc.emit('thread/status/changed', status('active', []));
    rpc.emit('thread/status/changed', status('idle'));
    expect(seen).toEqual(['busy', 'idle']);
  });

  it('載せたとき thread/read で今の status を取る。読んでいる間に通知が来たら、通知を優先する', async () => {
    rpc.answer = (m) => (m === 'thread/read' ? { thread: { status: { type: 'active', activeFlags: [] } } } : {});
    const { live } = mk();
    await until(() => row(live)?.status === 'busy');
    // kick の読み直し：通知が先に来たら、古い答えで潰さない。
    let release: () => void = () => undefined;
    rpc.answer = (m) => (m === 'thread/read' ? new Promise((r) => { release = () => r({ thread: { status: { type: 'active', activeFlags: [] } } }); }) : {});
    live.start();
    live.kick(0);
    await until(() => rpc.requests.filter((r) => r.method === 'thread/read').length >= 2);
    rpc.emit('thread/status/changed', status('idle'));
    release();
    await sleep(30);
    expect(row(live)?.status).toBe('idle');
    live.stop();
  });

  describe('subscribe（TUI が作ったスレッド）', () => {
    it('subscribed でなければ、最初の active で thread/resume {excludeTurns:true}。idle では送らない', async () => {
      const { live } = mk({ subscribed: false });
      rpc.emit('thread/status/changed', status('idle'));
      await sleep(20);
      expect(rpc.requests.some((r) => r.method === 'thread/resume')).toBe(false);
      rpc.emit('thread/status/changed', status('active', []));
      await until(() => rpc.requests.some((r) => r.method === 'thread/resume'));
      expect(rpc.requests.find((r) => r.method === 'thread/resume')?.params).toEqual({ threadId: T, excludeTurns: true });
      rpc.emit('thread/status/changed', status('active', ['waitingOnApproval']));
      await sleep(20);
      expect(rpc.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(1);
      expect(live.current()).toHaveLength(1);
    });
    it('subscribed:true なら送らない', async () => {
      mk({ subscribed: true });
      rpc.emit('thread/status/changed', status('active', []));
      await sleep(30);
      expect(rpc.requests.some((r) => r.method === 'thread/resume')).toBe(false);
    });
    it('"no rollout found" は短い間隔で再試行し、通ったらやめる', async () => {
      let n = 0;
      rpc.answer = (m) => {
        if (m !== 'thread/resume') return {};
        if (++n < 4) throw new CodexRpcError(-32600, 'no rollout found for thread id x');
        return { thread: { id: T } };
      };
      mk({ subscribed: false });
      rpc.emit('thread/status/changed', status('active', []));
      await until(() => n >= 4);
      await sleep(40);
      expect(n).toBe(4);
    });
    it('ほかの失敗は再試行しない', async () => {
      let n = 0;
      rpc.answer = (m) => { if (m === 'thread/resume') { n++; throw new CodexRpcError(-32603, 'boom'); } return {}; };
      mk({ subscribed: false });
      rpc.emit('thread/status/changed', status('active', []));
      await sleep(60);
      expect(n).toBe(1);
    });
    it('再試行の途中で接続が閉じたらやめる', async () => {
      let n = 0;
      rpc.answer = (m) => { if (m === 'thread/resume') { n++; throw new CodexRpcError(-32600, 'no rollout found'); } return {}; };
      mk({ subscribed: false, subscribeDelaysMs: [20] });
      rpc.emit('thread/status/changed', status('active', []));
      await until(() => n >= 1);
      rpc.close();
      const at = n;
      await sleep(80);
      expect(n).toBeLessThanOrEqual(at + 1);
    });
  });
});

describe('偽の codex の app-server に対して', () => {
  let dir: string;
  let work: string;
  const servers: AppServerProcess[] = [];
  const rpcs: CodexRpc[] = [];
  const sockets: WebSocket[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxlv-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cxlw-'));
  });
  afterEach(async () => {
    for (const w of sockets.splice(0)) w.close();
    for (const r of rpcs.splice(0)) r.close();
    for (const s of servers.splice(0)) await stopAppServer(s, { graceMs: 500 });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  async function boot(): Promise<{ s: AppServerProcess; rpc: CodexRpc }> {
    const bin = writeFakeCodex(path.join(dir, 'bin'));
    const s = await startAppServer({ bin, env: codexBaseEnv(bin), directory: work, tokenDir: path.join(dir, 'tok') });
    servers.push(s);
    const rpc = await CodexRpc.connect({ url: s.url, token: s.token });
    rpcs.push(rpc);
    return { s, rpc };
  }
  /** 実物の TUI の代わり。承認の要求に答える（hangar の接続は答えない）。 */
  async function tui(s: AppServerProcess, query = ''): Promise<{ ws: WebSocket; send: (o: object) => void; msgs: { id?: number; method?: string; params?: unknown }[] }> {
    const ws = new WebSocket(`${s.url}/${query}`, { headers: { authorization: `Bearer ${s.token}` } });
    sockets.push(ws);
    const msgs: { id?: number; method?: string; params?: unknown }[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
    const send = (o: object): void => ws.send(JSON.stringify(o));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'tui', version: '0' } } });
    return { ws, send, msgs };
  }

  it('hangar が作ったスレッドは、ターンの間だけ作業中。完了で休みに戻る', async () => {
    const { s, rpc } = await boot();
    const { live } = createCodexLive();
    const t = await rpc.threadStart({ cwd: work });
    live.track({ providerSessionId: t.thread.id, cwd: work, pid: s.pid, rpc, subscribed: true });
    const seen: string[] = [];
    live.onChange((l) => seen.push(l[0]?.status ?? 'none'));
    await rpc.turnStart({ threadId: t.thread.id, input: [{ type: 'text', text: 'hello' }] });
    await until(() => seen.includes('idle'));
    expect(seen).toEqual(['busy', 'idle']);
  });

  it('承認の要求は TUI の応答で解かれ、hangar の接続は答えないまま写しから消える', async () => {
    const { s, rpc } = await boot();
    const { live, asks } = createCodexLive();
    const asked: AgentAsk[] = [];
    asks.subscribe!((a) => asked.push(a));
    const t = await rpc.threadStart({ cwd: work });
    live.track({ providerSessionId: t.thread.id, cwd: work, pid: s.pid, rpc, subscribed: true });
    const u = await tui(s);
    await rpc.turnStart({ threadId: t.thread.id, input: [{ type: 'text', text: 'ask:command' }] });
    await until(() => live.current()[0]?.permission !== undefined);
    expect(live.current()[0]).toMatchObject({ status: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'rm -rf build', description: 'needs write' } });
    await sleep(150);
    expect(live.current()[0]?.status).toBe('waiting'); // hangar の接続は答えない。TUI が答えるまで待ち続ける。
    expect(asked).toHaveLength(1);
    u.send({ id: 101, result: { decision: 'accept' } });
    await until(() => live.current()[0]?.status === 'busy' || live.current()[0]?.status === 'idle');
    await until(() => live.current()[0]?.status === 'idle');
    expect(live.current()[0]?.permission).toBeUndefined();
  });

  it('質問（requestUserInput）も同じ。解かれたら answered を流す', async () => {
    const { s, rpc } = await boot();
    const { live, asks } = createCodexLive();
    const asked: AgentAsk[] = [];
    asks.subscribe!((a) => asked.push(a));
    const t = await rpc.threadStart({ cwd: work });
    live.track({ providerSessionId: t.thread.id, cwd: work, pid: s.pid, rpc, subscribed: true });
    const u = await tui(s);
    await rpc.turnStart({ threadId: t.thread.id, input: [{ type: 'text', text: 'ask:input' }] });
    await until(() => asked.length === 1);
    expect(live.current()[0]).toMatchObject({ status: 'waiting', waitingFor: 'question' });
    expect(asked[0]).toMatchObject({ kind: 'question', hook: { kind: 'asked', summary: 'Which one?' } });
    u.send({ id: 101, result: { answers: {} } });
    await until(() => asked.length === 2);
    expect(asked[1]).toMatchObject({ kind: 'question', hook: { kind: 'answered' } });
  });

  it('TUI が作ったスレッドは、最初の active で購読し、承認の要求の中身が取れる', async () => {
    const { s, rpc } = await boot();
    const { live } = createCodexLive({ subscribeDelaysMs: [10] });
    const u = await tui(s, '?tui=1&cwd=' + encodeURIComponent(work));
    await until(() => u.msgs.some((m) => m.method === 'thread/started'));
    const id = (u.msgs.find((m) => m.method === 'thread/started')!.params as { thread: { id: string } }).thread.id;
    live.track({ providerSessionId: id, cwd: work, pid: s.pid, rpc, subscribed: false });
    u.send({ id: 2, method: 'turn/start', params: { threadId: id, input: [{ type: 'text', text: 'ask:file' }] } });
    await until(() => live.current()[0]?.permission?.tool === 'Edit');
    expect(live.current()[0]).toMatchObject({ status: 'waiting', permission: { tool: 'Edit', input: '/w/out' } });
    u.send({ id: 101, result: {} });
    await until(() => live.current()[0]?.status === 'idle');
  });

  it('作業中に app-server を止めると、行が消える（実行中が残らない）', async () => {
    const { s, rpc } = await boot();
    const { live } = createCodexLive();
    const t = await rpc.threadStart({ cwd: work });
    live.track({ providerSessionId: t.thread.id, cwd: work, pid: s.pid, rpc, subscribed: true });
    await rpc.turnStart({ threadId: t.thread.id, input: [{ type: 'text', text: 'hang' }] });
    await until(() => live.current()[0]?.status === 'busy');
    await stopAppServer(s, { graceMs: 500 });
    await until(() => live.current().length === 0);
    expect(live.isRunning(t.thread.id, s.pid)).toBe(false);
  });
});
