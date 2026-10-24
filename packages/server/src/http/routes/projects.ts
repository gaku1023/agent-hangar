import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import type { FolderRegisterItem, FolderRegisterPreviewDto, FolderRegisterResultDto, ProjectDto, ProjectNestedDto, ProjectSameFolderDto, ResolveAction, UnlinkPreviewDto } from '@agent-hangar/shared';
import { getProject, listProjects } from '../../db/queries.ts';
import { upsertShared } from '../../db/shared.ts';
import { createProjectDir, ProjectCreateError, ProjectNestedError, registerProjectDir } from '../../projects/create.ts';
import { inspectFolder, workspaceChildren } from '../../projects/folders.ts';
import { folderCandidates } from '../../projects/candidates.ts';
import { registerFolders } from '../../projects/registerMany.ts';
import { tryWrites } from '../../db/notify.ts';
import { assignSessions, candidateDirs, hasWorkspaceRoot, listWorkspaceDirs, mergeDirection, mergePreview, mergeProjects, normalizeDir, resolveProject, rootConflict } from '../../projects/registry.ts';
import { coversHome, samePath } from '../../platform/paths.ts';
import { errorText, translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, editorOptsOf, externalOf, readJson, tooLargeResult } from './common.ts';

/** プロジェクトの経路が使う依存。 */
export type ProjectRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'home' | 'live' | 'settings' | 'updateSettings' | 'gitInit' | 'external' | 'token' | 'candidateEnv' | 'sync' | 'trustWorkspace'> & LanguageDeps;

/** まとめて登録できるフォルダの数の上限。候補のダイアログで全部を選んでも収まる数にする。 */
const REGISTER_MAX = 500;

const STATUSES = new Set(['active', 'paused', 'done', 'archived']);

/** まとめて登録の 1 行の形か。path は文字列、linkTo は省くか文字列、allowNested は省くか真偽である。 */
function isRegisterItem(v: unknown): v is FolderRegisterItem {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.path === 'string' && (o.linkTo === undefined || typeof o.linkTo === 'string') && (o.allowNested === undefined || typeof o.allowNested === 'boolean');
}
const RESOLVE_KINDS = new Set(['repoint', 'archive', 'unlink']);

