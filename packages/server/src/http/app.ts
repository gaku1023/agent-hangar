import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { COMPAT_VERSION, isLanguage, languageOf, LANGUAGES, type ArtifactDto, type BootstrapDto, type MemoDto, type ResolveAction, type SettingsDto, type SyncSkippedDto, type SyncStatusBody, type TerminalApp } from '@agent-hangar/shared';
import { addManualArtifact, ArtifactInputError, getArtifact, listArtifacts } from '../artifacts/queries.ts';
import { LOCK_BUSY_MESSAGE } from '../config/claudeFileWrite.ts';
import { JsonTextEditError } from '../config/jsonTextEdit.ts';
import { isLoopbackSummarizerUrl, type Settings } from '../config/paths.ts';
import { checkToolPath, expandHome, isCommandName } from '../config/readiness.ts';
import { RetentionConflictError, RetentionUnwritableError } from '../config/retention.ts';
import { statuslineStatus } from '../config/statusline.ts';
import { touchRow } from '../db/notify.ts';
import { getProject, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { createMcpApp } from '../mcp/app.ts';
import { createProjectDir, ProjectCreateError, registerProjectDir } from '../projects/create.ts';
import { assignSessions, candidateDirs, listWorkspaceDirs, normalizeDir, resolveProject, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { addTodo, confirmTodo, listTodos, rejectTodo, removeTodo, setTodoDone } from '../projects/todos.ts';
import { aggregateUsage } from '../usage/aggregate.ts';
import { accountsRoutes, buildAccountsDto, type AccountsDeps } from './accounts.ts';
import { listPromptCommands } from '../prompt/commands.ts';
import { listProjectFiles } from '../prompt/files.ts';
import { MAX_DROP_BYTES, pruneDrops, resolveDrop, saveDrop } from '../prompt/drops.ts';
import { authMiddleware, tokenEquals, tokenFromRequest } from './auth.ts';
import type { AppDeps } from './deps.ts';
import { beforeLaunchOf, BODY_LIMITS, externalOf, projectOf, readBody, readJson, syncStatusOf, tooLargeResult } from './routes/common.ts';
import { runRoutes } from './routes/runs.ts';
import { sessionRoutes } from './routes/sessions.ts';

export type { AppDeps, ConfigSyncApi, ExternalApi, RunsApi, SummaryApi, SummaryEnqueueOpts, SyncApi } from './deps.ts';
/**
 * 型は shared に移した。
 * 画面も同じ形を読むので、正本は 1 つにしてある。
 * ここから再輸出しておくのは、この 2 つを app.ts から引いている呼び手を切らないためである。
 */
export type { SyncSkippedDto, SyncStatusBody };

const STATUSES = new Set(['active', 'paused', 'done', 'archived']);
const RESOLVE_KINDS = new Set(['repoint', 'archive', 'unlink']);
/** 空にできない文字列の設定。 */
const TEXT_SETTING_KEYS = ['workspaceRoot', 'claudeDir'] as const;
/** 未設定を null で表すパスの設定。空文字は null と同じに扱う。 */
const PATH_SETTING_KEYS = ['tmuxPath', 'codePath', 'nodePath', 'claudePath'] as const;
const TERMINAL_APPS = new Set<string>(['terminal', 'iterm']);
/**
 * 「1 時間の上限」の上限。
 * 画面の入力（SettingsScreen の Stepper）と同じにする。
 */
const SUMMARY_HOURLY_CAP_MAX = 200;
/**
 * 設定の項目の、画面の欄の見出し。
 * エラー文は画面のトーストに出るので、内部のキー名ではなくこの見出しで言う。
 */
const SETTING_LABEL: Record<(typeof TEXT_SETTING_KEYS)[number] | (typeof PATH_SETTING_KEYS)[number], string> = {
  workspaceRoot: 'ワークスペースのルート', claudeDir: '読み取り元', tmuxPath: 'tmux のパス', codePath: 'code のパス', nodePath: 'Node のパス', claudePath: 'claude のパス',
};
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
<p>その URL は、ターミナルで <code>hangar url</code> を実行すれば何度でも出せます。</p>
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

export const toSettingsDto = (s: Settings): SettingsDto => ({ workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir, tmuxPath: s.tmuxPath, terminalApp: s.terminalApp, codePath: s.codePath, lmStudioUrl: s.lmStudioUrl, lmStudioModel: s.lmStudioModel, summaryFallback: s.summaryFallback, summaryHourlyCap: s.summaryHourlyCap, allowExternalSummarizer: s.allowExternalSummarizer, syncClaudeConfig: s.syncClaudeConfig, nodePath: s.nodePath ?? null, claudePath: s.claudePath ?? null, language: languageOf(s.language) });

/** http か https で、host のある URL だけを通す。`http://` のような繋ぎ先にならない文字列を弾く。 */
function parseHttpUrl(v: string): URL | null {
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '' ? u : null;
}
export { safeExternalMessage } from './routes/common.ts';

/** HTTP API を組み立てる。/api 配下は認証必須で、/health と UI 配信だけが素通しになる。 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { db, deviceId } = deps;

  // 鍵の要らない経路なので、起動の進み具合は段階と件数だけを載せる。
  // compat は互換の版番号で、殻は 4177 の既存のサーバを、自分と同じ版のときだけ採る（apps/desktop/src-tauri/src/health.rs の judge_existing）。
  app.get('/health', (c) => c.json({ ok: true, version: deps.version, compat: COMPAT_VERSION, ready: deps.ready(), index: deps.indexer.progress() }));

  const api = new Hono();
  api.use('*', authMiddleware(deps.token, deps.port));

  const requireProject = projectOf(deps);
  const external = externalOf(deps);
  const syncStatus = syncStatusOf(deps);
  const beforeLaunch = beforeLaunchOf(deps);
  const accountsDeps: AccountsDeps = { beforeLaunch, ...deps.accounts };
  accountsRoutes(api, accountsDeps);

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
      todos: listTodos(db),
      artifacts: listArtifacts(db),
      summaryPending: deps.summary.pending(),
      index: deps.indexer.progress(),
      version: deps.version,
      retention: deps.retention.current(),
      cloudUsage: deps.cloudUsage.current(),
      accounts: buildAccountsDto(accountsDeps, { checkLinks: true }),
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
    return c.json(getProject(db, deviceId, deps.live(), id)!);
  });
  api.get('/projects/:id/candidates', (c) => c.json(candidateDirs(deps.settings().workspaceRoot, c.req.query('name') ?? '')));
  // 初期プロンプト欄の `/` の候補。projectId が無ければ（スクラッチなど）、プロジェクトのものは読まない。
  api.get('/prompt/commands', (c) => {
    const id = c.req.query('projectId');
    const project = id ? requireProject(id) : null;
    if (id && !project) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    return c.json({ commands: listPromptCommands({ claudeDir: deps.settings().claudeDir, projectPath: project?.path ?? null }) });
  });
  // 初期プロンプト欄の `@` の候補。パスの無いプロジェクト（まだ場所が決まっていないもの）では空を返す。
  api.get('/prompt/files', async (c) => {
    const id = c.req.query('projectId');
    if (!id) return c.json({ error: 'projectId が要ります' }, 400);
    const project = requireProject(id);
    if (!project) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    return c.json({ files: project.path ? await listProjectFiles(project.path, c.req.query('q') ?? '') : [] });
  });
  // 初期プロンプト欄の添付。端末へのドロップ（殻の filedrop.rs）と同じ置き場に置く。
  const dropsDir = path.join(deps.home, 'drops');
  const DROP_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  api.post('/drops/existing', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const paths = (b.value as { paths?: unknown } | null | undefined)?.paths;
    if (!Array.isArray(paths)) return c.json({ error: 'paths が要ります' }, 400);
    // フォルダを落としたときは元のパスがそのまま添付になるので、ファイルに限らず「ある」かだけを見る。
    return c.json({ paths: paths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) });
  });
  api.post('/drops', async (c) => {
    // 先に長さの申告で断り、読んだ後にも実際の大きさで断る（申告は偽れる）。
    if (Number(c.req.header('content-length') ?? 0) > MAX_DROP_BYTES) return tooLargeResult(c, MAX_DROP_BYTES);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_DROP_BYTES) return tooLargeResult(c, MAX_DROP_BYTES);
    if (bytes.byteLength === 0) return c.json({ error: '中身がありません' }, 400);
    pruneDrops(dropsDir, Date.now());
    return c.json(saveDrop(dropsDir, c.req.query('name') ?? '', bytes), 201);
  });
  api.get('/drops/:name', (c) => {
    const file = resolveDrop(dropsDir, c.req.param('name'));
    if (!file) return c.notFound();
    // 画像だけを画像として返す。ほかは開かせない。置いたものを頁として解釈させないためである。
    c.header('Content-Type', DROP_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, max-age=3600');
    return c.body(fs.readFileSync(file));
  });
  api.post('/projects/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const action = (b.value ?? null) as ResolveAction | null;
    if (!action || !RESOLVE_KINDS.has(action.kind)) return c.json({ error: '操作の種類が正しくありません。repoint、archive、unlink のいずれかを指定してください' }, 400);
    // repoint のパスは、存在を確かめる前に正規化する。検査する値と保存する値を 1 つにしておく。
    // `..` や末尾の `/` が残ると project_roots の前方一致に cwd が当たらず、
    // そのプロジェクトには永久にセッションが紐づかない（POST /api/projects と同じ理由である）。
    const target: ResolveAction = action.kind === 'repoint' && typeof action.path === 'string' ? { kind: 'repoint', path: normalizeDir(action.path) } : action;
    if (target.kind === 'repoint' && (typeof target.path !== 'string' || !fs.existsSync(target.path))) return c.json({ error: '指定したディレクトリが見つかりません。存在するディレクトリを選び直してください' }, 400);
    if (!getProject(db, deviceId, deps.live(), id)) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    // プロジェクトと、紐づけが変わったセッションは、書いた行から配る層が配る。
    resolveProject(db, deviceId, id, target);
    return c.json(getProject(db, deviceId, deps.live(), id) ?? { id, unlinked: true });
  });

  sessionRoutes(api, deps);
  api.get('/settings', (c) => c.json(toSettingsDto(deps.settings())));
  /** 保持期間として受け付ける値。Claude Code は 1 未満を弾く。上は 100 年で切り、打ち間違いの桁あふれを通さない。 */
  const retentionDays = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 36500 ? v : null);
  const BAD_DAYS = '保持期間は 1 以上 36500 以下の整数で指定してください';

  api.get('/retention', (c) => c.json(deps.retention.current()));
  api.post('/retention/preview', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const days = retentionDays((b.value as { days?: unknown } | null)?.days);
    if (days === null) return c.json({ error: BAD_DAYS }, 400);
    try {
      return c.json(deps.retention.preview(days));
    } catch (e) {
      if (e instanceof JsonTextEditError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  api.put('/retention', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { days?: unknown; baseSha256?: unknown };
    const days = retentionDays(body.days);
    if (days === null) return c.json({ error: BAD_DAYS }, 400);
    if (typeof body.baseSha256 !== 'string') return c.json({ error: '下見の指紋がありません' }, 400);
    try {
      return c.json(deps.retention.write(days, body.baseSha256));
    } catch (e) {
      if (e instanceof RetentionConflictError) return c.json({ error: 'retention_conflict' }, 409);
      if (e instanceof JsonTextEditError || e instanceof RetentionUnwritableError || (e instanceof Error && e.message === LOCK_BUSY_MESSAGE)) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  api.patch('/settings', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as Record<string, unknown>;
    // 受け取るのは既知の項目だけにする。本文をそのまま設定に混ぜない。
    const patch: Partial<SettingsDto> = {};
    for (const key of TEXT_SETTING_KEYS) {
      if (!(key in body)) continue;
      const v = body[key];
      if (typeof v !== 'string' || v.trim() === '') return c.json({ error: `「${SETTING_LABEL[key]}」は空にできません` }, 400);
      patch[key] = v;
    }
    // ワークスペースは、保存する前にディレクトリがあることを確かめる。
    // 無いところを保存すると、プロジェクトが 1 つも登録されないまま、何が悪いのかが画面から読めない。
    if (patch.workspaceRoot !== undefined) {
      const root = expandHome(patch.workspaceRoot.trim());
      const st = fs.statSync(root, { throwIfNoEntry: false });
      if (!st) return c.json({ error: `「${SETTING_LABEL.workspaceRoot}」に ${root} が見つかりません` }, 400);
      if (!st.isDirectory()) return c.json({ error: `「${SETTING_LABEL.workspaceRoot}」の ${root} はディレクトリではありません` }, 400);
      patch.workspaceRoot = root;
    }
    for (const key of PATH_SETTING_KEYS) {
      if (!(key in body)) continue;
      const v = body[key];
      if (v !== null && typeof v !== 'string') return c.json({ error: `「${SETTING_LABEL[key]}」の値の形が違います` }, 400);
      // 空文字は「未設定」と同じ意味なので null に寄せる。
      // 前後の空白は落とす。空白付きのままでは、そのパスで起動できない。
      if (typeof v !== 'string' || v.trim() === '') { patch[key] = null; continue; }
      // 保存する前に、あることと実行できることを確かめる。
      // 動かないパスを保存すると、起動や要約が後になって、別の場所で失敗する。
      // 名前だけ（tmux など）は PATH から探して確かめ、打たれたまま保存する。起動のときも子プロセスが PATH から探すからである。
      // ./x や bin/x のような相対パスは、サーバの作業ディレクトリで読むとどこを指すかが分からないので弾く。
      const raw = v.trim();
      const name = isCommandName(raw);
      if (!name && !path.isAbsolute(expandHome(raw))) return c.json({ error: `「${SETTING_LABEL[key]}」は / か ~ で始まるパスか、tmux のようなコマンドの名前にしてください` }, 400);
      const t = checkToolPath(raw);
      if (t.problem === 'missing') return c.json({ error: name ? `「${SETTING_LABEL[key]}」の ${raw} が PATH に見つかりません` : `「${SETTING_LABEL[key]}」に ${t.path} が見つかりません` }, 400);
      if (t.problem === 'notFile') return c.json({ error: `「${SETTING_LABEL[key]}」の ${t.path} はファイルではありません` }, 400);
      if (t.problem === 'notExecutable') return c.json({ error: `「${SETTING_LABEL[key]}」の ${t.path} には実行権がありません` }, 400);
      // パスは ~ を直した値で保存する（起動するときに ~ は直されない）。名前は打たれたまま残す。
      patch[key] = name ? raw : t.path;
    }
    if ('terminalApp' in body) {
      const v = body.terminalApp;
      if (typeof v !== 'string' || !TERMINAL_APPS.has(v)) return c.json({ error: '「ターミナルアプリ」は Terminal.app か iTerm2 から選んでください' }, 400);
      patch.terminalApp = v as TerminalApp;
    }
    if ('lmStudioUrl' in body) {
      // URL の解析は前後の空白を黙って落とすので、保存する値も落としておく。
      // 落とさないと、貼り付けで空白が混ざった値がそのまま設定に残る。
      const v = typeof body.lmStudioUrl === 'string' ? body.lmStudioUrl.trim() : body.lmStudioUrl;
      // host の無い http:// は繋ぎ先にならないので、形だけでなく URL として読めることを確かめる。
      if (typeof v !== 'string' || !parseHttpUrl(v)) return c.json({ error: '「LM Studio の URL」は http か https で始まる URL にしてください' }, 400);
      // 末尾の / は付けない。呼び出し側が /v1/... を足すので、二重の / を作らない。
      patch.lmStudioUrl = v.replace(/\/+$/, '');
    }
    if ('lmStudioModel' in body) {
      const v = body.lmStudioModel;
      if (v !== null && typeof v !== 'string') return c.json({ error: '「モデル」の値の形が違います' }, 400);
      // 空文字と空白だけの文字列は「未設定」と同じ意味なので null に寄せる。
      // 前後の空白は落とす。パス系の設定と同じ扱いにそろえる。
      patch.lmStudioModel = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    }
    if ('summaryFallback' in body) {
      const v = body.summaryFallback;
      if (typeof v !== 'boolean') return c.json({ error: '「LM Studio が使えないとき Claude へ切り替える」の値の形が違います' }, 400);
      patch.summaryFallback = v;
    }
    if ('summaryHourlyCap' in body) {
      const v = body.summaryHourlyCap;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > SUMMARY_HOURLY_CAP_MAX) return c.json({ error: `「1 時間の上限」は 1 から ${SUMMARY_HOURLY_CAP_MAX} までの整数にしてください` }, 400);
      patch.summaryHourlyCap = v;
    }
    if ('allowExternalSummarizer' in body) {
      const v = body.allowExternalSummarizer;
      if (typeof v !== 'boolean') return c.json({ error: '「外部の要約器を許す」の値の形が違います' }, 400);
      patch.allowExternalSummarizer = v;
    }
    // Claude Code 設定の同期の入り切り。UI のチェックはこの項目だけを送る。
    // ここが無いと patch が空になり、切り替えが「更新できる設定が含まれていません」で弾かれる。
    if ('syncClaudeConfig' in body) {
      const v = body.syncClaudeConfig;
      if (typeof v !== 'boolean') return c.json({ error: '「Claude Code の設定を同期する」の値の形が違います' }, 400);
      patch.syncClaudeConfig = v;
    }
    // 言語はこの PC の設定で、画面の文とサーバの文の両方が読む。辞書にある言語だけを受ける。
    if ('language' in body) {
      const v = body.language;
      if (!isLanguage(v)) return c.json({ error: `「言語」は ${LANGUAGES.join(' か ')} から選んでください` }, 400);
      patch.language = v;
    }
    if (Object.keys(patch).length === 0) return c.json({ error: '更新できる設定が含まれていません' }, 400);
    // 要約器には会話の本文が送られる。宛先は既定でループバックだけにし、明示の許しがあるときだけ外へ出す。
    // 許しと宛先は同じ要求で見る。片方ずつ変えて素通りする隙間を作らない。
    const cur = deps.settings();
    const allowExternal = patch.allowExternalSummarizer ?? cur.allowExternalSummarizer;
    const nextLmUrl = patch.lmStudioUrl ?? cur.lmStudioUrl;
    if (!allowExternal && !isLoopbackSummarizerUrl(nextLmUrl)) {
      return c.json({ error: '要約器の宛先は 127.0.0.1 か localhost だけです。会話の本文が送られるため、ほかの宛先は、設定の「外部の要約器を許す」を入れてから指定してください' }, 400);
    }
    const before = deps.settings();
    const s = deps.updateSettings(patch);
    // ワークスペースが変わったら、その場でプロジェクトを登録し直す。
    // 登録したプロジェクトと、そこへ入ったセッションは、書いた行から配る層が配る。
    // claudeDir の変更は索引の読み取り元なので、次の起動で反映する。
    if (patch.workspaceRoot !== undefined && patch.workspaceRoot !== before.workspaceRoot) {
      syncProjectsFromWorkspace(db, deviceId, patch.workspaceRoot);
      assignSessions(db, deviceId);
    }
    // 保存の知らせは画面が欄の横に出す（設定の C1）。サーバからはトーストを配らない。
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
  // 設定を開いたときは refresh=1 で取り直す。一時停止の間は取りに行かず、最後の値を返す（CloudUsagePoller が守る）。
  api.get('/sync/usage', async (c) => c.json(c.req.query('refresh') === '1' ? await deps.cloudUsage.refresh() : deps.cloudUsage.current()));
  api.get('/devices', (c) => c.json(deps.devices()));
  // 参加トークンは全セッションの読み書き権を持つ。ログには出さず、UI が押したときだけ取りに来る。
  api.get('/sync/joinToken', (c) => c.json({ token: deps.joinToken() }));
  api.get('/sync/config/preview', (c) => (deps.configSync ? c.json(deps.configSync.preview()) : c.json({ error: 'クラウド同期が設定されていません' }, 404)));
  api.post('/sync/config/pull', async (c) => (deps.configSync ? c.json(await deps.configSync.pull()) : c.json({ error: 'クラウド同期が設定されていません' }, 404)));

  runRoutes(api, deps);
  api.post('/projects', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { kind?: unknown; name?: unknown; path?: unknown; gitInit?: unknown };
    try {
      let projectId: string;
      let created = true;
      if (body.kind === 'newDir') {
        if (typeof body.name !== 'string') return c.json({ error: 'name は必須です' }, 400);
        ({ projectId } = createProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot, gitInit: deps.gitInit }, { name: body.name, gitInit: body.gitInit === true }));
      } else if (body.kind === 'dir') {
        if (typeof body.path !== 'string') return c.json({ error: 'path が存在するディレクトリではありません' }, 400);
        ({ projectId, created } = registerProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot }, { path: body.path, name: typeof body.name === 'string' ? body.name : undefined }));
      } else {
        return c.json({ error: 'kind は newDir か dir です' }, 400);
      }
      // 登録済みでも、アーカイブから戻したときは行が変わるので、配る層がほかの画面へ配る。
      return c.json(getProject(db, deviceId, deps.live(), projectId)!, created ? 201 : 200);
    } catch (e) {
      if (e instanceof ProjectCreateError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  api.get('/workspace/dirs', (c) => c.json(listWorkspaceDirs(db, deviceId, deps.settings().workspaceRoot)));
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
    // 使用率は、動かしたアカウントの値として accounts.update で配る。最初のアカウントも同じ道で届く。
    if (r.usageChanged) accountsDeps.broadcast(buildAccountsDto(accountsDeps));
    if (r.providerSessionId) {
      // 受けた値は手元だけの表（session_live_stats）に入る。セッションの行は変わらないが中身（モデル、文脈の量）が変わるので、名指しして配り直してもらう。
      const s = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(r.providerSessionId) as { id: string } | undefined;
      if (s) touchRow(db, 'sessions', s.id);
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
  api.get('/shell-hook', (c) => c.json(deps.shellHook()));
  api.get('/readiness', async (c) => c.json(await deps.readiness()));
  api.get('/compat', async (c) => c.json(await deps.compat()));

  // TODO。変更のたびに、一覧とプロジェクト（未完の数）を、書いた行から配る層が配る。
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
    return c.json(addTodo(db, deviceId, { projectId: id, text: body.text }), 201);
  });
  api.patch('/todos/:id', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { done?: unknown };
    if (typeof body.done !== 'boolean') return c.json({ error: 'done は true か false です' }, 400);
    const t = setTodoDone(db, deviceId, c.req.param('id'), body.done);
    if (!t) return c.json({ error: 'TODO が見つかりません' }, 404);
    return c.json(t);
  });
  // 完了の候補の確定と却下。どちらも利用者の操作で、MCP からは呼べない。
  const NOT_CANDIDATE = 'この TODO は完了の候補ではありません';
  api.post('/todos/:id/confirm', (c) => {
    const r = confirmTodo(db, deviceId, c.req.param('id'));
    if (!r) return c.json({ error: 'TODO が見つかりません' }, 404);
    if (r.result === 'not_candidate') return c.json({ error: NOT_CANDIDATE }, 409);
    return c.json(r.todo);
  });
  api.post('/todos/:id/reject', (c) => {
    const r = rejectTodo(db, deviceId, c.req.param('id'));
    if (!r) return c.json({ error: 'TODO が見つかりません' }, 404);
    if (r.result === 'not_candidate') return c.json({ error: NOT_CANDIDATE }, 409);
    return c.json(r.todo);
  });
  api.delete('/todos/:id', (c) => {
    const t = removeTodo(db, deviceId, c.req.param('id'));
    if (!t) return c.json({ error: 'TODO が見つかりません' }, 404);
    return c.json(t);
  });

  // メモ。DB とファイルの両方に書く。ここからの書き込みも、MemoStore の監視が取り込んだファイルの外部編集も、配る層（events/publisher.ts）が配る。
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
    return c.json(deps.memos.write(id, body.markdown));
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
  api.get('/summarizer/models', async (c) => c.json({ models: await deps.summary.listModels() }));
  api.post('/summarizer/test', async (c) => c.json(await deps.summary.test()));

  app.route('/api', api);
  // MCP は自前の認証と Origin の検査を持つので、/api の認証を通さずに直接 mount する。
  app.route('/mcp', createMcpApp({ db, deviceId, port: deps.port, token: deps.token, live: deps.live, runs: deps.runs, usage: () => deps.usage.current(), accounts: deps.accounts, memos: deps.memos }));

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
