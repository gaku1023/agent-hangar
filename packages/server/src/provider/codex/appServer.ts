import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { needsShell } from '../../platform/exec.ts';
import { killGroup, pickFreePort, ServeStartError, SERVE_HOST } from '../opencode/serve/spawn.ts';

/**
 * `codex app-server` を 1 本起こし、JSON-RPC（WebSocket）でつなぐ（計画の B2、B2-PROBE.md）。
 *
 * - 待ち受けは 127.0.0.1 の WebSocket と `--ws-auth capability-token`。token は起動ごとに 32 バイトの乱数で、0600 のファイルに書いて `--ws-token-file` で渡す。
 *   argv にも app-server の環境にも載せない。TUI には環境変数の名前（`--remote-auth-token-env`）で渡し、値は TUI の環境に足す。
 *   env -i から起こすので、TUI の環境へ token を明示で足さないと消える（B2-PROBE D）。
 * - フォルダの信頼の画面は、app-server の起動時の `-c projects=…` で消す（`--remote` の TUI 側の `-c` は効かない）。
 * - daemon は起きない。旗は付けない。
 * - 止め方は、呼び手が TUI を先に閉じる前提で、app-server に SIGTERM、猶予のあと SIGKILL。孫（シェルの子、code mode の host）は SIGTERM で全部消える。
 *   interrupt だけでは孫が残るので、「止める」は app-server ごとにする。
 */

export const APP_SERVER_HOST = SERVE_HOST;
/** TUI に token を渡す環境変数の名前。 */
export const TUI_TOKEN_ENV = 'HANGAR_CODEX_TOKEN';
/** 応答の確かめに使う GET。token 無しで 200 を返す。 */
export const HEALTH_PATH = '/healthz';

export function newAppServerToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** TOML の基本文字列（JSON の文字列の記法で足りる）。 */
function toml(s: string): string {
  return JSON.stringify(s);
}

/** `-c projects={"<パス>"={trust_level="trusted"}}`。インラインテーブルで渡す。 */
export function trustedProjectsConfig(dirs: readonly string[]): string {
  return `projects={${dirs.map((d) => `${toml(d)}={trust_level="trusted"}`).join(',')}}`;
}

/**
 * cmd.exe 越し（.cmd の shim）に渡す 1 語。`shell: true` は語を空白でつなぐだけなので、" を含む語（TOML の `-c`）は自分で包む。
 * CRT の規則（" の前の \ は 2 倍、" は \"、末尾の \ は 2 倍）で包み、% は cmd に展開させない。
 */
export function winCmdArg(s: string): string {
  const body = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/%/g, '"^%"');
  return `"${body}"`;
}

export type AppServerArgsInput = {
  port: number;
  tokenFile: string;
  /** 信頼済みにするフォルダ（会話のフォルダ）。 */
  trustedDirs: readonly string[];
  /** 足す `-c key=value`（`developer_instructions="…"`、`model_reasoning_effort="low"` など。値は TOML のまま）。 */
  config?: readonly string[];
};

export function appServerArgs(i: AppServerArgsInput): string[] {
  const args = ['app-server', '--listen', `ws://${APP_SERVER_HOST}:${i.port}`, '--ws-auth', 'capability-token', '--ws-token-file', i.tokenFile];
  if (i.trustedDirs.length > 0) args.push('-c', trustedProjectsConfig(i.trustedDirs));
  for (const c of i.config ?? []) args.push('-c', c);
  return args;
}

/** TUI を `--remote` でつなぐための argv の追加分と環境変数。token の値は env にだけ載せる（secretEnv として扱う）。 */
export function tuiRemote(url: string, token: string): { args: string[]; env: Record<string, string> } {
  return { args: ['--remote', url, '--remote-auth-token-env', TUI_TOKEN_ENV], env: { [TUI_TOKEN_ENV]: token } };
}

// ---- JSON-RPC の型 ----

export type CodexThread = {
  id: string;
  sessionId?: string;
  ephemeral?: boolean;
  cwd?: string | null;
  path?: string | null;
  environments?: { cwd?: string | null }[];
  [k: string]: unknown;
};
export type CodexThreadStatus = { type: 'idle' | 'notLoaded' | 'systemError' | 'active' | string; activeFlags?: string[] };
export type CodexTurn = { id: string; status?: string; [k: string]: unknown };

