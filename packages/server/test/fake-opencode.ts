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
 * 設定のプロバイダーのために、`GET /api/integration`（と `/{id}`）、`POST /api/integration/{id}/connect/key`、`DELETE /api/credential/{id}`、
 * ログインの `POST …/connect/oauth`、`GET …/connect/oauth/{attempt}`、`POST …/complete`、`DELETE …/connect/oauth/{attempt}` も受ける。
 * API キーはメモリにだけ持ち（実物は opencode の DB に書く）、`GET /api/integration` の connections には載せない（実物と同じ）。
 * configFile を渡すと、その opencode.json の `providers` と `provider` のプロバイダーを、API キーの方法を持つ integration と、`/api/provider` の行として足す（実物は書き換えを見張って読み直す）。
 *
 * 起動から止まるまでの出来事を、1 行 1 件の JSON で logFile に書く。
 * - `start`：pid、argv、環境変数の全部、時刻。
 * - `ready`：待ち受けを始めた時刻。
 * - `interrupt`：受けた会話の ID。
 * - `create`：`POST /api/session` の本文と、振った ID。
 * - `instructions`：指示の PUT の会話の ID、鍵、本文。
 * - `mcp`：MCP の状態を聞かれた場所（directory）と、答えた状態。
 * - `list`：一覧の道（agent、model、provider、config）と、聞かれた場所（directory）。
 * - `export`：`session export` の書き出し先（server か standalone）と、会話の ID。
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
  /** `GET /api/command` の一覧（実物の Command.Info）。既定は init と review。 */
  commands?: { name: string; description?: string }[];
  /** `GET /api/skill` の一覧（実物の Skill.Info の一部）。既定は frontend-design。 */
  skills?: { id: string; name: string; description?: string }[];
  /** `/api/command` と `/api/skill` を 404 で断る（道の無い版のふり）。 */
  noSlashLists?: boolean;
  /** 一覧の道を 500 で断る。 */
  failLists?: boolean;
  /** `GET /api/integration` のカタログ。既定は FAKE_OPENCODE_INTEGRATIONS。 */
  integrations?: FakeIntegration[];
  /** 読む opencode.json（実物の ~/.config/opencode/opencode.json の代わり）。 */
  configFile?: string;
  /** ログインの状態を何回 pending と答えてから complete にするか。 */
  oauthPendingPolls?: number;
  /** 起きたときから持っている API キーの接続（integration の ID）。 */
  credentials?: string[];

  /**
   * `session export [--server URL | --standalone] <ID>` で書き出す中身。ID ごとの JSON を、実物と同じく整形して標準出力に書く。
   * 載っていない ID は、実物と同じ文（`Session not found: <ID>`）で落ちる。
   */
  exports?: Record<string, unknown>;
  /** 書き出しの最初の n 回を `database is locked` で落とす。 */
  exportLockTimes?: number;
  /** `--server` つきの書き出しを、つながらない失敗で落とす（serve が先に止まったふり）。 */
  exportServerDown?: boolean;
  /** 書き出しの途中で落ちる（半端な JSON を書いて exit 1）。 */
  exportTruncate?: boolean;
  /** 書き出しを終えるまでの間。 */
  exportDelayMs?: number;
};

/** 偽のカタログの 1 行。methods は実物の Integration.Method の形。 */
export type FakeIntegration = { id: string; name: string; methods: Record<string, unknown>[] };

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
export const FAKE_OPENCODE_COMMANDS: NonNullable<FakeOpencodeOptions['commands']> = [
  { name: 'init', description: 'create/update AGENTS.md' },
  { name: 'review', description: 'review changes' },
];
export const FAKE_OPENCODE_SKILLS: NonNullable<FakeOpencodeOptions['skills']> = [
  { id: 'frontend-design', name: 'frontend-design', description: 'Distinctive visual design.' },
];
export const FAKE_OPENCODE_PROVIDERS: NonNullable<FakeOpencodeOptions['providers']> = [
  { id: 'opencode', name: 'OpenCode' },
  { id: 'lmstudio', name: 'LM Studio (local)' },
];

