import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { findOpencode } from '../src/config/tools.ts';
import { OPENAI_COMPATIBLE_PACKAGE } from '../src/provider/opencode/integration.ts';
import { hangarServeConfig } from '../src/provider/opencode/launch.ts';
import { opencodeProbeEnv } from '../src/provider/opencode/compat/version.ts';
import { authHeader, killGroup, startServe, type ServeProcess } from '../src/provider/opencode/serve/spawn.ts';

/**
 * 本物の opencode を、利用者の記録の置き場から切り離して 1 本だけ起こす道具。
 * 互換の見張り（opencodeLive.test.ts）と見本の採り直し（capture-opencode/run.ts）が同じものを使う。
 *
 * - LLM は呼ばない。OpenAI 互換の模擬（startMockLlm）を手元の 127.0.0.1 に立て、決まった並びで道具を呼ばせる。
 * - hangar の MCP の代わりに、同じ形で設定する小さな MCP（startMockMcp）を立てる。
 * - serve は空の環境（opencodeProbeEnv と同じ鍵）に、試しの置き場の `XDG_*_HOME` を足して起こす。
 *   利用者の `~/.config/opencode` と `~/.local/share/opencode` には触らないので、試しの会話は置き場ごと消せる。
 * - hangar の MCP は、hangar が serve に渡すのと同じ `OPENCODE_CONFIG_CONTENT`（launch.ts の hangarServeConfig）で渡す。
 */

/** 試しに打つ shell の命令。模擬の LLM が呼ぶ。 */
export const LIVE_ECHO = 'echo hangar-live';
/** 模擬の LLM が `question` で聞く問い。 */
export const LIVE_QUESTION = 'Which color do you prefer?';
/** 模擬の MCP の秘密。見本に残っていないかを見る網にも使う。 */
export const MOCK_MCP_SECRET = 'hangar-live-mcp-secret';

/** 利用者の発言の頭で、模擬の LLM の筋書きを選ぶ。 */
export const PROMPT_TURN = 'TURN: run echo, record the intent, write and edit a file, then ask me a question.';
export const PROMPT_SLEEP = 'SLEEP: run a long command.';
export const PROMPT_HI = 'HI: just say hi.';
/** 筋書きの頭。模擬の LLM は、これで始まる利用者の発言だけを筋書きの始まりと見る。 */
const SCENARIO_HEADS = ['TURN:', 'SLEEP:', 'HI:'];

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

export type MockServer = { url: string; requests: string[]; close(): Promise<void> };

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}
function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((r) => { server.close(() => r()); });
}
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * OpenAI 互換の模擬 LLM（`/v1/chat/completions` の SSE と `/v1/models`）。
 * 頭（TURN:、SLEEP:、HI:）の付いた最後の利用者の発言と、その後に返った道具の結果の数で、次の一手を決める。
 * 頭の無い利用者の発言（opencode がターンの途中に差し込む知らせ）は、筋書きの切れ目と見ない。
 * TURN：shell → execute（中で hangar.set_turn_intent）→ write → edit → read → question → 文。execute が無ければ飛ばす。
 * SLEEP：shell で `sleep 20` → 文。HI：文だけ。道具の無い要求（題名づけ）は短い文で答える。
 * chats は chat/completions の要求の本文で、システムプロンプトへの追記がモデルまで届いたかを見るのに使う。
 */
