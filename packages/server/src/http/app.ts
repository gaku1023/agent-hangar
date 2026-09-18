import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { newId, type BootstrapDto, type IndexProgressDto, type LaunchParams, type LiveSessionDto, type ResolveAction, type ServerEvent, type SettingsDto, type TerminalApp } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { createMcpApp } from '../mcp/app.ts';
import { assignSessions, candidateDirs, resolveProject, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { RunError, type RunManager } from '../runs/manager.ts';
import { searchSessions } from '../search/search.ts';
import { readEvents, subagentIds } from '../transcript/read.ts';
import { authMiddleware } from './auth.ts';

/** RunManager のうち HTTP から触る部分だけ。テストは偽物を渡せる。 */
export type RunsApi = Pick<RunManager, 'start' | 'resume' | 'fork' | 'kill' | 'openTab' | 'closeTab' | 'listAlive' | 'getRun' | 'getTab'>;
/** ターミナルとエディタへの受け渡し。設定を読むのは呼び手の役目にして、ここでは結果だけを扱う。 */
export type ExternalApi = {
  openTerminal(o: { tmuxName: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openDirTerminal(o: { dir: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openEditor(o: { target: string }): Promise<void>;
};
export type AppDeps = {
  db: Db; deviceId: string; deviceName: string; token: string; home: string; port: number; version: string;
  settings: () => Settings; updateSettings: (patch: Partial<SettingsDto>) => Settings;
  live: () => LiveSessionDto[];
  indexer: { progress(): IndexProgressDto; rebuild(): Promise<void> };
  hub: { broadcast(ev: ServerEvent): void };
  runs: RunsApi;
  external: ExternalApi;
  uiDist?: string;
};

const STATUSES = new Set(['active', 'paused', 'done', 'archived']);
const RESOLVE_KINDS = new Set(['repoint', 'archive', 'unlink']);
/** 空にできない文字列の設定。 */
const TEXT_SETTING_KEYS = ['workspaceRoot', 'claudeDir'] as const;
/** 未設定を null で表すパスの設定。空文字は null と同じに扱う。 */
const PATH_SETTING_KEYS = ['tmuxPath', 'codePath'] as const;
const TERMINAL_APPS = new Set<string>(['terminal', 'iterm']);
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' };

export const toSettingsDto = (s: Settings): SettingsDto => ({ workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir, tmuxPath: s.tmuxPath, terminalApp: s.terminalApp, codePath: s.codePath });
const numberOr = (v: string | undefined): number | undefined => (v ? Number(v) : undefined);
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** RunError は status 付きで返し、それ以外は投げ直す。 */
function runResult<T>(c: Context, fn: () => T, status: 200 | 201 = 200) {
  try {
    return c.json(fn() as object, status);
  } catch (e) {
    if (e instanceof RunError) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

/** 外部連携の失敗は 500 で理由を返す。UI はこれをそのままトーストに出す。 */
async function externalResult(c: Context, fn: () => Promise<unknown>, empty = false) {
  try {
    const r = await fn();
    return empty ? c.body(null, 204) : c.json(r as object);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

/** HTTP API を組み立てる。/api 配下は認証必須で、/health と UI 配信だけが素通しになる。 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { db, deviceId } = deps;

  app.get('/health', (c) => c.json({ ok: true, version: deps.version }));

  const api = new Hono();
  api.use('*', authMiddleware(deps.token));

  api.get('/bootstrap', (c) => {
    const live = deps.live();
    const alive = deps.runs.listAlive();
    const body: BootstrapDto = {
      device: { id: deviceId, name: deps.deviceName },
      settings: toSettingsDto(deps.settings()),
      projects: listProjects(db, deviceId, live),
      sessions: listSessions(db, live),
      live,
      runs: alive.runs,
      tabs: alive.tabs,
      index: deps.indexer.progress(),
      version: deps.version,
    };
    return c.json(body);
  });

  api.get('/projects', (c) => c.json(listProjects(db, deviceId, deps.live())));
  api.get('/projects/:id', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    return p ? c.json(p) : c.json({ error: 'not found' }, 404);
  });
  api.patch('/projects/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    if (!body.status || !STATUSES.has(body.status)) return c.json({ error: 'invalid status' }, 400);
    const row = db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: 'not found' }, 404);
    upsertShared(db, 'projects', { ...row, status: body.status }, deviceId);
    const p = getProject(db, deviceId, deps.live(), id)!;
    deps.hub.broadcast({ type: 'project.upsert', project: p });
    return c.json(p);
  });
  api.get('/projects/:id/candidates', (c) => c.json(candidateDirs(deps.settings().workspaceRoot, c.req.query('name') ?? '')));
  api.post('/projects/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const action = (await c.req.json().catch(() => null)) as ResolveAction | null;
    if (!action || !RESOLVE_KINDS.has(action.kind)) return c.json({ error: 'invalid action' }, 400);
    if (action.kind === 'repoint' && (typeof action.path !== 'string' || !fs.existsSync(action.path))) return c.json({ error: 'path not found' }, 400);
    if (!getProject(db, deviceId, deps.live(), id)) return c.json({ error: 'not found' }, 404);
    resolveProject(db, deviceId, id, action);
    const p = getProject(db, deviceId, deps.live(), id);
    if (p) deps.hub.broadcast({ type: 'project.upsert', project: p });
    // 紐づけが変わったセッションを絞り込めないので、全件を流して UI 側で置き換えてもらう。
    for (const s of listSessions(db, deps.live())) deps.hub.broadcast({ type: 'session.upsert', session: s });
    return c.json(p ?? { id, unlinked: true });
  });

  api.get('/sessions', (c) => c.json(listSessions(db, deps.live(), { projectId: c.req.query('projectId') })));
  api.get('/sessions/:id', (c) => {
    const s = getSession(db, deps.live(), c.req.param('id'));
    return s ? c.json(s) : c.json({ error: 'not found' }, 404);
  });
  api.get('/sessions/:id/events', (c) => {
    const q = c.req.query();
    try {
      return c.json(readEvents(db, c.req.param('id'), { fromSeq: numberOr(q.fromSeq), limit: numberOr(q.limit), agentId: q.agentId || null }));
    } catch (e) {
      // 索引はあるのに本文ファイルが消えている場合だけ 404 にし、他は 500 に任せる。
      if (isEnoent(e)) return c.json({ error: 'transcript not found' }, 404);
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
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
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
      patch[key] = typeof v === 'string' && v.trim() !== '' ? v : null;
    }
    if ('terminalApp' in body) {
      const v = body.terminalApp;
      if (typeof v !== 'string' || !TERMINAL_APPS.has(v)) return c.json({ error: 'terminalApp は terminal か iterm です' }, 400);
      patch.terminalApp = v as TerminalApp;
    }
    if (Object.keys(patch).length === 0) return c.json({ error: 'no known settings' }, 400);
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
        const sess = getSession(db, live, id);
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


  api.get('/runs', (c) => c.json(deps.runs.listAlive()));
  api.post('/runs', async (c) => {
    const params = (await c.req.json().catch(() => null)) as LaunchParams | null;
    if (!params || typeof params !== 'object') return c.json({ error: '本文が JSON ではありません' }, 400);
    return runResult(c, () => deps.runs.start(params), 201);
  });
  api.delete('/runs/:id', (c) => runResult(c, () => deps.runs.kill(c.req.param('id'))));
  // タブの追加と削除は本文を取らない。UI は content-type だけを付けた空の要求を送る。
  api.post('/runs/:id/tabs', (c) => runResult(c, () => deps.runs.openTab(c.req.param('id')), 201));
  api.delete('/runs/:id/tabs/:tabId', (c) => runResult(c, () => deps.runs.closeTab(c.req.param('tabId'))));
  api.post('/runs/:id/open-terminal', async (c) => {
    const run = deps.runs.getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'run が見つかりません' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { tabId?: string };
    let tmuxName = run.tmuxName;
    if (body.tabId) {
      const t = deps.runs.getTab(body.tabId);
      if (!t || t.runId !== run.id) return c.json({ error: 'タブが見つかりません' }, 404);
      tmuxName = t.tmuxName;
    }
    return externalResult(c, () => deps.external.openTerminal({ tmuxName }));
  });
  api.post('/sessions/:id/resume', (c) => runResult(c, () => deps.runs.resume(c.req.param('id')), 201));
  api.post('/sessions/:id/fork', (c) => runResult(c, () => deps.runs.fork(c.req.param('id')), 201));
  api.post('/sessions/:id/open-editor', (c) => {
    const s = getSession(db, deps.live(), c.req.param('id'));
    if (!s) return c.json({ error: 'セッションが見つかりません' }, 404);
    return externalResult(c, () => deps.external.openEditor({ target: s.cwd }), true);
  });
  api.post('/projects', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; path?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const dir = typeof body.path === 'string' ? body.path : '';
    if (!name) return c.json({ error: 'name は必須です' }, 400);
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return c.json({ error: 'path が存在するディレクトリではありません' }, 400);
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
    return externalResult(c, () => deps.external.openEditor({ target: p.path! }), true);
  });
  api.post('/projects/:id/open-terminal', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    if (!p?.path) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    return externalResult(c, () => deps.external.openDirTerminal({ dir: p.path! }));
  });

  app.route('/api', api);
  // MCP は自前の認証と Origin の検査を持つので、/api の認証を通さずに直接 mount する。
  app.route('/mcp', createMcpApp({ db, deviceId, port: deps.port, token: deps.token, live: deps.live, runs: deps.runs, hub: deps.hub }));

  if (deps.uiDist) {
    const dist = path.resolve(deps.uiDist);
    const assets = path.join(dist, 'assets');
    const index = () => fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    app.get('/', (c) => {
      c.header('Set-Cookie', `hangar_token=${deps.token}; HttpOnly; SameSite=Strict; Path=/`);
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