export const FAKE_OPENCODE_INTEGRATIONS: FakeIntegration[] = [
  { id: 'groq', name: 'Groq', methods: [{ type: 'key' }, { type: 'env', names: ['GROQ_API_KEY'] }] },
  { id: 'deepseek', name: 'DeepSeek', methods: [{ type: 'key' }, { type: 'env', names: ['DEEPSEEK_API_KEY'] }] },
  { id: 'github-copilot', name: 'GitHub Copilot', methods: [{ type: 'env', names: ['GITHUB_TOKEN'] }, { id: 'device', type: 'oauth', label: 'Login with GitHub Copilot', form: [{ key: 'deploymentType', title: 'Select GitHub deployment type', required: true, type: 'string', options: [{ value: 'github.com', label: 'GitHub.com' }, { value: 'enterprise', label: 'GitHub Enterprise' }] }, { key: 'enterpriseUrl', title: 'URL', required: true, when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }], type: 'string' }] }] },
  { id: 'abacus', name: 'Abacus', methods: [{ type: 'key' }] },
  { id: 'zai', name: 'Z.AI', methods: [{ type: 'key' }, { type: 'env', names: ['ZHIPU_API_KEY'] }] },
  { id: 'opencode-go', name: 'OpenCode Go', methods: [{ type: 'key' }, { type: 'env', names: ['OPENCODE_API_KEY'] }] },
  { id: 'zai-coding-plan', name: 'Z.AI Coding Plan', methods: [{ type: 'key' }] },
  { id: 'lmstudio', name: 'LMStudio', methods: [{ type: 'key' }, { type: 'env', names: ['LMSTUDIO_API_KEY'] }] },
  { id: 'opencode', name: 'OpenCode Console', methods: [{ type: 'key', label: 'API key (service account)' }, { id: 'device', type: 'oauth', label: 'OpenCode Console account', form: [{ key: 'server', hidden: true, type: 'string', default: 'https://opencode.ai/console' }] }] },
];