/**
 * プロジェクトの経路。
 * 一覧と 1 件、状態と名前の変更、置き場の候補と選び直し、作成と登録、未登録のフォルダの一覧、
 * Claude Code と会話したフォルダの候補とまとめての登録、親フォルダの直下の一覧と 1 つのフォルダの事前の問い合わせ、エディタとターミナルで開く、を持つ。
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
    // 試し（hangar project remove --dry-run）は一覧から削除（unlink）だけで受ける。
    // 名前と、未分類に戻る会話の数と、同期を使っているかを返し、何も書かない。
    const dryRun = (b.value as { dryRun?: unknown }).dryRun;
    if (dryRun !== undefined && (typeof dryRun !== 'boolean' || (dryRun && action.kind !== 'unlink'))) return c.json({ error: tr('common.field.required', { field: 'dryRun' }) }, 400);
    // repoint のパスは、存在を確かめる前に正規化する。検査する値と保存する値を 1 つにしておく。
    // `..` や末尾の `/` が残ると project_roots の前方一致に cwd が当たらず、
    // そのプロジェクトには永久にセッションが紐づかない（POST /api/projects と同じ理由である）。
    const target: ResolveAction = action.kind === 'repoint' && typeof action.path === 'string' ? { kind: 'repoint', path: normalizeDir(action.path), ...(action.merge === true ? { merge: true } : {}) } : action;
    if (target.kind === 'repoint' && (typeof target.path !== 'string' || !fs.existsSync(target.path))) return c.json({ error: tr('project.resolve.dirMissing') }, 400);
    const project = getProject(db, deviceId, deps.live(), id);
    if (!project) return c.json({ error: tr('project.error.notFound') }, 404);
    // 一覧から削除で未分類に戻る会話の数（消した会話は数えない）。
    const sessionCount = target.kind === 'unlink' ? (db.prepare('select count(*) c from sessions where project_id = ? and deleted_at is null').get(id) as { c: number }).c : 0;
    if (dryRun === true) {
      // 同期を使っていれば、プロジェクトの論理削除はほかの PC へも届き、そちらの一覧からも消える。
      const preview: UnlinkPreviewDto = { dryRun: true, id, name: project.name, path: project.path, sessionCount, syncing: deps.sync.status().state !== 'off' };
      return c.json(preview);
    }
    // 選んだフォルダが、この PC で別のプロジェクトの場所になっているとき（他の PC が同じフォルダを別の ID で登録していた）。
    // そのまま入れると同じフォルダを指すプロジェクトが 2 つになるので、まとめた後の姿を添えて断り、画面に確かめさせる。
    // merge を付けて来たら、まとめる方を残す方へまとめ、残す方を返す。クイックセッションはまとめず、理由だけで断る。
    const conflict = target.kind === 'repoint' ? rootConflict(db, deviceId, id, target.path) : null;
    if (conflict && target.kind === 'repoint') {
      const error = tr('project.resolve.sameFolder', { name: conflict.name });
      const other = getProject(db, deviceId, deps.live(), conflict.projectId);
      if (project.isScratch || !other || other.isScratch) return c.json({ error }, 409);
      const { fromId, intoId } = mergeDirection(db, deviceId, id, conflict.projectId, target.path);
      if (target.merge !== true) {
        const from = fromId === id ? project : other;
        const into = intoId === id ? project : other;
        const body: ProjectSameFolderDto = {
          error, code: 'project_same_folder',
          from: { projectId: from.id, name: from.name },
          conflict: { projectId: into.id, name: into.name, path: target.path },
          merged: mergePreview(db, deviceId, fromId, intoId),
        };
        return c.json(body, 409);
      }
      mergeProjects(db, deviceId, fromId, intoId);
      assignSessions(db, deviceId);
      return c.json(getProject(db, deviceId, deps.live(), intoId));
    }
    // プロジェクトと、紐づけが変わったセッションは、書いた行から配る層が配る。
    resolveProject(db, deviceId, id, target);
    return c.json(getProject(db, deviceId, deps.live(), id) ?? { id, unlinked: true, sessionCount });
  });
  api.post('/projects', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { kind?: unknown; name?: unknown; path?: unknown; gitInit?: unknown; parent?: unknown; allowNested?: unknown; linkTo?: unknown };
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
        if (body.linkTo !== undefined && typeof body.linkTo !== 'string') return c.json({ error: tr('common.field.required', { field: 'linkTo' }) }, 400);
        // allowNested は登録済みのプロジェクトの下のフォルダを分けることの明示で、無ければ 409（ProjectNestedDto）で包むプロジェクトを返す。
        // linkTo は、ほかの PC から届いたプロジェクトへ結び付けることの指定である（新しく作らない）。
        ({ projectId, created } = registerProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot }, {
          path: body.path, name: typeof body.name === 'string' ? body.name : undefined,
          allowNested: body.allowNested === true, linkTo: typeof body.linkTo === 'string' ? body.linkTo : undefined,
        }));
        // その下で動いた未分類のセッションを、その場で紐づける。呼ばないと、次の起動まで未分類のまま残る。
        // 紐づけが変わったセッションと入った先のプロジェクトは、書いた行から配る層が配る。
        assignSessions(db, deviceId);
      } else {
        return c.json({ error: tr('project.create.badKind') }, 400);
      }
      // 登録済みでも、アーカイブから戻したときは行が変わるので、配る層がほかの画面へ配る。
      return c.json(getProject(db, deviceId, deps.live(), projectId)!, created ? 201 : 200);
    } catch (e) {
      if (e instanceof ProjectNestedError) {
        const out: ProjectNestedDto = { error: errorText(language(), e), code: 'project_nested', enclosing: e.enclosing };
        return c.json(out, 409);
      }
      if (e instanceof ProjectCreateError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
  });
  api.get('/workspace/dirs', (c) => c.json(listWorkspaceDirs(db, deviceId, deps.settings().workspaceRoot)));
  // Claude Code と会話したフォルダの候補（初日のプロジェクト）。git の根でまとめ、会話の多い順に返す（projects/candidates.ts）。
  api.get('/workspace/candidates', (c) => c.json(folderCandidates(db, deviceId, { hangarHome: deps.home, workspaceRoot: deps.settings().workspaceRoot, ...deps.candidateEnv })));
  // 親フォルダの直下の一覧（まとめて登録の「フォルダの中から」）。行ごとに git、会話の数、登録済み、入れ子、結び付く候補を添える（projects/folders.ts）。
  api.get('/workspace/children', (c) => {
    try {
      return c.json(workspaceChildren(db, deviceId, c.req.query('parent') ?? ''));
    } catch (e) {
      if (e instanceof ProjectCreateError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
  });
  // 選んだ 1 つのフォルダの事前の問い合わせ（新しいセッションと新しいプロジェクトのダイアログ）。入れ子か、結び付く候補があるかを返す。
  api.get('/workspace/inspect', (c) => {
    try {
      return c.json(inspectFolder(db, deviceId, c.req.query('path') ?? '', c.req.query('name')));
    } catch (e) {
      if (e instanceof ProjectCreateError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
  });
  // 候補からまとめて登録する。1 件ずつ POST /api/projects の dir と同じ規則で登録し、最後に未分類の会話をまとめて紐づけ直す。
  // 本文は paths（パスの配列。どれも新しく作る）か items（行ごとに結び付け先 linkTo と入れ子の明示 allowNested を持つ）のどちらか一方である。
  // 登録できなかったものは、断らずに理由を添えて返す（ほかの登録は残す）。プロジェクトと紐づけ直した会話は、書いた行から配る層が配る。
  // 作業フォルダのフォルダの信頼（hangar workspace set --trust）。セットアップのすゝめが利用者の同意を取ってから呼ぶ。
  // 本番はいまの作業フォルダだけを受け、同意を設定（trustedWorkspaceRoot）に残してから、登録したアカウントの .claude.json に書く。
  // 同意を残すので、後から作業フォルダの下に置いたリポジトリも、hangar から起こすときに信頼済みにする（runs/manager.ts の trustFolder）。
  // 試しは、作業フォルダを保存する前の見せ方にも使うので、まだ作業フォルダにしていない場所も受ける。何も書かず、同意も残さない。
  api.post('/workspace/trust', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const { path: raw, dryRun } = (b.value ?? {}) as { path?: unknown; dryRun?: unknown };
    if (typeof raw !== 'string' || !path.isAbsolute(raw)) return c.json({ error: tr('common.field.required', { field: 'path' }) }, 400);
    if (dryRun !== undefined && typeof dryRun !== 'boolean') return c.json({ error: tr('common.field.required', { field: 'dryRun' }) }, 400);
    if (!deps.trustWorkspace) return c.json({ error: tr('common.field.required', { field: 'trustWorkspace' }) }, 400);
    const root = path.resolve(raw);
    // ホームそのもの、ホームより上、ファイルシステムの根は、試しでも断る（CLI の hangar workspace set と同じ規則）。
    if (coversHome(root, path.resolve(deps.candidateEnv?.homeDir ?? os.homedir()))) return c.json({ error: tr('settings.trust.homeOrAbove', { path: root }) }, 400);
    const label = tr('settings.label.workspaceRoot');
    const st = fs.statSync(root, { throwIfNoEntry: false });
    if (!st) return c.json({ error: tr('settings.path.missing', { label, path: root }) }, 400);
    if (!st.isDirectory()) return c.json({ error: tr('settings.path.notDirectory', { label, path: root }) }, 400);
    if (dryRun === true) return c.json({ ...deps.trustWorkspace(root, true), consentRecorded: false });
    const current = deps.settings().workspaceRoot;
    if (!hasWorkspaceRoot(current)) return c.json({ error: tr('settings.trust.noRoot') }, 400);
    if (!samePath(normalizeDir(root), normalizeDir(current))) return c.json({ error: tr('settings.trust.notRoot', { path: root, root: current }) }, 400);
    // 同意は、書き込みが全部失敗しても残す。以後の起動で、起こすアカウントの設定に書くからである（runs/manager.ts の trustFolder）。
    // そのことを返事の note で明示し、失敗の行だけを見て「同意も取り消された」と読まれないようにする。
    deps.updateSettings({ trustedWorkspaceRoot: current });
    return c.json({ ...deps.trustWorkspace(current, false), consentRecorded: true, note: tr('settings.trust.consentRecorded') });
  });
  api.post('/workspace/register', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const { paths, items: rawItems, dryRun } = (b.value ?? {}) as { paths?: unknown; items?: unknown; dryRun?: unknown };
    if (dryRun !== undefined && typeof dryRun !== 'boolean') return c.json({ error: tr('common.field.required', { field: 'dryRun' }) }, 400);
    let items: FolderRegisterItem[];
    if (rawItems !== undefined && paths === undefined) {
      if (!Array.isArray(rawItems) || rawItems.length > REGISTER_MAX || !rawItems.every(isRegisterItem)) return c.json({ error: tr('common.field.required', { field: 'items' }) }, 400);
      items = rawItems;
    } else {
      if (rawItems !== undefined || !Array.isArray(paths) || paths.length > REGISTER_MAX || !paths.every((p): p is string => typeof p === 'string')) return c.json({ error: tr('common.field.required', { field: 'paths' }) }, 400);
      items = paths.map((p) => ({ path: p }));
    }
    const run = () => registerFolders({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot }, items, (e) => errorText(language(), e));
    // 試しは、登録と同じ関数を通してから巻き戻す（db/notify.ts の tryWrites）。
    // 行も changes も残らず、画面にも同期にも何も配らない。
    if (dryRun === true) {
      const preview: FolderRegisterPreviewDto = { dryRun: true, results: tryWrites(db, run) };
      return c.json(preview);
    }
    const results = run();
    const ids = results.flatMap((r) => (r.projectId === undefined ? [] : [r.projectId]));
    const linked = results.flatMap((r) => (r.status === 'linked' && r.projectId !== undefined ? [r.projectId] : []));
    const failed: FolderRegisterResultDto['failed'] = results.flatMap((r) => (r.error === undefined ? [] : [{ path: r.path, error: r.error }]));
    const projects = [...new Set(ids)].map((id) => getProject(db, deviceId, deps.live(), id)).filter((p): p is ProjectDto => p !== null && p !== undefined);
    const out: FolderRegisterResultDto = { projects, failed, linked, results };
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
