import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { findCodex } from '../src/config/tools.ts';
import { captureOutput, captureOutputSync } from '../src/platform/capture.ts';
import { codexBaseEnv } from '../src/provider/codex/env.ts';

/**
 * 本物の codex を、ログイン無し・モデル無しで動かす道具（docs/design.md「Codex の互換の見張り」）。
 * 照合の試験（codexLive.test.ts）と見本を採る台本（capture-codex/run.ts）が使う。
 * codex は空の環境（codexBaseEnv）と、試しの置き場（HOME と CODEX_HOME を一時ディレクトリへ）で起こす。利用者の ~/.codex は読まず、書かない。
 * モデルは、手元に立てた Responses API の模擬（startMockLlm）で、決まった文を返す。ネットワークの先の OpenAI には届かない。
 */

export const CLI_TIMEOUT_MS = 60_000;
/** 模擬のプロバイダーを使う -c の組。 */
export const mockProviderArgs = (port: number): string[] => [
  '-c', 'model_provider=mock',
  '-c', `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port}/v1",env_key="MOCK_KEY",wire_api="responses"}`,
];

/** codex の場所。HANGAR_CODEX_BIN（絶対パス）か、hangar と同じ探し方（findCodex）。 */
export function codexBin(): string | null {
  const b = process.env.HANGAR_CODEX_BIN;
  return b && path.isAbsolute(b) ? b : findCodex();
}

export type CodexWorld = { root: string; home: string; codexHome: string; cwd: string; env: NodeJS.ProcessEnv };

/** 試しの置き場。codex の記録も設定も、この下に閉じる。 */
export function makeCodexWorld(bin: string, prefix = 'hangar-codex-live-'): CodexWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  const cwd = path.join(root, 'work');
  for (const d of [home, codexHome, cwd]) fs.mkdirSync(d, { recursive: true });
  const env = { ...codexBaseEnv(bin), HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, MOCK_KEY: 'dummy' };
  return { root, home, codexHome, cwd, env };
}

export const dropWorld = (w: CodexWorld): void => { fs.rmSync(w.root, { recursive: true, force: true }); };

export const codexVersionText = (bin: string, env: NodeJS.ProcessEnv): string => captureOutputSync(bin, ['--version'], { env, timeoutMs: CLI_TIMEOUT_MS }).stdout;
export const codexHelpText = (bin: string, env: NodeJS.ProcessEnv): string => captureOutputSync(bin, ['--help'], { env, timeoutMs: CLI_TIMEOUT_MS }).stdout;

/** app-server の JSON Schema の束を書き出して読む。 */
export function generateSchemaBundle(bin: string, w: CodexWorld): unknown {
  const out = path.join(w.root, 'schema');
  const r = captureOutputSync(bin, ['app-server', 'generate-json-schema', '--out', out], { env: w.env, cwd: w.cwd, timeoutMs: CLI_TIMEOUT_MS, stderr: true });
  if (r.code !== 0) throw new Error(`generate-json-schema が ${r.code} で終わりました：${r.stderr.slice(0, 300)}`);
  return JSON.parse(fs.readFileSync(path.join(out, 'codex_app_server_protocol.schemas.json'), 'utf8')) as unknown;
}

export type MockLlm = { port: number; requests: number; close(): Promise<void> };
export const PROMPT_TOOL = 'CALLTOOL please';
export const MOCK_REPLY = 'MOCK-REPLY';

/** Responses API の模擬。プロンプトに CALLTOOL があれば道具の呼び出しを 1 つ返し、次の要求で文を返して終わる。 */
export async function startMockLlm(): Promise<MockLlm> {
  const state = { n: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [], models: [] }));
        return;
      }
      state.n++;
      const n = state.n;
      // 要求の本文は zstd で圧縮されることがある。見るのは頭の語だけなので、読めたときだけ読む。
      const raw = Buffer.concat(chunks).toString('latin1');
      const wantTool = raw.includes('CALLTOOL') && !raw.includes('function_call_output');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 };
      ev('response.created', { response: { id: `resp_${n}` } });
      if (wantTool) {
        ev('response.output_item.done', { output_index: 0, item: { type: 'function_call', call_id: `call_${n}`, name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo hangar-live' }) } });
      } else {
        ev('response.output_item.added', { output_index: 0, item: { type: 'message', role: 'assistant', id: `msg_${n}`, content: [] } });
        ev('response.output_text.delta', { item_id: `msg_${n}`, output_index: 0, content_index: 0, delta: MOCK_REPLY });
        ev('response.output_item.done', { output_index: 0, item: { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: MOCK_REPLY }] } });
      }
      ev('response.completed', { response: { id: `resp_${n}`, usage } });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    get requests() { return state.n; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function rolloutFilesOf(codexHome: string): string[] {
  const root = path.join(codexHome, 'sessions');
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) found.push(p);
    }
  };
  walk(root);
  return found.sort();
}

