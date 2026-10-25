import fs from 'node:fs';
import path from 'node:path';
import { writeFakeNodeTool } from './fake-bin.ts';

/**
 * 実物の opencode の代わり（serve のふりだけ）。
 * `serve --hostname H --port P` で起こされると、`OPENCODE_SERVER_PASSWORD` を basic 認証（ユーザー名は opencode）に使う最小の HTTP を立てる。
 * 認証つきの `GET /api/session/active` に 200、認証が無ければ 401、`POST /api/session/{id}/interrupt` を受ける。
 * 起動の面（materialize）のために、`POST /api/session`（ID を opencode が振る）、指示の `PUT …/instructions/entries/{key}`、
 * MCP の状態の `GET /api/mcp?location[directory]=…` も受ける。本文の `GET /api/session/{id}/message` は空の一覧を答える（写しの試験は test/fake-opencode-events.ts で行う）。MCP の一覧は、起こされたときの `OPENCODE_CONFIG_CONTENT` の `mcp.servers` から作る。
 * 新しいセッションの選択肢のために、`GET /api/agent`、`/api/model`、`/api/provider`（どれも `location[directory]=…` を受け、`{ location, data }` で答える）と、
 * 設定の層の配列を返す `GET /api/config` も受ける。実物の 2.1.4 と同じく、場所ごとの最初の `/api/agent` は空の一覧を返せる（agentsEmptyFirst）。
 *
 * 起動から止まるまでの出来事を、1 行 1 件の JSON で logFile に書く。
 * - `start`：pid、argv、環境変数の全部、時刻。
 * - `ready`：待ち受けを始めた時刻。
 * - `interrupt`：受けた会話の ID。
 * - `create`：`POST /api/session` の本文と、振った ID。
 * - `instructions`：指示の PUT の会話の ID、鍵、本文。
 * - `mcp`：MCP の状態を聞かれた場所（directory）と、答えた状態。
 * - `list`：一覧の道（agent、model、provider、config）と、聞かれた場所（directory）。
 * - `term`：SIGTERM を受けた。
 * - `exit`：自分から終わった理由。
 *
 * 実物と同じく、ほかの 1 本が起動の途中（`starting` の印がある間）に起こされると、`database is locked` で落ちる。
 * 待ち受けのポートが塞がっていれば、実物と同じ文で落ちる。
 */
export type FakeOpencodeOptions = {
  /** 起動から待ち受けまでの間。起動の重なりを試験で見えるようにする。 */
  startDelayMs?: number;
  /** 最初の n 回の起動を `database is locked` で落とす。 */
  failLockTimes?: number;
  /** SIGTERM を無視する（SIGKILL まで残るふり）。 */
  ignoreTerm?: boolean;
  /** `GET /api/session/active` に載せる会話の ID。 */
  activeIds?: string[];
  /** `POST /api/session` を 500 で断る。 */
  failCreate?: boolean;
  /** 指示の PUT に返す状態（既定は 200）。API が消えた版のふりに 404 を使う。 */
  instructionsStatus?: number;
  /** MCP の状態。既定は pendingPolls 回だけ pending と答えてから connected。never はずっと pending、failed は failed。 */
  mcp?: 'connect' | 'never' | 'failed';
  /** connected と答えるまでに pending と答える回数。 */
  mcpPendingPolls?: number;
  /** `GET /api/agent` の一覧。既定は build・plan（primary）、general（subagent）、title（隠れた primary）。 */
  agents?: { id: string; mode: string; hidden?: boolean; description?: string }[];
  /**
   * `GET /api/model` の一覧。既定は OpenCode の無料のもの 1 つと LM Studio の 2 つ。
   * tools は capabilities.tools（省けば true）、cost は実物と同じ段の配列（省けば載せない）、limit は上限（省けば載せない）。
   */
  models?: { providerID: string; id: string; name: string; enabled?: boolean; tools?: boolean; cost?: { input: number; output: number }[]; limit?: { context?: number; output?: number } }[];
  /** `GET /api/provider` の一覧。既定は opencode（OpenCode）と lmstudio（LM Studio (local)）。baseURL は settings.baseURL に載せる（apiKey も偽の値で載せる）。 */
  providers?: { id: string; name: string; baseURL?: string }[];
  /** `GET /api/config` の opencode.json の既定のモデル。null なら書いていない。既定は lmstudio/qwen3-coder-30b。 */
  configModel?: { providerID: string; model: string } | null;
  /** 場所ごとの最初の `GET /api/agent` に空の一覧を返す（実物の 2.1.4 の振る舞い）。 */
  agentsEmptyFirst?: boolean;
  /** 一覧の道を 500 で断る。 */
  failLists?: boolean;
};