/** 型を付けて購読できる通知。ここに無い通知は `onAny` で生のまま受ける。 */
export type CodexEventMap = {
  'thread/started': { thread: CodexThread };
  'thread/status/changed': { threadId: string; status: CodexThreadStatus };
  'thread/name/updated': { threadId: string; threadName?: string | null };
  'turn/started': { threadId: string; turn: CodexTurn };
  'turn/completed': { threadId: string; turn: CodexTurn };
};
export type CodexEventName = keyof CodexEventMap;

/** サーバからの要求（承認など）。hangar の接続は答えない（TUI が答える）。 */
export type CodexServerRequest = { id: string | number; method: string; params: unknown };
export type CodexNotification = { method: string; params: unknown };

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'on-request' | 'never';

export type ThreadStartParams = {
  cwd: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  developerInstructions?: string;
  config?: Record<string, unknown>;
};
export type ThreadResumeParams = { threadId: string; excludeTurns?: boolean; cwd?: string; model?: string; approvalPolicy?: ApprovalPolicy; sandbox?: SandboxMode };
export type TurnInput = { type: 'text'; text: string; text_elements?: unknown[] };
export type TurnStartParams = { threadId: string; input: TurnInput[]; effort?: string; model?: string };

export const CLIENT_INFO = { name: 'agent-hangar', title: 'Agent Hangar', version: '0' } as const;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * app-server への WebSocket の接続 1 本。要求と応答、通知の購読を持つ。
 * 承認などのサーバからの要求は `onServerRequest` で見られるが、答える口は作らない（決定 5）。
 */
export class CodexRpc {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly typed = new Map<string, Set<(p: unknown) => void>>();
  private readonly anyHandlers = new Set<(n: CodexNotification) => void>();
  private readonly requestHandlers = new Set<(r: CodexServerRequest) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  private constructor(private readonly ws: WebSocket, private readonly requestTimeoutMs: number) {
    ws.on('message', (data) => this.onMessage(data.toString('utf8')));
    ws.on('close', () => this.onClose());
    ws.on('error', () => undefined);
  }

  /** つないで `initialize` と `initialized` まで済ませる。 */
  static async connect(o: { url: string; token: string; headers?: Record<string, string>; connectTimeoutMs?: number; requestTimeoutMs?: number }): Promise<CodexRpc> {
    const ws = new WebSocket(o.url, { headers: { authorization: `Bearer ${o.token}`, ...(o.headers ?? {}) }, handshakeTimeout: o.connectTimeoutMs ?? 5000 });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`app-server refused the connection: HTTP ${res.statusCode}`)));
    });
    const rpc = new CodexRpc(ws, o.requestTimeoutMs ?? 30_000);
    try {
      await rpc.request('initialize', { clientInfo: CLIENT_INFO });
      rpc.notify('initialized');
    } catch (e) {
      rpc.close();
      throw e;
    }
    return rpc;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('app-server connection is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }));
  }

  /** 型つきの購読。外すための関数を返す。 */
  on<M extends CodexEventName>(method: M, handler: (params: CodexEventMap[M]) => void): () => void {
    let set = this.typed.get(method);
    if (!set) this.typed.set(method, (set = new Set()));
    set.add(handler as (p: unknown) => void);
    return () => set.delete(handler as (p: unknown) => void);
  }

  /** 通知を全部、生のまま受ける。 */
  onAny(handler: (n: CodexNotification) => void): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  onServerRequest(handler: (r: CodexServerRequest) => void): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  onClose(handler?: () => void): void {
    if (handler) {
      if (this.closed) handler();
      else this.closeHandlers.add(handler);
      return;
    }
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('app-server connection closed'));
      this.pending.delete(id);
    }
    for (const h of [...this.closeHandlers]) h();
    this.closeHandlers.clear();
  }

  close(): void {
    try { this.ws.close(); } catch { /* 閉じ済み */ }
    this.onClose();
  }

  // ---- 薄い口 ----

  threadStart(p: ThreadStartParams): Promise<{ thread: CodexThread; [k: string]: unknown }> {
    return this.request('thread/start', p);
  }
  threadResume(p: ThreadResumeParams): Promise<{ thread: CodexThread; [k: string]: unknown }> {
    return this.request('thread/resume', p);
  }
  turnStart(p: TurnStartParams): Promise<{ turn: CodexTurn }> {
    return this.request('turn/start', p);
  }
  turnInterrupt(threadId: string, turnId: string): Promise<unknown> {
    return this.request('turn/interrupt', { threadId, turnId });
  }
  /** 読み込み済みのスレッドの ID（接続し直したとき用の補い）。 */
  async threadLoadedList(): Promise<string[]> {
    const r = await this.request<{ data?: string[] }>('thread/loaded/list', {});
    return r.data ?? [];
  }

  private onMessage(text: string): void {
    let m: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try { m = JSON.parse(text); } catch { return; }
    if (m.method !== undefined) {
      if (m.id !== undefined) {
        for (const h of [...this.requestHandlers]) h({ id: m.id, method: m.method, params: m.params });
        return;
      }
      for (const h of [...(this.typed.get(m.method) ?? [])]) h(m.params);
      for (const h of [...this.anyHandlers]) h({ method: m.method, params: m.params });
      return;
    }
    if (typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new CodexRpcError(m.error.code, m.error.message, m.error.data));
    else p.resolve(m.result);
  }
}

