import fs from 'node:fs';
import type { Hono } from 'hono';
import type { FolderRegisterResultDto, ProjectDto, ResolveAction } from '@agent-hangar/shared';
import { getProject, listProjects } from '../../db/queries.ts';
import { upsertShared } from '../../db/shared.ts';
import { createProjectDir, ProjectCreateError, registerProjectDir } from '../../projects/create.ts';
import { folderCandidates } from '../../projects/candidates.ts';
import { assignSessions, candidateDirs, listWorkspaceDirs, normalizeDir, resolveProject } from '../../projects/registry.ts';
import { errorText, translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, editorOptsOf, externalOf, readJson, tooLargeResult } from './common.ts';

/** プロジェクトの経路が使う依存。 */
export type ProjectRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'home' | 'live' | 'settings' | 'gitInit' | 'external' | 'token' | 'candidateEnv'> & LanguageDeps;

/** まとめて登録できるフォルダの数の上限。候補のダイアログで全部を選んでも収まる数にする。 */
const REGISTER_MAX = 500;

const STATUSES = new Set(['active', 'paused', 'done', 'archived']);
const RESOLVE_KINDS = new Set(['repoint', 'archive', 'unlink']);

/**
 * プロジェクトの経路。
 * 一覧と 1 件、状態と名前の変更、置き場の候補と選び直し、作成と登録、未登録のフォルダの一覧、
 * Claude Code と会話したフォルダの候補とまとめての登録、エディタとターミナルで開く、を持つ。
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
    // 変えられるのは状態と名前で、どちらか一方だけでも、両方でもよい。何も変えない本文は断る。
    const body = (b.value ?? {}) as { status?: unknown; name?: unknown };
    const changesName = body.name !== undefined;
    const changesStatus = body.status !== undefined;
    if (!changesName && !changesStatus) return c.json({ error: tr('project.status.invalid') }, 400);
    if (changesStatus && (typeof body.status !== 'string' || !STATUSES.has(body.status))) return c.json({ error: tr('project.status.invalid') }, 400);
    const name = changesName && typeof body.name === 'string' ? body.name.trim() : '';
    if (changesName && name === '') return c.json({ error: tr('project.create.nameEmpty') }, 400);
    const row = db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: tr('project.error.notFound') }, 404);
    upsertShared(db, 'projects', { ...row, ...(changesStatus ? { status: body.status } : {}), ...(changesName ? { name } : {}) }, deviceId);
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
    const body = (b.value ?? {}) as { kind?: unknown; name?: unknown; path?: unknown; gitInit?: unknown; parent?: unknown };
    try {
      let projectId: string;
      let created = true;
      if (body.kind === 'newDir') {
        if (typeof body.name !== 'string') return c.json({ error: tr('common.field.required', { field: 'name' }) }, 400);
        // parent は作る場所。作成場所（設定）が空のとき、画面が Finder で選ばせて渡す。
        const parent = typeof body.parent === 'string' ? body.parent : undefined;
        ({ projectId } = createProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot, gitInit: deps.gitInit }, { name: body.name, gitInit: body.gitInit === true, parent }));
      } else if (body.kind === 'dir') {
        if (typeof body.path !== 'string') return c.json({ error: tr('project.create.pathNotDir') }, 400);
        ({ projectId, created } = registerProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot }, { path: body.path, name: typeof body.name === 'string' ? body.name : undefined }));
        // その下で動いた未分類のセッションを、その場で紐づける。呼ばないと、次の起動まで未分類のまま残る。
        // 紐づけが変わったセッションと入った先のプロジェクトは、書いた行から配る層が配る。
        assignSessions(db, deviceId);
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
  // Claude Code と会話したフォルダの候補（初日のプロジェクト）。git の根でまとめ、会話の多い順に返す（projects/candidates.ts）。
  api.get('/workspace/candidates', (c) => c.json(folderCandidates(db, deviceId, { hangarHome: deps.home, workspaceRoot: deps.settings().workspaceRoot, ...deps.candidateEnv })));
  // 候補からまとめて登録する。1 件ずつ POST /api/projects の dir と同じ規則で登録し、最後に未分類の会話をまとめて紐づけ直す。
  // 登録できなかったものは、断らずに理由を添えて返す（ほかの登録は残す）。プロジェクトと紐づけ直した会話は、書いた行から配る層が配る。
  api.post('/workspace/register', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const paths = (b.value as { paths?: unknown } | null)?.paths;
    if (!Array.isArray(paths) || paths.length > REGISTER_MAX || !paths.every((p): p is string => typeof p === 'string')) return c.json({ error: tr('common.field.required', { field: 'paths' }) }, 400);
    const ids: string[] = [];
    const failed: FolderRegisterResultDto['failed'] = [];
    for (const p of paths) {
      try {
        ids.push(registerProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot }, { path: p }).projectId);
      } catch (e) {
        if (!(e instanceof ProjectCreateError)) throw e;
        failed.push({ path: p, error: errorText(language(), e) });
      }
    }
    if (ids.length) assignSessions(db, deviceId);
    const projects = [...new Set(ids)].map((id) => getProject(db, deviceId, deps.live(), id)).filter((p): p is ProjectDto => p !== null && p !== undefined);
    const out: FolderRegisterResultDto = { projects, failed };
    return c.json(out);
  });
  api.post('/projects/:id/open-editor', async (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    if (!p?.path) return c.json({ error: tr('project.error.notFound') }, 404);
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const opts = editorOptsOf(b.value, false);
    if (opts === null) return c.json({ error: tr('session.file.badOptions') }, 400);
    return external(c, () => deps.external.openEditor({ target: p.path!, ...opts }), true);
  });
  api.post('/projects/:id/open-terminal', (c) => {
    const p = getProject(db, deviceId, deps.live(), c.req.param('id'));
    if (!p?.path) return c.json({ error: tr('project.error.notFound') }, 404);
    return external(c, () => deps.external.openDirTerminal({ dir: p.path! }));
  });
}