export type FakeOpencodeEvent =
  | { ev: 'start'; pid: number; argv: string[]; env: Record<string, string>; t: number }
  | { ev: 'ready'; pid: number; port: number; t: number }
  | { ev: 'interrupt'; pid: number; id: string; t: number }
  | { ev: 'create'; pid: number; body: Record<string, unknown>; id: string; t: number }
  | { ev: 'instructions'; pid: number; id: string; key: string; body: Record<string, unknown>; status: number; t: number }
  | { ev: 'mcp'; pid: number; directory: string | null; status: string; t: number }
  | { ev: 'list'; pid: number; what: 'agent' | 'model' | 'provider' | 'config' | 'command' | 'skill'; directory: string | null; t: number }
  | { ev: 'messages'; pid: number; id: string; query: string; t: number }
  | { ev: 'connectKey'; pid: number; id: string; key: string; t: number }
  | { ev: 'deleteCredential'; pid: number; id: string; t: number }
  | { ev: 'oauth'; pid: number; id: string; body: Record<string, unknown>; t: number }
  | { ev: 'oauthComplete'; pid: number; id: string; attempt: string; code: unknown; t: number }
  | { ev: 'integration'; pid: number; id: string | null; t: number }

  | { ev: 'export'; pid: number; via: 'server' | 'standalone'; id: string; t: number }
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
const INTEGRATIONS = ${JSON.stringify(opts.integrations ?? FAKE_OPENCODE_INTEGRATIONS)};
const COMMANDS = ${JSON.stringify(opts.commands ?? FAKE_OPENCODE_COMMANDS)};
const SKILLS = ${JSON.stringify(opts.skills ?? FAKE_OPENCODE_SKILLS)};
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\\n');
const argv = process.argv.slice(2);
log({ ev: 'start', argv, env: { ...process.env } });
const exit = (reason, code) => { log({ ev: 'exit', reason }); process.exit(code); };
if (argv[0] === 'session' && argv[1] === 'export') {
  const EXPORT_LOCKS = ${JSON.stringify(path.join(dir, 'export-lock-count'))};
  const at = argv.indexOf('--server');
  const via = at >= 0 ? 'server' : 'standalone';
  const id = argv[argv.length - 1];
  log({ ev: 'export', via, id });
  if (via === 'server' && !process.env.OPENCODE_PASSWORD) { process.stderr.write('Server at ' + argv[at + 1] + ' requires a password; set OPENCODE_PASSWORD\\n'); exit('export-no-password', 1); }
  if (via === 'server' && OPTS.exportServerDown) { process.stderr.write('Unable to connect. Is the computer able to access the url?\\n'); exit('export-server-down', 1); }
  const n = Number(fs.existsSync(EXPORT_LOCKS) ? fs.readFileSync(EXPORT_LOCKS, 'utf8') : '0');
  if (n < (OPTS.exportLockTimes ?? 0)) { fs.writeFileSync(EXPORT_LOCKS, String(n + 1)); process.stderr.write('SQLiteError: database is locked\\n'); exit('export-locked', 1); }
  const data = (OPTS.exports ?? {})[id];
  if (data === undefined) { process.stderr.write('Session not found: ' + id + '\\n'); exit('export-not-found', 1); }
  const text = JSON.stringify(data, null, 2) + '\\n';
  setTimeout(() => {
    if (OPTS.exportTruncate) { process.stdout.write(text.slice(0, Math.floor(text.length / 2)), () => exit('export-truncated', 1)); return; }
    process.stdout.write(text, () => exit('exported', 0));
  }, OPTS.exportDelayMs ?? 0);
} else {
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
// 接続の記録（実物は DB）。id → { integrationID, key, method }。
const creds = new Map();
let credSeq = 0;
for (const id of OPTS.credentials ?? []) creds.set('cred_fake' + (++credSeq), { integrationID: id, key: 'sk-preexisting', method: 'key' });
const attempts = new Map();
let attemptSeq = 0;
// opencode.json のプロバイダー（コメントは行と塊を雑に除く。偽物なので文字列の中の // は考えない）。
const configProviders = () => {
  if (!OPTS.configFile) return {};
  try {
    const raw = fs.readFileSync(OPTS.configFile, 'utf8');
    const t = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    // 文字列の外のコメントと、閉じ括弧の前のカンマを除く（台本はテンプレート文字列の中なので、逆斜線を使わずに書く）。
    const BS = String.fromCharCode(92);
    const NL = String.fromCharCode(10);
    let text = '';
    for (let i = 0, inStr = false; i < t.length;) {
      const c = t[i];
      if (inStr) { text += c; if (c === BS) { text += t[i + 1]; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
      if (c === '"') { inStr = true; text += c; i++; continue; }
      if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== NL) i++; continue; }
      if (c === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; continue; }
      if (c === ',') { let j = i + 1; while (j < t.length && t.charCodeAt(j) <= 32) j++; if (t[j] === '}' || t[j] === ']') { i++; continue; } }
      text += c; i++;
    }
    const j = JSON.parse(text);
    return { ...(j.provider ?? {}), ...(j.providers ?? {}) };
  } catch { return {}; }
};
const integrationsNow = () => {
  const custom = Object.entries(configProviders()).filter(([id]) => !INTEGRATIONS.some((x) => x.id === id)).map(([id, p]) => ({ id, name: p.name ?? id, methods: [{ type: 'key', label: 'Manually enter API Key' }] }));
  return [...INTEGRATIONS, ...custom].map((x) => ({ ...x, connections: [...creds.entries()].filter(([, c]) => c.integrationID === x.id).map(([cid, c]) => ({ type: 'credential', id: cid, label: x.name, method: c.method })) }));
};
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
  const list = /^\\/api\\/(agent|model|provider|config|command|skill)$/.exec(url.pathname);
  if (req.method === 'GET' && list) {
    const what = list[1];
    const directory = url.searchParams.get('location[directory]');
    log({ ev: 'list', what, directory });
    if (OPTS.failLists) { json(res, 500, { error: 'boom' }); return; }
    const location = { directory: directory ?? process.cwd() };
    if (what === 'command' || what === 'skill') {
      if (OPTS.noSlashLists) { json(res, 404, { error: 'not found' }); return; }
      const data = what === 'command'
        ? COMMANDS.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}) }))
        : SKILLS.map((k) => ({ id: k.id, name: k.name, ...(k.description ? { description: k.description } : {}), path: '/skills/' + k.id + '/SKILL.md', content: '# ' + k.name }));
      json(res, 200, { location, data });
      return;
    }
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
    const fromConfig = Object.entries(configProviders()).map(([id, p]) => ({ id, name: p.name ?? id, baseURL: p.settings?.baseURL ?? p.options?.baseURL }));
    const fromCreds = [...creds.values()].map((c) => c.integrationID).map((id) => ({ id, name: (INTEGRATIONS.find((x) => x.id === id) ?? { name: id }).name }));
    const rows = [...PROVIDERS, ...fromConfig, ...fromCreds].filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
    json(res, 200, { location, data: rows.map((p) => ({ id: p.id, integrationID: p.id, name: p.name, activation: p.id === 'lmstudio' ? 'auto' : 'enabled', ...(p.baseURL ? { settings: { apiKey: 'sk-fake-secret', baseURL: p.baseURL } } : {}) })) });
    return;
  }
  const msg = /^\\/api\\/session\\/([^/]+)\\/message$/.exec(url.pathname);
  if (req.method === 'GET' && msg) {
    log({ ev: 'messages', id: decodeURIComponent(msg[1]), query: url.search });
    json(res, 200, { data: [], cursor: { previous: null, next: null } });
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/api/integration' || url.pathname.startsWith('/api/integration/')) && !url.pathname.includes('/connect/')) {
    const id = url.pathname === '/api/integration' ? null : decodeURIComponent(url.pathname.slice('/api/integration/'.length));
    log({ ev: 'integration', id });
    const all = integrationsNow();
    if (id === null) { json(res, 200, { location: { directory: process.cwd() }, data: all }); return; }
    const one = all.find((x) => x.id === id);
    if (!one) { json(res, 404, { _tag: 'IntegrationNotFoundError', integrationID: id, message: 'Integration not found: ' + id }); return; }
    json(res, 200, { location: { directory: process.cwd() }, data: one });
    return;
  }
  const ck = /^\\/api\\/integration\\/([^/]+)\\/connect\\/key$/.exec(url.pathname);
  if (req.method === 'POST' && ck) {
    const id = decodeURIComponent(ck[1]);
    const body = await readBody(req);
    if (!integrationsNow().some((x) => x.id === id)) { json(res, 404, { _tag: 'IntegrationNotFoundError', integrationID: id, message: 'Integration not found: ' + id }); return; }
    if (typeof body.key !== 'string' || !body.key) { json(res, 400, { _tag: 'InvalidRequestError', message: 'bad key ' + JSON.stringify(body) }); return; }
    log({ ev: 'connectKey', id, key: body.key });
    creds.set('cred_fake' + (++credSeq), { integrationID: id, key: body.key, method: 'key' });
    res.writeHead(204); res.end();
    return;
  }
  const dc = /^\\/api\\/credential\\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && dc) {
    const id = decodeURIComponent(dc[1]);
    log({ ev: 'deleteCredential', id });
    creds.delete(id);
    res.writeHead(204); res.end();
    return;
  }
  const oa = /^\\/api\\/integration\\/([^/]+)\\/connect\\/oauth(?:\\/([^/]+)(\\/complete)?)?$/.exec(url.pathname);
  if (oa) {
    const id = decodeURIComponent(oa[1]);
    const attempt = oa[2] ? decodeURIComponent(oa[2]) : null;
    if (req.method === 'POST' && !attempt) {
      const body = await readBody(req);
      log({ ev: 'oauth', id, body });
      const a = 'att_fake' + (++attemptSeq);
      attempts.set(a, { id, polls: 0, done: false });
      json(res, 200, { location: { directory: process.cwd() }, data: { attemptID: a, url: 'https://example.invalid/device', instructions: 'Enter code ABCD-1234', mode: id === 'opencode' ? 'code' : 'auto', time: { created: Date.now(), expires: Date.now() + 600000 } } });
      return;
    }
    const st = attempt ? attempts.get(attempt) : null;
    if (!st) { json(res, 404, { _tag: 'IntegrationAttemptNotFoundError', integrationID: id, attemptID: attempt, message: 'not found' }); return; }
    const finish = () => { if (!st.done) { st.done = true; creds.set('cred_fake' + (++credSeq), { integrationID: id, key: 'oauth-token', method: 'oauth' }); } };
    if (req.method === 'GET') {
      st.polls++;
      if (st.polls > (OPTS.oauthPendingPolls ?? 1)) finish();
      json(res, 200, { location: { directory: process.cwd() }, data: { status: st.done ? 'complete' : 'pending', time: { created: 0, expires: 1 } } });
      return;
    }
    if (req.method === 'POST' && oa[3]) {
      const body = await readBody(req);
      log({ ev: 'oauthComplete', id, attempt, code: body.code });
      finish();
      res.writeHead(204); res.end();
      return;
    }
    if (req.method === 'DELETE') { attempts.delete(attempt); res.writeHead(204); res.end(); return; }
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
}
`;
  const bin = writeFakeNodeTool(dir, 'opencode', script);
  return { bin, logFile };
}

/** writeFakeOpencode が書いた出来事を読む。まだ何も無ければ空の配列。 */
export function readFakeOpencodeLog(logFile: string): FakeOpencodeEvent[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeOpencodeEvent);
}
