import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { newId, type ArtifactDto, type BootstrapDto, type ConfigPreviewDto, type DeviceDto, type IndexProgressDto, type LaunchParams, type LaunchResultDto, type LiveSessionDto, type MemoDto, type PromoteResultDto, type ResolveAction, type ResumeHereConflictDto, type ServerEvent, type SettingsDto, type SummarizerTestDto, type SyncSkippedDto, type SyncStatusBody, type TerminalApp, type UsageDto } from '@agent-hangar/shared';
import { addManualArtifact, ArtifactInputError, getArtifact, listArtifacts } from '../artifacts/queries.ts';
import { isLoopbackSummarizerUrl, type Settings } from '../config/paths.ts';
import { statuslineStatus } from '../config/statusline.ts';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { createMcpApp } from '../mcp/app.ts';
import type { MemoStore } from '../projects/memo.ts';
import { PromoteError } from '../projects/promote.ts';
import { assignSessions, candidateDirs, resolveProject, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { addTodo, listTodos, removeTodo, setTodoDone } from '../projects/todos.ts';
import { RunError, type RunManager } from '../runs/manager.ts';
import { searchSessions } from '../search/search.ts';
import type { SyncEngine } from '../sync/engine.ts';
import { readEvents, subagentIds } from '../transcript/read.ts';
import { aggregateUsage } from '../usage/aggregate.ts';
import { authMiddleware, tokenEquals, tokenFromRequest } from './auth.ts';

/** RunManager のうち HTTP から触る部分だけ。テストは偽物を渡せる。 */
export type RunsApi = Pick<RunManager, 'start' | 'resume' | 'fork' | 'kill' | 'openTab' | 'closeTab' | 'listAlive' | 'getRun' | 'getTab' | 'attachTarget'>;
/** ターミナルとエディタへの受け渡し。設定を読むのは呼び手の役目にして、ここでは結果だけを扱う。 */
export type ExternalApi = {
  openTerminal(o: { tmuxName: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openDirTerminal(o: { dir: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openEditor(o: { target: string }): Promise<void>;
  /** 既定のブラウザで URL を開く。アーティファクトの「開く」で使う。 */
  openUrl(url: string): Promise<void>;
};
/**
 * 要約の受け付け方。true は従来どおり force と同じ。
 * ignoreLive はレジストリの生存判定だけを飛ばす。土台かどうかと 5 ターンの判定は残る。
 */
export type SummaryEnqueueOpts = boolean | { force?: boolean; ignoreLive?: boolean };
/** SummaryJob のうち HTTP から触る部分だけ。 */
export type SummaryApi = { enqueue(sessionId: string, opts?: SummaryEnqueueOpts): boolean; pending(): string[]; test(): Promise<SummarizerTestDto>; listModels(): Promise<string[]> };
/** SyncEngine のうち HTTP から触る部分だけ。 */
export type SyncApi = Pick<SyncEngine, 'status' | 'syncNow' | 'setPaused' | 'onFocus' | 'pullBeforeLaunch'>;
/**
 * Claude Code 設定の同期のうち HTTP から触る部分だけ。
 * ClaudeConfigSync に pull() は無いので、呼び手が applyPull(pendingRemote()) の形に包んで渡す。
 */
export type ConfigSyncApi = { preview(): ConfigPreviewDto; pull(): Promise<{ applied: number; conflicts: number }> };
/**
 * 型は shared に移した。
 * 画面も同じ形を読むので、正本は 1 つにしてある。
 * ここから再輸出しておくのは、この 2 つを app.ts から引いている呼び手を切らないためである。
 */
export type { SyncSkippedDto, SyncStatusBody };
export type AppDeps = {
  db: Db; deviceId: string; deviceName: string; token: string; home: string; port: number; version: string;
  settings: () => Settings; updateSettings: (patch: Partial<SettingsDto>) => Settings;
  live: () => LiveSessionDto[];
  indexer: { progress(): IndexProgressDto; rebuild(): Promise<void> };
  hub: { broadcast(ev: ServerEvent): void };
  runs: RunsApi;
  external: ExternalApi;
  usage: { current(): UsageDto; ingest(raw: unknown): { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null } | null };
  memos: MemoStore;
  summary: SummaryApi;
  promote: (o: { sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }) => { projectId: string; moved: boolean; reason: string | null };
  sync: SyncApi;
  /** 降ろすのを諦めた項目。RemotePuller.skippedEntries() をそのまま載せる。渡さなければ空として扱う。 */
  syncSkipped?: () => SyncSkippedDto[];
  /**
   * 取り残しの掃除（sweep）が、あと何件残しているか。
   * 数えられるのは TranscriptUploader だけなので、同期を設定していない端末では渡らない。
   * 渡さなければ null、つまり「数えられない」として扱う。0 件（追いついた）と区別する。
   */
  syncSweep?: () => number | null;
  /** 他端末の本文を手元に写してから再開する。写しより手元が小さいときだけ 409 の本体を返す。 */
  resumeHere: (sessionId: string, overwrite: boolean) => LaunchResultDto | ResumeHereConflictDto;
  /** 同期を設定していない端末では null。そのとき設定の経路は 404 を返す。 */
  configSync: ConfigSyncApi | null;
  /** 参加トークン。setup を走らせていない端末では null。全セッションの読み書き権を持つので、ログには出さない。 */
  joinToken: () => string | null;
  devices: () => DeviceDto[];
  uiDist?: string;
};

const STATUSES = new Set(['active', 'paused', 'done', 'archived']);
const RESOLVE_KINDS = new Set(['repoint', 'archive', 'unlink']);
/** 空にできない文字列の設定。 */
const TEXT_SETTING_KEYS = ['workspaceRoot', 'claudeDir'] as const;
/** 未設定を null で表すパスの設定。空文字は null と同じに扱う。 */
const PATH_SETTING_KEYS = ['tmuxPath', 'codePath', 'nodePath'] as const;
const TERMINAL_APPS = new Set<string>(['terminal', 'iterm']);
/**
 * 本文の大きさの上限。かならずバイト数で測る。
 * 文字数で測ると、日本語は 1 文字 3 バイトなので上限の 3 倍まで通ってしまう。
 */
const BODY_LIMITS = {
  /** 経路ごとの指定が無い JSON の本文。 */
  default: 64 * 1024,
  statusline: 256 * 1024,
  memo: 1024 * 1024,
  todo: 4 * 1024,
  url: 2 * 1024,
} as const;
/**
 * トークンのクッキーの寿命。
 * 期限を書かないとブラウザを閉じたときに消え、そのたびに鍵付きの URL が要る。
 * ブックマークから開き直せるように 1 年残す。
 */
const ENTRY_COOKIE_MAX_AGE = 31536000;
/** UI の HTML と一緒に配るトークンのクッキー。 */
const entryCookie = (token: string) => `hangar_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ENTRY_COOKIE_MAX_AGE}`;
/**
 * 鍵を持たずに GET / を叩いたときに返す案内。
 * トークンは書かない。ここは認証の前なので、誰が見ているか分からない。
 */
const ENTRY_NOTICE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-hangar</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f7f7f8; color: #1b1b1f; font-family: system-ui, sans-serif; line-height: 1.8; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { margin: 0 0 0.75rem; color: #44454b; }
  code { background: #ececef; border-radius: 4px; padding: 0.1em 0.4em; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<main>
<h1>認証できていません</h1>
<p><code>hangar start</code> が印字した鍵付きの URL から開いてください。</p>
<p>その URL は、端末で <code>hangar url</code> を実行すれば何度でも出せます。</p>
<p>一度そこから開けば、このブラウザには鍵が残ります。次からはブックマークでそのまま開けます。</p>
</main>
</body>
</html>
`;
/**
 * UI に付ける守りの見出し。
 * `SameSite=Strict` の「サイト」はポートを数えないので、手元の別のポートに置かれたページでもクッキーは載る。
 * 枠に嵌めて被せて押させる手を止めるため、frame-ancestors と X-Frame-Options の両方を返す。
 * ほかの指示は、配っている dist の作りに合わせて絞っている。
 * インライン script は無いので script-src は 'self' だけでよい。
 * style は React の style 属性と xterm が実行時に書くので 'unsafe-inline' が要る。
 * font は @fontsource が data: の woff を含むので data: を許す。favicon も data: の SVG である。
 * connect は同じ元と、ターミナルの WebSocket のためのループバックだけにする。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' };

export const toSettingsDto = (s: Settings): SettingsDto => ({ workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir, tmuxPath: s.tmuxPath, terminalApp: s.terminalApp, codePath: s.codePath, lmStudioUrl: s.lmStudioUrl, lmStudioModel: s.lmStudioModel, summaryFallback: s.summaryFallback, summaryHourlyCap: s.summaryHourlyCap, allowExternalSummarizer: s.allowExternalSummarizer, syncClaudeConfig: s.syncClaudeConfig, nodePath: s.nodePath ?? null });
const numberOr = (v: string | undefined): number | undefined => (v ? Number(v) : undefined);
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** http か https で、host のある URL だけを通す。`http://` のような繋ぎ先にならない文字列を弾く。 */
function parseHttpUrl(v: string): URL | null {
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '' ? u : null;
}

/**
 * 本文をバイト数で測ってから読む。上限を超えていれば null を返し、呼び手は 413 にする。
 * Content-Length があれば読む前に切り、無ければ読んでから測る。
 */
async function readBody(c: Context, limit: number): Promise<string | null> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  const text = await c.req.text();
  return Buffer.byteLength(text) > limit ? null : text;
}

/** 本文を読んで JSON にする。壊れた JSON と空の本文は undefined にして、呼び手の既定値に任せる。 */
async function readJson(c: Context, limit: number): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> {
  const text = await readBody(c, limit);
  if (text === null) return { tooLarge: true };
  try {
    return { tooLarge: false, value: JSON.parse(text) as unknown };
  } catch {
    return { tooLarge: false, value: undefined };
  }
}

const tooLargeResult = (c: Context, limit: number) => c.json({ error: `本文が大きすぎます（上限は ${Math.round(limit / 1024)}KB です）` }, 413);

/** RunError は status 付きで返し、それ以外は投げ直す。 */
function runResult<T>(c: Context, fn: () => T, status: 200 | 201 = 200) {
  try {
    return c.json(fn() as object, status);
  } catch (e) {
    if (e instanceof RunError) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

/** 応答に載せる失敗の文言の上限。RunManager と同じ長さにする。 */
const MAX_ERROR_LEN = 200;

/**
 * 外部コマンドの失敗を応答に載せる前に整える。
 * RunManager.safeError と同じ覆いである。いまの呼び先にトークンは渡らないが、
 * 覆いが片方にしか無いと、呼び先が増えたときに漏れる。
 */
export function safeExternalMessage(e: unknown, token: string): string {
  const line = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.trim();
  const masked = token ? line.replaceAll(token, '***') : line;
  return masked.length > MAX_ERROR_LEN ? `${masked.slice(0, MAX_ERROR_LEN)}…` : masked;
}

/** 外部連携の失敗は 500 で理由を返す。UI はこれをそのままトーストに出す。 */
async function externalResult(c: Context, token: string, fn: () => Promise<unknown>, empty = false) {
  try {
    const r = await fn();
    return empty ? c.body(null, 204) : c.json(r as object);
  } catch (e) {
    return c.json({ error: safeExternalMessage(e, token) }, 500);
  }
}

/** HTTP API を組み立てる。/api 配下は認証必須で、/health と UI 配信だけが素通しになる。 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { db, deviceId } = deps;

  app.get('/health', (c) => c.json({ ok: true, version: deps.version }));

  const api = new Hono();
  api.use('*', authMiddleware(deps.token, deps.port));

  const broadcastProject = (id: string) => { const p = getProject(db, deviceId, deps.live(), id); if (p) deps.hub.broadcast({ type: 'project.upsert', project: p }); };
  /**
   * セッションを引くときは必ず自端末の ID を渡す。
   * 渡さないと lockMap が空のまま返るので、他端末で走っている run が「ロック中」として出てこない。
   */
  const session = (id: string) => getSession(db, deps.live(), id, { deviceId });
  const sessions = (opts: { projectId?: string } = {}) => listSessions(db, deps.live(), { ...opts, deviceId });
  const broadcastSession = (id: string) => { const s = session(id); if (s) deps.hub.broadcast({ type: 'session.upsert', session: s }); };
  const requireProject = (id: string) => getProject(db, deviceId, deps.live(), id);
  // 外部連携の失敗の文言は、必ずトークンの覆いを通してから応答に載せる。
  const external = (c: Context, fn: () => Promise<unknown>, empty = false) => externalResult(c, deps.token, fn, empty);
  /** 同期の状態。諦めた項目と、取り残しの残り件数を添えて返す。 */
  const syncStatus = (): SyncStatusBody => ({ ...deps.sync.status(), skipped: deps.syncSkipped?.() ?? [], sweepPending: deps.syncSweep?.() ?? null });
  /**
   * セッションを起こす前に、他端末の変更を 2 秒だけ待って取り込む。
   * 間に合わなくても起動は続ける。同期の失敗で起動を止めない。
   */
  const beforeLaunch = () => deps.sync.pullBeforeLaunch(2000).catch(() => false);

  api.get('/bootstrap', (c) => {
    const live = deps.live();
    const alive = deps.runs.listAlive();
    const body: BootstrapDto = {
      sync: syncStatus(),
      devices: deps.devices(),
      device: { id: deviceId, name: deps.deviceName },
      settings: toSettingsDto(deps.settings()),
      projects: listProjects(db, deviceId, live),
      sessions: listSessions(db, live, { deviceId }),
      live,
      runs: alive.runs,
      tabs: alive.tabs,
      usage: deps.usage.current(),
      todos: listTodos(db),
      artifacts: listArtifacts(db),
      summaryPending: deps.summary.pending(),
      index: deps.indexer.progress(),
      version: deps.version,
    };
    return c.json(body);
  });

  api.get('/projects', (c) => c.json(listProjects(db, deviceId, deps.live())));
  api.get('/projects/:id', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    return p ? c.json(p) : c.json({ error: 'プロジェクトが見つかりません' }, 404);
  });
  api.patch('/projects/:id', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { status?: string };
    if (!body.status || !STATUSES.has(body.status)) return c.json({ error: 'ステータスは active、paused、done、archived のいずれかです' }, 400);
    const row = db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    upsertShared(db, 'projects', { ...row, status: body.status }, deviceId);
    const p = getProject(db, deviceId, deps.live(), id)!;
    deps.hub.broadcast({ type: 'project.upsert', project: p });
    return c.json(p);
  });
  api.get('/projects/:id/candidates', (c) => c.json(candidateDirs(deps.settings().workspaceRoot, c.req.query('name') ?? '')));
  api.post('/projects/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const action = (b.value ?? null) as ResolveAction | null;
    if (!action || !RESOLVE_KINDS.has(action.kind)) return c.json({ error: '操作の種類が正しくありません。repoint、archive、unlink のいずれかを指定してください' }, 400);
    // repoint のパスは、存在を確かめる前に正規化する。検査する値と保存する値を 1 つにしておく。
    // `..` や末尾の `/` が残ると project_roots の前方一致に cwd が当たらず、
    // そのプロジェクトには永久にセッションが紐づかない（POST /api/projects と同じ理由である）。
    const target: ResolveAction = action.kind === 'repoint' && typeof action.path === 'string' ? { kind: 'repoint', path: path.resolve(action.path) } : action;
    if (target.kind === 'repoint' && (typeof target.path !== 'string' || !fs.existsSync(target.path))) return c.json({ error: '指定したディレクトリが見つかりません。存在するディレクトリを選び直してください' }, 400);
    if (!getProject(db, deviceId, deps.live(), id)) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    resolveProject(db, deviceId, id, target);
    const p = getProject(db, deviceId, deps.live(), id);
    if (p) deps.hub.broadcast({ type: 'project.upsert', project: p });
    // 紐づけが変わったセッションを絞り込めないので、全件を流して UI 側で置き換えてもらう。
    for (const s of sessions()) deps.hub.broadcast({ type: 'session.upsert', session: s });
    return c.json(p ?? { id, unlinked: true });
  });

  api.get('/sessions', (c) => c.json(sessions({ projectId: c.req.query('projectId') })));
  api.get('/sessions/:id', (c) => {
    const s = session(c.req.param('id'));
    return s ? c.json(s) : c.json({ error: 'セッションが見つかりません' }, 404);
  });
  api.get('/sessions/:id/events', (c) => {
    const q = c.req.query();
    const id = c.req.param('id');
    // 画面を開くと最新の側を求めてくる。そこが「セッションを開いたとき（主線）」なので、事後要約の契機はここに付ける。
    // 遡るとき（before）と追記を取り込むとき（fromSeq）は契機にしない。受け付けの可否は応答に影響しない。
    if (q.latest === '1' && !q.agentId) {
      try { deps.summary.enqueue(id); } catch { /* 要約の失敗で本文の読み出しを止めない */ }
    }
    // before は 0 を渡せなければならないので、numberOr（空文字と 0 を undefined にする）は使わない。
    const before = q.before === undefined || q.before === '' || !Number.isFinite(Number(q.before)) ? undefined : Number(q.before);
    try {
      return c.json(readEvents(db, id, { fromSeq: numberOr(q.fromSeq), limit: numberOr(q.limit), agentId: q.agentId || null, latest: q.latest === '1', beforeSeq: before }));
    } catch (e) {
      // 索引はあるのに本文ファイルが消えている場合だけ 404 にし、他は 500 に任せる。
      if (isEnoent(e)) return c.json({ error: 'このセッションの本文ファイルが見つかりません。Settings の「索引を作り直す」を試してください' }, 404);
      throw e;
    }
  });
  api.get('/sessions/:id/subagents', (c) => c.json(subagentIds(db, c.req.param('id'))));

  api.get('/search', (c) => {
    const q = c.req.query();
    const running = q.running === undefined ? undefined : q.running === 'true';
    const runningIds = new Set(deps.live().map((l) => l.sessionId));
    return c.json(searchSessions(db, { q: q.q ?? '', projectId: q.projectId || undefined, since: numberOr(q.since), until: numberOr(q.until), running, file: q.file || undefined, limit: numberOr(q.limit) }, runningIds));
  });

  api.get('/settings', (c) => c.json(toSettingsDto(deps.settings())));
  api.patch('/settings', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as Record<string, unknown>;
    // 受け取るのは既知の項目だけにする。本文をそのまま設定に混ぜない。
    const patch: Partial<SettingsDto> = {};
    for (const key of TEXT_SETTING_KEYS) {
      if (!(key in body)) continue;
      const v = body[key];
      if (typeof v !== 'string' || v.trim() === '') return c.json({ error: `${key} は空にできません` }, 400);
      patch[key] = v;
    }
    for (const key of PATH_SETTING_KEYS) {
      if (!(key in body)) continue;
      const v = body[key];
      if (v !== null && typeof v !== 'string') return c.json({ error: `${key} は文字列か null です` }, 400);
      // 空文字は「未設定」と同じ意味なので null に寄せる。
      // 前後の空白は落とす。空白付きのままでは、そのパスで起動できない。
      patch[key] = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    }
    if ('terminalApp' in body) {
      const v = body.terminalApp;
      if (typeof v !== 'string' || !TERMINAL_APPS.has(v)) return c.json({ error: 'terminalApp は terminal か iterm です' }, 400);
      patch.terminalApp = v as TerminalApp;
    }
    if ('lmStudioUrl' in body) {
      // URL の解析は前後の空白を黙って落とすので、保存する値も落としておく。
      // 落とさないと、貼り付けで空白が混ざった値がそのまま設定に残る。
      const v = typeof body.lmStudioUrl === 'string' ? body.lmStudioUrl.trim() : body.lmStudioUrl;
      // host の無い http:// は繋ぎ先にならないので、形だけでなく URL として読めることを確かめる。
      if (typeof v !== 'string' || !parseHttpUrl(v)) return c.json({ error: 'lmStudioUrl は http か https の URL です' }, 400);
      // 末尾の / は付けない。呼び出し側が /v1/... を足すので、二重の / を作らない。
      patch.lmStudioUrl = v.replace(/\/+$/, '');
    }
    if ('lmStudioModel' in body) {
      const v = body.lmStudioModel;
      if (v !== null && typeof v !== 'string') return c.json({ error: 'lmStudioModel は文字列か null です' }, 400);
      // 空文字と空白だけの文字列は「未設定」と同じ意味なので null に寄せる。
      // 前後の空白は落とす。パス系の設定と同じ扱いにそろえる。
      patch.lmStudioModel = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    }
    if ('summaryFallback' in body) {
      const v = body.summaryFallback;
      if (typeof v !== 'boolean') return c.json({ error: 'summaryFallback は true か false です' }, 400);
      patch.summaryFallback = v;
    }
    if ('summaryHourlyCap' in body) {
      const v = body.summaryHourlyCap;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return c.json({ error: 'summaryHourlyCap は 1 以上の整数です' }, 400);
      patch.summaryHourlyCap = v;
    }
    if ('allowExternalSummarizer' in body) {
      const v = body.allowExternalSummarizer;
      if (typeof v !== 'boolean') return c.json({ error: 'allowExternalSummarizer は true か false です' }, 400);
      patch.allowExternalSummarizer = v;
    }
    // Claude Code 設定の同期の入り切り。UI のチェックはこの項目だけを送る。
    // ここが無いと patch が空になり、切り替えが「更新できる設定が含まれていません」で弾かれる。
    if ('syncClaudeConfig' in body) {
      const v = body.syncClaudeConfig;
      if (typeof v !== 'boolean') return c.json({ error: 'syncClaudeConfig は true か false です' }, 400);
      patch.syncClaudeConfig = v;
    }
    if (Object.keys(patch).length === 0) return c.json({ error: '更新できる設定が含まれていません' }, 400);
    // 要約器には会話の本文が送られる。宛先は既定でループバックだけにし、明示の許しがあるときだけ外へ出す。
    // 許しと宛先は同じ要求で見る。片方ずつ変えて素通りする隙間を作らない。
    const cur = deps.settings();
    const allowExternal = patch.allowExternalSummarizer ?? cur.allowExternalSummarizer;
    const nextLmUrl = patch.lmStudioUrl ?? cur.lmStudioUrl;
    if (!allowExternal && !isLoopbackSummarizerUrl(nextLmUrl)) {
      return c.json({ error: '要約器の宛先は 127.0.0.1 か localhost だけです。会話の本文が送られるため、外部の要約器は Settings で明示的に許してから指定してください' }, 400);
    }
    const before = deps.settings();
    const s = deps.updateSettings(patch);
    // ワークスペースが変わったら、その場でプロジェクトを登録し直して結果を配る。
    // claudeDir の変更は索引の読み取り元なので、次の起動で反映する。
    if (patch.workspaceRoot !== undefined && patch.workspaceRoot !== before.workspaceRoot) {
      const unassigned = new Set((db.prepare('select id from sessions where project_id is null and deleted_at is null').all() as { id: string }[]).map((r) => r.id));
      syncProjectsFromWorkspace(db, deviceId, patch.workspaceRoot);
      assignSessions(db, deviceId);
      const live = deps.live();
      for (const p of listProjects(db, deviceId, live)) deps.hub.broadcast({ type: 'project.upsert', project: p });
      for (const id of unassigned) {
        // 配信にも自端末の ID を渡す。ここだけ抜けると、サーバはロックを持っているのに
        // ロック無しの SessionDto が配られ、UI の store がそれで置き換えて画面から消える。
        const sess = getSession(db, live, id, { deviceId });
        if (sess?.projectId) deps.hub.broadcast({ type: 'session.upsert', session: sess });
      }
    }
    deps.hub.broadcast({ type: 'toast', level: 'info', message: '設定を保存しました' });
    return c.json(toSettingsDto(s));
  });
  api.post('/index/rebuild', (c) => {
    void deps.indexer.rebuild().catch((e: unknown) => {
      deps.hub.broadcast({ type: 'toast', level: 'error', message: `索引の作り直しに失敗しました: ${e instanceof Error ? e.message : String(e)}` });
    });
    return c.body(null, 202);
  });

  // 同期。どれも既存の authMiddleware の下にあり、鍵付きの入口と 3 つの検査を通る。
  api.get('/sync/status', (c) => c.json(syncStatus()));
  api.post('/sync/now', async (c) => { await deps.sync.syncNow(); return c.json(syncStatus()); });
  api.post('/sync/pause', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { paused?: unknown };
    if (typeof body.paused !== 'boolean') return c.json({ error: 'paused は true か false です' }, 400);
    deps.sync.setPaused(body.paused);
    // 再開は pull を投げっぱなしにするので、直後のこの状態は pulling になりうる。
    return c.json(syncStatus());
  });
  // 前面化は待たせない。間引き（前の pull から 5 秒）は SyncEngine.onFocus の中にある。
  api.post('/sync/focus', (c) => { void deps.sync.onFocus().catch(() => {}); return c.body(null, 202); });
  api.get('/devices', (c) => c.json(deps.devices()));
  // 参加トークンは全セッションの読み書き権を持つ。ログには出さず、UI が押したときだけ取りに来る。
  api.get('/sync/joinToken', (c) => c.json({ token: deps.joinToken() }));
  api.get('/sync/config/preview', (c) => (deps.configSync ? c.json(deps.configSync.preview()) : c.json({ error: 'クラウド同期が設定されていません' }, 404)));
  api.post('/sync/config/pull', async (c) => (deps.configSync ? c.json(await deps.configSync.pull()) : c.json({ error: 'クラウド同期が設定されていません' }, 404)));

  // 他端末の本文を手元に写してから再開する。手元の方が小さいときだけ 409 で確認を求める。
  api.post('/sessions/:id/resume-here', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { overwrite?: unknown };
    try {
      const r = deps.resumeHere(c.req.param('id'), body.overwrite === true);
      return 'error' in r ? c.json(r, 409) : c.json(r);
    } catch (e) {
      if (e instanceof RunError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  api.get('/runs', (c) => c.json(deps.runs.listAlive()));
  api.post('/runs', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const params = (b.value ?? null) as LaunchParams | null;
    if (!params || typeof params !== 'object') return c.json({ error: '本文が JSON ではありません' }, 400);
    // 他端末の最新を先に取り込む。間に合わなくても起動する（結果は見ない）。
    await beforeLaunch();
    return runResult(c, () => deps.runs.start(params), 201);
  });
  api.delete('/runs/:id', (c) => runResult(c, () => deps.runs.kill(c.req.param('id'))));
  // タブの追加と削除は本文を取らない。UI は content-type だけを付けた空の要求を送る。
  api.post('/runs/:id/tabs', (c) => runResult(c, () => deps.runs.openTab(c.req.param('id')), 201));
  api.delete('/runs/:id/tabs/:tabId', (c) => {
    // closeTab は持ち主を確かめないので、ここで URL の run のタブかを見る。
    // 見ないと、別の run の URL から他人のタブの tmux セッションを落とせてしまう。
    const tabId = c.req.param('tabId');
    const t = deps.runs.getTab(tabId);
    if (!t || t.runId !== c.req.param('id')) return c.json({ error: 'タブが見つかりません' }, 404);
    return runResult(c, () => deps.runs.closeTab(tabId));
  });
  api.post('/runs/:id/open-terminal', async (c) => {
    const run = deps.runs.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'run が見つかりません' }, 404);
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { tabId?: string };
    // tabId を省いたときは Claude のタブを開く。タブ 0 の id は run の id である。
    const tabId = body.tabId ?? run.id;
    const t = deps.runs.getTab(tabId);
    if (!t || t.runId !== run.id) return c.json({ error: 'タブが見つかりません' }, 404);
    // 終了した run の Claude のタブは繋ぎ先がもう無い。シェルタブは終了後も開いてよい。
    if (!deps.runs.attachTarget(tabId)) return c.json({ error: 'この run は終了しています' }, 409);
    return external(c, () => deps.external.openTerminal({ tmuxName: t.tmuxName }));
  });
  api.post('/sessions/:id/resume', async (c) => { await beforeLaunch(); return runResult(c, () => deps.runs.resume(c.req.param('id')), 201); });
  api.post('/sessions/:id/fork', async (c) => { await beforeLaunch(); return runResult(c, () => deps.runs.fork(c.req.param('id')), 201); });
  api.post('/sessions/:id/open-editor', (c) => {
    const s = session(c.req.param('id'));
    if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
    return external(c, () => deps.external.openEditor({ target: s.cwd }), true);
  });
  api.post('/projects', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { name?: unknown; path?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const raw = typeof body.path === 'string' ? body.path.trim() : '';
    if (!name) return c.json({ error: 'name は必須です' }, 400);
    // `..` や末尾の `/` が残ると project_roots の前方一致に cwd が当たらず、
    // そのプロジェクトには永久にセッションが紐づかない。必ず正規化してから入れる。
    const dir = raw ? path.resolve(raw) : '';
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return c.json({ error: 'path が存在するディレクトリではありません' }, 400);
    // 同じディレクトリを二重に登録しない。syncProjectsFromWorkspace と同じ判定にそろえる。
    const known = db.prepare('select project_id from project_roots where device_id = ? and path = ? and deleted_at is null').get(deviceId, dir) as { project_id: string } | undefined;
    if (known) {
      const p = getProject(db, deviceId, deps.live(), known.project_id);
      if (p) return c.json(p);
    }
    const id = newId();
    upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, deviceId);
    upsertShared(db, 'project_roots', { id: newId(), project_id: id, device_id: deviceId, path: dir, resolved: 1 }, deviceId);
    const p = getProject(db, deviceId, deps.live(), id)!;
    deps.hub.broadcast({ type: 'project.upsert', project: p });
    return c.json(p, 201);
  });
  api.post('/projects/:id/open-editor', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    if (!p?.path) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    return external(c, () => deps.external.openEditor({ target: p.path! }), true);
  });
  api.post('/projects/:id/open-terminal', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    if (!p?.path) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    return external(c, () => deps.external.openDirTerminal({ dir: p.path! }));
  });

  // 使用量。statusline スクリプトが curl で送る。他の /api と同じ Bearer 認証を通す。
  api.post('/ingest/statusline', async (c) => {
    const text = await readBody(c, BODY_LIMITS.statusline);
    if (text === null) return tooLargeResult(c, BODY_LIMITS.statusline);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return c.json({ error: '本文が JSON ではありません' }, 400); }
    const r = deps.usage.ingest(raw);
    if (!r) return c.json({ error: 'statusline の payload の形が違います' }, 400);
    if (r.usageChanged) deps.hub.broadcast({ type: 'usage.update', usage: r.usage });
    if (r.providerSessionId) {
      const s = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(r.providerSessionId) as { id: string } | undefined;
      if (s) broadcastSession(s.id);
    }
    return c.body(null, 204);
  });
  api.get('/usage', (c) => c.json(deps.usage.current()));
  api.get('/usage/aggregate', (c) => {
    const raw = c.req.query('days');
    const days = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 365) return c.json({ error: 'days は 1 から 365 の整数です' }, 400);
    return c.json(aggregateUsage(db, { days }));
  });
  api.get('/statusline', (c) => c.json(statuslineStatus(deps.settings().claudeDir)));

  // TODO。変更のたびに一覧とプロジェクト（未完の数）を配る。
  const todosChanged = (projectId: string) => {
    deps.hub.broadcast({ type: 'todos.update', projectId, todos: listTodos(db, projectId) });
    broadcastProject(projectId);
  };
  api.get('/projects/:id/todos', (c) => {
    const id = c.req.param('id');
    return requireProject(id) ? c.json(listTodos(db, id)) : c.json({ error: 'プロジェクトが見つかりません' }, 404);
  });
  api.post('/projects/:id/todos', async (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    const b = await readJson(c, BODY_LIMITS.todo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.todo);
    const body = (b.value ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: 'text は必須です' }, 400);
    const t = addTodo(db, deviceId, { projectId: id, text: body.text });
    todosChanged(id);
    return c.json(t, 201);
  });
  api.patch('/todos/:id', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { done?: unknown };
    if (typeof body.done !== 'boolean') return c.json({ error: 'done は true か false です' }, 400);
    const t = setTodoDone(db, deviceId, c.req.param('id'), body.done);
    if (!t) return c.json({ error: 'TODO が見つかりません' }, 404);
    todosChanged(t.projectId);
    return c.json(t);
  });
  api.delete('/todos/:id', (c) => {
    const t = removeTodo(db, deviceId, c.req.param('id'));
    if (!t) return c.json({ error: 'TODO が見つかりません' }, 404);
    todosChanged(t.projectId);
    return c.json(t);
  });

  // メモ。DB とファイルの両方に書き、ファイルの外部編集は MemoStore の監視が配る。
  api.get('/projects/:id/memo', (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    const m: MemoDto = deps.memos.read(id) ?? { projectId: id, markdown: '', updatedAt: 0 };
    return c.json(m);
  });
  api.put('/projects/:id/memo', async (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    const b = await readJson(c, BODY_LIMITS.memo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.memo);
    const body = (b.value ?? {}) as { markdown?: unknown };
    if (typeof body.markdown !== 'string') return c.json({ error: 'markdown は文字列です' }, 400);
    const m = deps.memos.write(id, body.markdown);
    deps.hub.broadcast({ type: 'memo.update', memo: m });
    broadcastProject(id);
    return c.json(m);
  });

  // アーティファクト。索引化が拾うほかに、手で URL を足せる。
  api.get('/artifacts', (c) => c.json(listArtifacts(db, { projectId: c.req.query('projectId') || undefined, sessionId: c.req.query('sessionId') || undefined })));
  api.post('/projects/:id/artifacts', async (c) => {
    const id = c.req.param('id');
    if (!requireProject(id)) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    const b = await readJson(c, BODY_LIMITS.url);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.url);
    const body = (b.value ?? {}) as { url?: unknown };
    if (typeof body.url !== 'string') return c.json({ error: 'url は必須です' }, 400);
    let a: ArtifactDto;
    // 入力の誤りだけを 400 にする。DB の失敗などは呼び手の直しようが無いので 500 で返す。
    try {
      a = addManualArtifact(db, deviceId, id, body.url);
    } catch (e) {
      if (e instanceof ArtifactInputError) return c.json({ error: e.message }, 400);
      return c.json({ error: 'アーティファクトを追加できませんでした' }, 500);
    }
    deps.hub.broadcast({ type: 'artifact.upsert', artifact: a });
    return c.json(a, 201);
  });
  api.post('/artifacts/:id/open', (c) => {
    const a = getArtifact(db, c.req.param('id'));
    if (!a) return c.json({ error: 'アーティファクトが見つかりません' }, 404);
    return external(c, () => deps.external.openUrl(a.url), true);
  });
  api.post('/artifacts/:id/open-editor', (c) => {
    const a = getArtifact(db, c.req.param('id'));
    if (!a) return c.json({ error: 'アーティファクトが見つかりません' }, 404);
    if (!a.filePath || !a.fileExists) return c.json({ error: '元のファイルが見つかりません' }, 404);
    return external(c, () => deps.external.openEditor({ target: a.filePath! }), true);
  });

  // セッションの 1 行メモ、昇格、事後要約。
  api.patch('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const row = db.prepare('select * from sessions where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: 'セッションが見つかりません' }, 404);
    const b = await readJson(c, BODY_LIMITS.todo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.todo);
    const body = (b.value ?? {}) as { memo?: unknown };
    if (typeof body.memo !== 'string') return c.json({ error: 'memo は文字列です' }, 400);
    upsertShared(db, 'sessions', { ...row, memo: body.memo.trim() || null }, deviceId);
    const s = session(id)!;
    deps.hub.broadcast({ type: 'session.upsert', session: s });
    return c.json(s);
  });
  api.post('/sessions/:id/promote', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { name?: unknown; gitInit?: unknown; moveFiles?: unknown };
    if (typeof body.name !== 'string') return c.json({ error: 'name は必須です' }, 400);
    const before = session(id);
    if (!before) return c.json({ error: 'セッションが見つかりません' }, 404);
    try {
      const r = deps.promote({ sessionId: id, name: body.name, gitInit: body.gitInit === true, moveFiles: body.moveFiles === true });
      const project = getProject(db, deviceId, deps.live(), r.projectId)!;
      const updated = session(id)!;
      deps.hub.broadcast({ type: 'project.upsert', project });
      // 昇格元のスクラッチはセッションが 1 件減るので、そちらも配り直す。
      if (before.projectId && before.projectId !== r.projectId) broadcastProject(before.projectId);
      deps.hub.broadcast({ type: 'session.upsert', session: updated });
      const out: PromoteResultDto = { project, session: updated, moved: r.moved, reason: r.reason };
      return c.json(out, 201);
    } catch (e) {
      if (e instanceof PromoteError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  api.post('/sessions/:id/summarize', (c) => {
    const id = c.req.param('id');
    if (!session(id)) return c.json({ error: 'セッションが見つかりません' }, 404);
    // 受け付けられなくても 202 を返す。UI は accepted を見て「作成中」を出すかどうかだけを決める。
    // 要約は補助の機能なので、受け付けが投げても 500 にせず accepted: false で返す（GET /events と同じ扱い）。
    let accepted = false;
    try { accepted = deps.summary.enqueue(id, { force: true }); } catch { accepted = false; }
    return c.json({ accepted }, 202);
  });
  api.get('/summarizer/models', async (c) => c.json({ models: await deps.summary.listModels() }));
  api.post('/summarizer/test', async (c) => c.json(await deps.summary.test()));

  app.route('/api', api);
  // MCP は自前の認証と Origin の検査を持つので、/api の認証を通さずに直接 mount する。
  app.route('/mcp', createMcpApp({ db, deviceId, port: deps.port, token: deps.token, live: deps.live, runs: deps.runs, hub: deps.hub, usage: () => deps.usage.current(), memos: deps.memos }));

  if (deps.uiDist) {
    const dist = path.resolve(deps.uiDist);
    const assets = path.join(dist, 'assets');
    const index = () => fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    app.get('/', (c) => {
      // 鍵付きの URL で開かれたか、もうクッキーを持っているときだけ UI を配る。
      // 素の GET / にクッキーを配ると、curl 1 本で誰でもトークンを取れてしまう。
      const authed = tokenEquals(c.req.query('t'), deps.token) || tokenEquals(tokenFromRequest(c.req.raw.headers, c.req.header('cookie')), deps.token);
      c.header('Cache-Control', 'no-store');
      // 鍵の有無に関わらず付ける。枠に嵌められるのは、認証が通ったあとの姿である。
      c.header('X-Frame-Options', 'DENY');
      c.header('Content-Security-Policy', CSP);
      if (!authed) return c.html(ENTRY_NOTICE_HTML, 401);
      // ここで鍵をクッキーに換える。URL に残った鍵は UI が history.replaceState で消す。
      c.header('Set-Cookie', entryCookie(deps.token));
      return c.html(index());
    });
    app.get('/assets/*', (c) => {
      // 壊れたパーセント符号化は decodeURIComponent が投げるので、そういう要求は素直に 404 にする。
      let decoded: string;
      try { decoded = decodeURIComponent(c.req.path); } catch { return c.notFound(); }
      const file = path.resolve(dist, decoded.replace(/^\//, ''));
      // assets の外へ抜ける経路と存在しないファイルは 404 にする。
      if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return c.notFound();
      c.header('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(fs.readFileSync(file));
    });
  }
  return app;
}