export const FAKE_OPENCODE_AGENTS: NonNullable<FakeOpencodeOptions['agents']> = [
  { id: 'build', mode: 'primary', description: 'The default agent.' },
  { id: 'general', mode: 'subagent', description: 'General-purpose agent.' },
  { id: 'title', mode: 'primary', hidden: true },
  { id: 'plan', mode: 'primary', description: 'Plan mode. Disallows all edit tools.' },
];
export const FAKE_OPENCODE_MODELS: NonNullable<FakeOpencodeOptions['models']> = [
  { providerID: 'opencode', id: 'glm-5.3-flash-free', name: 'GLM-5.3-Flash Free' },
  { providerID: 'lmstudio', id: 'qwen/qwen3-coder-30b', name: 'Qwen3 Coder 30B' },
  { providerID: 'lmstudio', id: 'gemma-4-26b', name: 'Gemma 4 26B' },
];
export const FAKE_OPENCODE_PROVIDERS: NonNullable<FakeOpencodeOptions['providers']> = [
  { id: 'opencode', name: 'OpenCode' },
  { id: 'lmstudio', name: 'LM Studio (local)' },
];

export type FakeOpencodeEvent =
  | { ev: 'start'; pid: number; argv: string[]; env: Record<string, string>; t: number }
  | { ev: 'ready'; pid: number; port: number; t: number }
  | { ev: 'interrupt'; pid: number; id: string; t: number }
  | { ev: 'create'; pid: number; body: Record<string, unknown>; id: string; t: number }
  | { ev: 'instructions'; pid: number; id: string; key: string; body: Record<string, unknown>; status: number; t: number }
  | { ev: 'mcp'; pid: number; directory: string | null; status: string; t: number }
  | { ev: 'list'; pid: number; what: 'agent' | 'model' | 'provider' | 'config'; directory: string | null; t: number }
  | { ev: 'messages'; pid: number; id: string; query: string; t: number }
  | { ev: 'term'; pid: number; t: number }
  | { ev: 'exit'; pid: number; reason: string; t: number };

