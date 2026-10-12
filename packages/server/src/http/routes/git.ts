import path from 'node:path';
import type { Hono } from 'hono';
import { getProject } from '../../db/queries.ts';
import { translatorOf } from '../../i18n/message.ts';
import type { AppDeps, GitApi, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, sessionOf, tooLargeResult } from './common.ts';

/** git の経路が使う依存。 */
export type GitRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live'> & LanguageDeps & { git: GitApi };

/** 1 回で聞けるセッションの数。一覧の 1 ページ（最大 200 件）に合わせる。 */
const MAX_IDS = 200;

/**
 * git の表示（0.5.0）。どれも読むだけで、git には書かない。
 * 一覧と (i) の件数、変更したファイルの差分、プロジェクトのブランチと worktree。
 * 差分と編集は、そのセッションが編集系のツールで変えたファイルだけを読む（任意のパスを読ませない）。
 */
export function gitRoutes(api: Hono, deps: GitRouteDeps): void {
  const tr = translatorOf(deps.language);
  const session = sessionOf(deps);

  api.post('/git/sessions', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const ids = (b.value as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((x) => typeof x === 'string')) return c.json({ error: tr('git.error.badIds', { max: MAX_IDS }) }, 400);
    return c.json(await deps.git.sessions(ids as string[]));
  });

  api.get('/sessions/:id/changes', async (c) => {
    const s = session(c.req.param('id'));
    if (!s) return c.json({ error: tr('session.error.notFound') }, 404);
    return c.json(await deps.git.changes(s.id));
  });

  /** 差分と編集の対象のファイル。絶対パスでなければ断る。 */
  const fileOf = (raw: string | undefined) => (raw && path.isAbsolute(raw) ? raw : null);

  api.get('/sessions/:id/diff', async (c) => {
    const s = session(c.req.param('id'));
    if (!s) return c.json({ error: tr('session.error.notFound') }, 404);
    const file = fileOf(c.req.query('file'));
    if (!file) return c.json({ error: tr('session.file.mustBeAbsolute') }, 400);
    const d = await deps.git.diff(s.id, file);
    if (d === null) return c.json({ error: tr('session.file.notChanged') }, 404);
    if (d === 'nogit') return c.json({ error: tr('git.error.noTree') }, 409);
    return c.json(d);
  });

  api.get('/sessions/:id/edits', (c) => {
    const s = session(c.req.param('id'));
    if (!s) return c.json({ error: tr('session.error.notFound') }, 404);
    const file = fileOf(c.req.query('file'));
    if (!file) return c.json({ error: tr('session.file.mustBeAbsolute') }, 400);
    const e = deps.git.edits(s.id, file);
    if (e.edits.length === 0) return c.json({ error: tr('session.file.notChanged') }, 404);
    return c.json(e);
  });

  api.get('/projects/:id/git', async (c) => {
    const p = getProject(deps.db, deps.deviceId, deps.live(), c.req.param('id'));
    if (!p?.path) return c.json({ error: tr('project.error.notFound') }, 404);
    return c.json(await deps.git.project(p.path));
  });
}