// ---- 初期プロンプトが無いときの ID の拾い方 ----

function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let r = p;
    try { r = fs.realpathSync(p); } catch { /* 無ければそのまま */ }
    return path.resolve(r).replace(/[\\/]+$/, '');
  };
  return norm(a) === norm(b);
}

export function threadCwd(t: CodexThread): string | null {
  return t.environments?.[0]?.cwd ?? t.cwd ?? null;
}

/**
 * `thread/started` のうち `ephemeral:false` のものだけを採る（題名の生成用の ephemeral は採らない）。
 * TUI をつなぐ前に作り、TUI を起こしてから待つ（通知は TUI がつないだ時点で全接続へ来る。後から作ると取り逃す）。
 * cwd を渡すと、スレッドの cwd がそれと同じものだけを採る（複数のセッションを同時に起こしたときの取り違え対策）。cwd の分からないスレッドは採る。
 */
export function watchStartedThread(rpc: CodexRpc, o: { cwd?: string; timeoutMs?: number } = {}): { promise: Promise<CodexThread>; cancel: () => void } {
  let off: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  let fail: (e: Error) => void = () => undefined;
  const promise = new Promise<CodexThread>((resolve, reject) => {
    fail = reject;
    off = rpc.on('thread/started', ({ thread }) => {
      if (thread.ephemeral !== false) return;
      const c = threadCwd(thread);
      if (o.cwd && c && !sameDir(o.cwd, c)) return;
      off();
      if (timer) clearTimeout(timer);
      resolve(thread);
    });
    timer = setTimeout(() => { off(); reject(new Error('timed out waiting for thread/started')); }, o.timeoutMs ?? 30_000);
    timer.unref?.();
  });
  return { promise, cancel: () => { off(); if (timer) clearTimeout(timer); fail(new Error('cancelled')); } };
}

// ---- 起動と停止 ----

export type AppServerProcess = {
  pid: number;
  port: number;
  url: string;
  token: string;
  tokenFile: string;
  startedAt: number;
  child: ChildProcess;
  exited: Promise<void>;
};

export type StartAppServerOptions = {
  bin: string;
  /** 空の環境（`codexBaseEnv`）。 */
  env: NodeJS.ProcessEnv;
  /** 作業フォルダ（会話のフォルダ）。信頼済みにもする。 */
  directory: string;
  config?: readonly string[];
  /** token のファイルを置くフォルダ。省くと OS の一時フォルダに 0700 で作る。 */
  tokenDir?: string;
  pickPort?: () => Promise<number>;
  portAttempts?: number;
  readyTimeoutMs?: number;
  pollMs?: number;
};

const PORT_IN_USE = /EADDRINUSE|address already in use|in use/i;
const TAIL_BYTES = 8192;