/** 模擬のモデルで `codex exec` を 1 回走らせ、できた rollout を返す。モデルもログインも使わない。 */
export async function runMockExec(bin: string, w: CodexWorld, port: number, prompt: string): Promise<{ path: string; lines: unknown[]; stdout: string }> {
  // 模擬のモデルは同じプロセスにいる。同期で待つとイベントループが止まって答えられないので、非同期で待つ。
  const r = await captureOutput(bin, ['exec', '--skip-git-repo-check', ...mockProviderArgs(port), '-m', 'mock-model', prompt], {
    env: w.env, cwd: w.cwd, timeoutMs: CLI_TIMEOUT_MS * 2, stderr: true, stdin: '',
  });
  if (r.code !== 0) throw new Error(`codex exec が ${r.code} で終わりました：${r.stderr.slice(0, 400)}`);
  const files = rolloutFilesOf(w.codexHome);
  if (files.length === 0) throw new Error('rollout ができていません');
  const p = files[files.length - 1]!;
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
  return { path: p, lines, stdout: r.stdout };
}

/** app-server を標準入出力（JSON の行）で 1 本起こして話す。ログイン無し。 */
export class StdioRpc {
  private nextId = 1;
  private readonly pending = new Map<number, (m: { result?: unknown; error?: { code: number; message: string } }) => void>();
  readonly notifications: { method: string; params: unknown }[] = [];
  private buf = '';
  private readonly child: ChildProcess;

  constructor(bin: string, w: CodexWorld) {
    this.child = spawn(bin, ['app-server'], { env: w.env, cwd: w.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      const parts = this.buf.split('\n');
      this.buf = parts.pop() ?? '';
      for (const line of parts.filter(Boolean)) {
        let m: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
        try { m = JSON.parse(line); } catch { continue; }
        if (typeof m.id === 'number' && m.method === undefined) this.pending.get(m.id)?.(m);
        else if (m.method !== undefined && m.id === undefined) this.notifications.push({ method: m.method, params: m.params });
      }
    });
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} の答えが ${timeoutMs}ms 来ません`)), timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.child.stdin!.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  notify(method: string): void { this.child.stdin!.write(`${JSON.stringify({ method })}\n`); }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const done = new Promise<void>((r) => this.child.once('exit', () => r()));
    this.child.kill('SIGTERM');
    await Promise.race([done, new Promise<void>((r) => { setTimeout(() => { this.child.kill('SIGKILL'); r(); }, 5000); })]);
  }
}

const keysOf = (v: unknown): string[] => (typeof v === 'object' && v !== null ? Object.keys(v).sort() : []);

/**
 * app-server に、ログイン無しで話して、hangar が頼る答えの形を採る（キーの名前だけ。値は版や置き場で変わる）。
 * ターンが無い間は rollout が書かれないこと（thread/resume が no rollout found で断られること）も、B4 の再購読が頼る振る舞いなのでここで見る。
 */
export async function probeAppServer(bin: string, w: CodexWorld): Promise<Record<string, unknown>> {
  const rpc = new StdioRpc(bin, w);
  try {
    const init = await rpc.request('initialize', { clientInfo: { name: 'hangar-compat', version: '0' } });
    rpc.notify('initialized');
    const start = await rpc.request('thread/start', { cwd: w.cwd, ephemeral: false });
    const thread = (start.result as { thread?: { id?: string } } | undefined)?.thread;
    const id = thread?.id;
    if (typeof id !== 'string') throw new Error(`thread/start の答えに thread.id がありません：${JSON.stringify(start).slice(0, 300)}`);
    const deadline = Date.now() + 10_000;
    while (!rpc.notifications.some((n) => n.method === 'thread/started') && Date.now() < deadline) await new Promise((r) => { setTimeout(r, 50); });
    const started = rpc.notifications.find((n) => n.method === 'thread/started');
    const resume = await rpc.request('thread/resume', { threadId: id });
    const limits = await rpc.request('account/rateLimits/read');
    const mcp = await rpc.request('mcpServerStatus/list', {});
    return {
      initializeResultKeys: keysOf(init.result),
      threadStartResultKeys: keysOf(start.result),
      threadStartThreadKeys: keysOf(thread),
      threadStartedNotificationParamKeys: keysOf(started?.params),
      threadStartedNotificationThreadKeys: keysOf((started?.params as { thread?: unknown } | undefined)?.thread),
      noRolloutBeforeFirstTurn: { rolloutFiles: rolloutFilesOf(w.codexHome).length, resumeErrorCode: resume.error?.code ?? null, resumeSaysNoRollout: /no rollout found/.test(resume.error?.message ?? '') },
      rateLimitsReadWithoutLogin: { errorCode: limits.error?.code ?? null },
      mcpServerStatusListResultKeys: keysOf(mcp.result),
    };
  } finally {
    await rpc.stop();
  }
}
