import type { Hono } from 'hono';
import type { ArtifactDto } from '@agent-hangar/shared';
import { addManualArtifact, ArtifactInputError, getArtifact, listArtifacts } from '../../artifacts/queries.ts';
import type { AppDeps } from '../deps.ts';
import { BODY_LIMITS, externalOf, projectOf, readJson, tooLargeResult } from './common.ts';

/** アーティファクトの経路が使う依存。 */
export type ArtifactRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live' | 'external' | 'token'>;

/** アーティファクトの経路。一覧、URL の追加、ブラウザとエディタで開く、を持つ。 */
export function artifactRoutes(api: Hono, deps: ArtifactRouteDeps): void {
  const { db, deviceId } = deps;
  const requireProject = projectOf(deps);
  const external = externalOf(deps);

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
}
