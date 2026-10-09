import fs from 'node:fs';
import type { Hono } from 'hono';
import type { ResolveAction } from '@agent-hangar/shared';
import { getProject, listProjects } from '../../db/queries.ts';
import { upsertShared } from '../../db/shared.ts';
import { createProjectDir, ProjectCreateError, registerProjectDir } from '../../projects/create.ts';
import { candidateDirs, listWorkspaceDirs, normalizeDir, resolveProject } from '../../projects/registry.ts';
import { errorText, translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, externalOf, readJson, tooLargeResult } from './common.ts';

/** プロジェクトの経路が使う依存。 */
export type ProjectRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live' | 'settings' | 'gitInit' | 'external' | 'token'> & LanguageDeps;

const STATUSES = new Set(['active', 'paused', 'done', 'archived']);
const RESOLVE_KINDS = new Set(['repoint', 'archive', 'unlink']);

/**
 * プロジェクトの経路。
 * 一覧と 1 件、状態の変更、置き場の候補と選び直し、作成と登録、未登録のフォルダの一覧、エディタとターミナルで開く、を持つ。
 */
export function projectRoutes(api: Hono, deps: ProjectRouteDeps): void {
  const language = deps.language;
  const tr = translatorOf(deps.language);
  const { db, deviceId } = deps;
  const external = externalOf(deps);

  api.get('/projects', (c) => c.json(listProjects(db, deviceId, deps.live())));
  api.get('/projects/:id', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    return p ? c.json(p) : c.json({ error: tr('project.error.notFound') }, 404);
  });
  api.patch('/projects/:id', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { status?: string };
    if (!body.status || !STATUSES.has(body.status)) return c.json({ error: tr('project.status.invalid') }, 400);
    const row = db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: tr('project.error.notFound') }, 404);
    upsertShared(db, 'projects', { ...row, status: body.status }, deviceId);
    return c.json(getProject(db, deviceId, deps.live(), id)!);
  });
  api.get('/projects/:id/candidates', (c) => c.json(candidateDirs(deps.settings().workspaceRoot, c.req.query('name') ?? '')));
  api.post('/projects/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const action = (b.value ?? null) as ResolveAction | null;
    if (!action || !RESOLVE_KINDS.has(action.kind)) return c.json({ error: tr('project.resolve.badKind') }, 400);
    // repoint のパスは、存在を確かめる前に正規化する。検査する値と保存する値を 1 つにしておく。
    // `..` や末尾の `/` が残ると project_roots の前方一致に cwd が当たらず、
    // そのプロジェクトには永久にセッションが紐づかない（POST /api/projects と同じ理由である）。
    const target: ResolveAction = action.kind === 'repoint' && typeof action.path === 'string' ? { kind: 'repoint', path: normalizeDir(action.path) } : action;
    if (target.kind === 'repoint' && (typeof target.path !== 'string' || !fs.existsSync(target.path))) return c.json({ error: tr('project.resolve.dirMissing') }, 400);
    if (!getProject(db, deviceId, deps.live(), id)) return c.json({ error: tr('project.error.notFound') }, 404);
    // プロジェクトと、紐づけが変わったセッションは、書いた行から配る層が配る。
    resolveProject(db, deviceId, id, target);
    return c.json(getProject(db, deviceId, deps.live(), id) ?? { id, unlinked: true });
  });
  api.post('/projects', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { kind?: unknown; name?: unknown; path?: unknown; gitInit?: unknown };
    try {
      let projectId: string;
      let created = true;
      if (body.kind === 'newDir') {
        if (typeof body.name !== 'string') return c.json({ error: tr('http.request.required', { field: 'name' }) }, 400);
        ({ projectId } = createProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot, gitInit: deps.gitInit }, { name: body.name, gitInit: body.gitInit === true }));
      } else if (body.kind === 'dir') {
        if (typeof body.path !== 'string') return c.json({ error: tr('project.create.pathNotDir') }, 400);
        ({ projectId, created } = registerProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot }, { path: body.path, name: typeof body.name === 'string' ? body.name : undefined }));
      } else {
        return c.json({ error: tr('project.create.badKind') }, 400);
      }
      // 登録済みでも、アーカイブから戻したときは行が変わるので、配る層がほかの画面へ配る。
      return c.json(getProject(db, deviceId, deps.live(), projectId)!, created ? 201 : 200);
    } catch (e) {
      if (e instanceof ProjectCreateError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
  });
  api.get('/workspace/dirs', (c) => c.json(listWorkspaceDirs(db, deviceId, deps.settings().workspaceRoot)));
  api.post('/projects/:id/open-editor', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    if (!p?.path) return c.json({ error: tr('project.error.notFound') }, 404);
    return external(c, () => deps.external.openEditor({ target: p.path! }), true);
  });
  api.post('/projects/:id/open-terminal', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    if (!p?.path) return c.json({ error: tr('project.error.notFound') }, 404);
    return external(c, () => deps.external.openDirTerminal({ dir: p.path! }));
  });
}