export function writeFakeOpencode(dir: string, opts: FakeOpencodeOptions = {}): { bin: string; logFile: string } {
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'events.jsonl');
  const starting = path.join(dir, 'starting');
  const lockCount = path.join(dir, 'lock-count');
  const script = `
import fs from 'node:fs';
import http from 'node:http';
const LOG = ${JSON.stringify(logFile)};
const STARTING = ${JSON.stringify(starting)};
const LOCK_COUNT = ${JSON.stringify(lockCount)};
const OPTS = ${JSON.stringify(opts)};
const AGENTS = ${JSON.stringify(opts.agents ?? FAKE_OPENCODE_AGENTS)};
const MODELS = ${JSON.stringify(opts.models ?? FAKE_OPENCODE_MODELS)};
const PROVIDERS = ${JSON.stringify(opts.providers ?? FAKE_OPENCODE_PROVIDERS)};
const CONFIG_MODEL = ${JSON.stringify(opts.configModel === undefined ? { providerID: 'lmstudio', model: 'qwen/qwen3-coder-30b' } : opts.configModel)};
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\\n');
const argv = process.argv.slice(2);
log({ ev: 'start', argv, env: { ...process.env } });
const exit = (reason, code) => { log({ ev: 'exit', reason }); process.exit(code); };
if (argv[0] !== 'serve') exit('not-serve', 2);
const port = Number(argv[argv.indexOf('--port') + 1]);
const host = argv[argv.indexOf('--hostname') + 1];
const done = Number(fs.existsSync(LOCK_COUNT) ? fs.readFileSync(LOCK_COUNT, 'utf8') : '0');
if (done < (OPTS.failLockTimes ?? 0)) {
  fs.writeFileSync(LOCK_COUNT, String(done + 1));
  process.stderr.write('SQLiteError: database is locked\\n');
  exit('locked', 1);
}
if (fs.existsSync(STARTING)) {
  process.stderr.write('SQLiteError: database is locked\\n');
  exit('locked-overlap', 1);
}
fs.writeFileSync(STARTING, String(process.pid));
const clearStarting = () => { try { if (fs.readFileSync(STARTING, 'utf8') === String(process.pid)) fs.unlinkSync(STARTING); } catch {} };
process.on('SIGTERM', () => {
  log({ ev: 'term' });
  if (OPTS.ignoreTerm) return;
  clearStarting();
  exit('sigterm', 0);
});
const auth = 'Basic ' + Buffer.from('opencode:' + (process.env.OPENCODE_SERVER_PASSWORD ?? '')).toString('base64');
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({ unreadable: b }); } }); });
const mcpNames = (() => { try { return Object.keys(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}').mcp?.servers ?? {}); } catch { return []; } })();
let created = 0;
const agentAsked = new Set();
let mcpPolls = 0;
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== auth) { res.writeHead(401); res.end('unauthorized'); return; }
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const body = await readBody(req);
    if (OPTS.failCreate) { log({ ev: 'create', body, id: '' }); json(res, 500, { error: 'boom' }); return; }
    created++;
    const id = 'ses_fake' + process.pid + 'n' + created;
    log({ ev: 'create', body, id });
    json(res, 200, { data: { id, location: body.location ?? null } });
    return;
  }
  const ins = /^\\/api\\/experimental\\/session\\/([^/]+)\\/instructions\\/entries\\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'PUT' && ins) {
    const body = await readBody(req);
    const status = OPTS.instructionsStatus ?? 200;
    log({ ev: 'instructions', id: decodeURIComponent(ins[1]), key: decodeURIComponent(ins[2]), body, status });
    if (status === 200) json(res, 200, { data: true }); else json(res, status, { error: 'no' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/mcp') {
    mcpPolls++;
    const directory = url.searchParams.get('location[directory]');
    const status = OPTS.mcp === 'failed' ? 'failed' : OPTS.mcp === 'never' || mcpPolls <= (OPTS.mcpPendingPolls ?? 0) ? 'pending' : 'connected';
    log({ ev: 'mcp', directory, status });
    json(res, 200, { location: { directory }, data: mcpNames.map((name) => ({ name, status: { status } })) });
    return;
  }
  const list = /^\\/api\\/(agent|model|provider|config)$/.exec(url.pathname);
  if (req.method === 'GET' && list) {
    const what = list[1];
    const directory = url.searchParams.get('location[directory]');
    log({ ev: 'list', what, directory });
    if (OPTS.failLists) { json(res, 500, { error: 'boom' }); return; }
    const location = { directory: directory ?? process.cwd() };
    if (what === 'config') {
      json(res, 200, [{ type: 'document', path: '/home/.config/opencode/opencode.json', info: CONFIG_MODEL ? { model: CONFIG_MODEL } : {} }, { type: 'directory', path: '/home/.config/opencode' }]);
      return;
    }
    if (what === 'agent') {
      const first = !agentAsked.has(location.directory);
      agentAsked.add(location.directory);
      const data = OPTS.agentsEmptyFirst && first ? [] : AGENTS.map((a) => ({ id: a.id, name: a.id, mode: a.mode, hidden: a.hidden ?? false, ...(a.description ? { description: a.description } : {}), permissions: [] }));
      json(res, 200, { location, data });
      return;
    }
    if (what === 'model') {
      json(res, 200, { location, data: MODELS.map((m) => ({ id: m.id, modelID: m.id, providerID: m.providerID, name: m.name, enabled: m.enabled ?? true, status: 'active', capabilities: { tools: m.tools ?? true }, ...(m.cost ? { cost: m.cost.map((c) => ({ ...c, cache: { read: 0, write: 0 } })) } : {}), ...(m.limit ? { limit: m.limit } : {}) })) });
      return;
    }
    json(res, 200, { location, data: PROVIDERS.map((p) => ({ id: p.id, integrationID: p.id, name: p.name, activation: 'enabled', ...(p.baseURL ? { settings: { apiKey: 'sk-fake-secret', baseURL: p.baseURL } } : {}) })) });
    return;
  }
  const msg = /^\\/api\\/session\\/([^/]+)\\/message$/.exec(url.pathname);
  if (req.method === 'GET' && msg) {
    log({ ev: 'messages', id: decodeURIComponent(msg[1]), query: url.search });
    json(res, 200, { data: [], cursor: { previous: null, next: null } });
    return;
  }
  const m = /^\\/api\\/session\\/([^/]+)\\/interrupt$/.exec(req.url ?? '');
  if (req.method === 'POST' && m) { log({ ev: 'interrupt', id: decodeURIComponent(m[1]) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":true}'); return; }
  if (req.method === 'GET' && req.url === '/api/session/active') {
    const data = Object.fromEntries((OPTS.activeIds ?? []).map((id) => [id, { type: 'busy' }]));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data })); return;
  }
  res.writeHead(404); res.end();
});
server.on('error', (e) => {
  clearStarting();
  process.stderr.write('ServeError: \\n  [cause]: Error: Failed to start server. Is port ' + port + ' in use?\\n');
  exit('port-in-use', 1);
});
setTimeout(() => {
  server.listen(port, host, () => {
    clearStarting();
    log({ ev: 'ready', port });
    process.stdout.write('server listening on http://' + host + ':' + port + '\\n');
  });
}, OPTS.startDelayMs ?? 0);
`;
  const bin = writeFakeNodeTool(dir, 'opencode', script);
  return { bin, logFile };
}

/** writeFakeOpencode が書いた出来事を読む。まだ何も無ければ空の配列。 */
export function readFakeOpencodeLog(logFile: string): FakeOpencodeEvent[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeOpencodeEvent);
}