export async function startMockLlm(o: { repo: string }): Promise<MockServer & { chats: string[] }> {
  const requests: string[] = [];
  const chats: string[] = [];
  let n = 0;
  const base = (delta: Rec, finish: string | null = null) => ({ id: 'cmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] });
  const usage = (p: number, c: number) => ({ ...base({}), choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c, prompt_tokens_details: { cached_tokens: 4 } } });
  const text = (t: string, reasoning?: string) => [
    ...(reasoning ? [base({ role: 'assistant', reasoning_content: reasoning })] : []),
    base({ role: 'assistant', content: t }), base({}, 'stop'), usage(12, 5),
  ];
  const call = (name: string, args: unknown, reasoning?: string) => [
    ...(reasoning ? [base({ role: 'assistant', reasoning_content: reasoning })] : []),
    base({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${name}_${n}`, type: 'function', function: { name, arguments: '' } }] }),
    base({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }),
    base({}, 'tool_calls'),
    usage(10, 3),
  ];
  const userText = (m: Rec): string => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => (isRec(b) && typeof b.text === 'string' ? b.text : '')).join('') : '');
  const file = path.join(o.repo, 'notes.txt');
  const server = http.createServer((req, res) => {
    void readBody(req).then((raw) => {
      n++;
      requests.push(`${req.method} ${req.url}`);
      if (!req.url?.includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
        return;
      }
      chats.push(raw);
      const sse = (chunks: unknown[]) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };
      let body: Rec = {};
      try { body = JSON.parse(raw) as Rec; } catch { /* 空の本文は題名づけと同じに扱う */ }
      const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) => (isRec(t) && isRec(t.function) ? String(t.function.name) : ''));
      if (tools.length === 0) return sse(text('Mock title'));
      const msgs = (Array.isArray(body.messages) ? body.messages : []).filter(isRec);
      // 筋書きは、頭の付いた利用者の発言で選ぶ。opencode はターンの途中にも利用者の発言を差し込む
      // （hangar の MCP の道具が後から増えたときの「The Code Mode tool catalog has changed.」）ので、ただ最後の発言を見ると筋書きの頭に戻ってしまう。
      let lastUser = -1;
      msgs.forEach((m, k) => { if (m.role === 'user' && SCENARIO_HEADS.some((h) => userText(m).trimStart().startsWith(h))) lastUser = k; });
      const prompt = lastUser >= 0 ? userText(msgs[lastUser]!).trimStart() : '';
      const done = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
      const shell = tools.find((t) => t === 'shell' || t === 'bash') ?? 'shell';
      if (prompt.startsWith(PROMPT_SLEEP)) return sse(done === 0 ? call(shell, { command: 'sleep 20', description: 'Wait' }) : text('Woke up.'));
      if (prompt.startsWith(PROMPT_HI)) return sse(text('Hi.'));
      const plan: (() => unknown[])[] = [
        () => call(shell, { command: LIVE_ECHO, description: 'Print a word' }, 'I will run echo first.'),
        ...(tools.includes('execute') ? [() => call('execute', { code: 'await tools.hangar.set_turn_intent({ text: "Check the opencode API" });\nreturn "ok";' })] : []),
        () => call('write', { path: file, content: 'alpha\nbeta\n' }),
        () => call('edit', { path: file, oldString: 'beta', newString: 'gamma' }),
        () => call('read', { path: file }),
        () => call('question', { questions: [{ question: LIVE_QUESTION, header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] }),
        () => text('All done.', 'The user picked a color; wrap up.'),
      ];
      return sse((plan[done] ?? plan[plan.length - 1]!)());
    });
  });
  const url = await listen(server);
  return { url, requests, chats, close: () => closeServer(server) };
}

/**
 * hangar の MCP の代わり。Streamable HTTP の最小（JSON で答える）で、道具は set_turn_intent の 1 つ。
 * 認証の header が hangar の形（`Bearer <秘密>`）でなければ 401 を返す。calls は呼ばれた道具の名前と引数。
 */
export async function startMockMcp(): Promise<MockServer & { calls: { name: string; args: unknown }[] }> {
  const requests: string[] = [];
  const calls: { name: string; args: unknown }[] = [];
  const server = http.createServer((req, res) => {
    void readBody(req).then((raw) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${MOCK_MCP_SECRET}`) { res.writeHead(401).end(); return; }
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let msg: Rec = {};
      try { msg = JSON.parse(raw) as Rec; } catch { res.writeHead(400).end(); return; }
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mock-mcp' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      const params = isRec(msg.params) ? msg.params : {};
      switch (msg.method) {
        case 'initialize':
          return reply({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hangar', version: '0.0.0' } });
        case 'tools/list':
          return reply({ tools: [{ name: 'set_turn_intent', description: 'Record what this turn is about.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
        case 'tools/call':
          calls.push({ name: String(params.name), args: params.arguments });
          return reply({ content: [{ type: 'text', text: 'ok' }] });
        default:
          return reply({});
      }
    });
  });
  const url = await listen(server);
  return { url: `${url}/mcp`, requests, calls, close: () => closeServer(server) };
}

/** 試しの置き場。root の下に XDG の 4 つと作業のフォルダ（repo、シンボリックリンクを解いた形）を作る。 */
export type LiveWorld = { root: string; repo: string; xdg: { config: string; data: string; state: string; cache: string } };

export function makeWorld(prefix = 'hangar-opencode-live-'): LiveWorld {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const xdg = { config: path.join(root, 'config'), data: path.join(root, 'data'), state: path.join(root, 'state'), cache: path.join(root, 'cache') };
  for (const d of Object.values(xdg)) fs.mkdirSync(d, { recursive: true });
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  return { root, repo, xdg };
}

/**
 * 利用者の設定（`$XDG_CONFIG_HOME/opencode/opencode.json`）の代わり。模擬の LLM をプロバイダーに置き、shell だけ許可を聞かせる。
 * hangar の MCP はここに書かず、hangar と同じく serve の環境（OPENCODE_CONFIG_CONTENT）で足す。
 */
export function writeUserConfig(w: LiveWorld, llmUrl: string): void {
  const dir = path.join(w.xdg.config, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      mock: {
        npm: OPENAI_COMPATIBLE_PACKAGE,
        name: 'Mock',
        options: { baseURL: `${llmUrl}/v1`, apiKey: 'dummy' },
        models: { mock: { name: 'Mock', limit: { context: 65536, output: 4096 }, reasoning: true, interleaved: { field: 'reasoning_content' } } },
      },
    },
    model: 'mock/mock',
    small_model: 'mock/mock',
    permission: { shell: 'ask', bash: 'ask', edit: 'allow', write: 'allow' },
    share: 'disabled',
    autoupdate: false,
  }, null, 2));
}

/** opencode の場所。HANGAR_OPENCODE_BIN（絶対パス）か、hangar と同じ探し方（findOpencode）。空の環境の PATH の先頭に置き場を足すため、絶対パスで返す。 */
export function opencodeBin(): string | null {
  const b = process.env.HANGAR_OPENCODE_BIN;
  return b && path.isAbsolute(b) ? b : findOpencode();
}

/** 空の環境に試しの置き場を足したもの。serve と CLI の両方に使う。 */
export function liveEnv(bin: string, w: LiveWorld): NodeJS.ProcessEnv {
  return {
    ...opencodeProbeEnv(bin, process.env),
    XDG_CONFIG_HOME: w.xdg.config, XDG_DATA_HOME: w.xdg.data, XDG_STATE_HOME: w.xdg.state, XDG_CACHE_HOME: w.xdg.cache,
  };
}

/** serve を 1 本起こす。hangar の MCP は hangar と同じ形で渡す。 */
export function startLiveServe(bin: string, w: LiveWorld, mcpUrl: string): Promise<ServeProcess> {
  return startServe({ bin, env: { ...liveEnv(bin, w), OPENCODE_CONFIG_CONTENT: hangarServeConfig({ url: mcpUrl, secret: MOCK_MCP_SECRET }) }, readyTimeoutMs: 60_000 });
}

/** serve を止める。プロセスの組ごと SIGTERM を送り、5 秒で終わらなければ SIGKILL。 */
export async function stopLiveServe(s: ServeProcess): Promise<void> {
  killGroup(s.pid, 'SIGTERM');
  const ended = await Promise.race([s.exited.then(() => true), sleep(5_000).then(() => false)]);
  if (!ended) {
    killGroup(s.pid, 'SIGKILL');
    await Promise.race([s.exited, sleep(2_000)]);
  }
}

/** serve に 1 回頼む（hangar の包みに無い道：発言、許可と form への答え、interrupt）。答えは JSON を読んで返す。 */
export async function serveApi(s: { url: string; password: string }, method: string, p: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(s.url + p, {
    method,
    headers: { authorization: authHeader(s.password), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const t = await r.text();
  let parsed: unknown = t;
  try { parsed = t ? JSON.parse(t) : null; } catch { /* 文のまま返す */ }
  return { status: r.status, body: parsed };
}

/** 出来事の 1 件。raw は `data: …` の行を含むフレームの全文（区切りの空行は除く）。 */
export type LiveEvent = { type: string; data: unknown; sessionID: string | null; raw: string };

/**
 * `/api/event` を読み続ける。frames は heartbeat も含む生の全フレーム（見本に書く）、events は data の読めたもの。
 * waitFor は条件に合う出来事が来るまで待つ（来ていれば即座に返す）。
 */
export type EventTap = {
  frames: string[];
  events: LiveEvent[];
  waitFor(pred: (e: LiveEvent) => boolean, timeoutMs?: number): Promise<LiveEvent>;
  close(): Promise<void>;
};

export function tapEvents(open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>): Promise<EventTap> {
  const ac = new AbortController();
  const frames: string[] = [];
  const events: LiveEvent[] = [];
  const waiters = new Set<() => void>();
  const kick = () => { for (const w of [...waiters]) w(); };
  return open(ac.signal).then((stream) => {
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
          let k: number;
          while ((k = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, k);
            buf = buf.slice(k + 2);
            frames.push(frame);
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try {
              const v = JSON.parse(data) as Rec;
              const d = isRec(v.data) ? v.data : null;
              events.push({ type: String(v.type), data: v.data, sessionID: d && typeof d.sessionID === 'string' ? d.sessionID : null, raw: frame });
              kick();
            } catch { /* 読めないフレームは frames にだけ残す */ }
          }
        }
      } catch { /* 切ったときと serve が止まったとき */ }
    })();
    return {
      frames, events,
      waitFor(pred, timeoutMs = 30_000) {
        const hit = events.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise<LiveEvent>((resolve, reject) => {
          const check = () => {
            const e = events.find(pred);
            if (!e) return;
            waiters.delete(check); clearTimeout(timer); resolve(e);
          };
          const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`event did not arrive within ${timeoutMs}ms (seen: ${[...new Set(events.map((e) => e.type))].join(', ')})`)); }, timeoutMs);
          waiters.add(check);
        });
      },
      async close() { ac.abort(); await pump; },
    };
  });
}

/** 条件が真になるまで聞き直す。上限を過ぎたら最後の値で投げる。 */
export async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 30_000, pollMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms (last: ${JSON.stringify(v).slice(0, 300)})`);
    await sleep(pollMs);
  }
}

/** opencode の CLI を空の環境で 1 回起こす。password を渡すと OPENCODE_PASSWORD に入れる（argv には載せない）。 */
export function runCli(bin: string, args: string[], env: NodeJS.ProcessEnv, o: { password?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...env, ...(o.password ? { OPENCODE_PASSWORD: o.password } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 60_000);
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