/** app-server を起こし、`/healthz` が 200 を返すまで待つ。ポートが塞がっていたら取り直す。失敗は ServeStartError。 */
export async function startAppServer(o: StartAppServerOptions): Promise<AppServerProcess> {
  const token = newAppServerToken();
  const dir = o.tokenDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cx-'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(dir, `cx-${crypto.randomBytes(6).toString('hex')}.token`);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const attempts = o.portAttempts ?? 5;
  try {
    for (let i = 0; ; i++) {
      const port = await (o.pickPort ?? pickFreePort)();
      try {
        return await launchOnce(o, port, token, tokenFile);
      } catch (e) {
        if (e instanceof ServeStartError && e.reason === 'port-in-use' && i + 1 < attempts) continue;
        throw e;
      }
    }
  } catch (e) {
    removeTokenFile(tokenFile);
    throw e;
  }
}

export function removeTokenFile(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* 無ければ良い */ }
}

async function launchOnce(o: StartAppServerOptions, port: number, token: string, tokenFile: string): Promise<AppServerProcess> {
  const url = `ws://${APP_SERVER_HOST}:${port}`;
  const startedAt = Date.now();
  const viaShell = needsShell(o.bin);
  const args = appServerArgs({ port, tokenFile, trustedDirs: [o.directory], config: o.config });
  const child = spawn(viaShell ? `"${o.bin}"` : o.bin, viaShell ? args.map(winCmdArg) : args, {
    cwd: o.directory,
    env: o.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: viaShell,
  });
  let tail = '';
  const keep = (b: Buffer): void => { tail = (tail + b.toString('utf8')).slice(-TAIL_BYTES); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let gone = false;
  let spawnError: Error | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => { gone = true; resolve(); });
    child.once('error', (e) => {
      spawnError = e;
      if (child.pid === undefined) { gone = true; resolve(); }
    });
  });
  const why = (): string => tail.split(token).join('***').trim().slice(-500);
  const pollMs = o.pollMs ?? 100;
  const deadline = Date.now() + (o.readyTimeoutMs ?? 20_000);
  for (;;) {
    if (gone) {
      if (spawnError) throw new ServeStartError('spawn', `codex app-server could not start: ${(spawnError as Error).message}`);
      const out = why();
      const reason = PORT_IN_USE.test(out) ? 'port-in-use' : 'exited';
      throw new ServeStartError(reason, `codex app-server exited before it answered (${reason}): ${out}`);
    }
    if (Date.now() > deadline) {
      if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
      await exited;
      throw new ServeStartError('timeout', `codex app-server did not answer within the time limit: ${why()}`);
    }
    try {
      const r = await fetch(`http://${APP_SERVER_HOST}:${port}${HEALTH_PATH}`, { signal: AbortSignal.timeout(1000) });
      await r.arrayBuffer().catch(() => undefined);
      if (r.status === 200 && child.pid !== undefined && !gone) return { pid: child.pid, port, url, token, tokenFile, startedAt, child, exited };
    } catch {
      // まだ待ち受けていない。
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, pollMs))]);
  }
}

export type StopAppServerOptions = {
  /** SIGTERM のあと SIGKILL までの猶予。B2-PROBE では 5 秒以内に孫まで消えた。 */
  graceMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
};

/**
 * app-server を止める。呼び手は先に TUI を閉じておく（app-server だけ先に止めると TUI が「Reconnecting to server…」で居残る）。
 * SIGTERM を（孫ごとプロセスのまとまりへ）送り、猶予のうちに終わらなければ SIGKILL。Windows は killGroup が木ごと強制で止める。
 */
export async function stopAppServer(p: AppServerProcess, o: StopAppServerOptions = {}): Promise<void> {
  const kill = o.kill ?? ((pid, sig) => killGroup(pid, sig));
  kill(p.pid, 'SIGTERM');
  const done = await Promise.race([p.exited.then(() => true), new Promise<boolean>((r) => { const t = setTimeout(() => r(false), o.graceMs ?? 5000); t.unref?.(); })]);
  if (!done) {
    kill(p.pid, 'SIGKILL');
    await p.exited;
  }
  // 頭が終わっても、まとまりの中に孫が残っていることがある。残りがあれば SIGKILL を重ねる（居なければ何も起きない）。
  kill(p.pid, 'SIGKILL');
  removeTokenFile(p.tokenFile);
}
