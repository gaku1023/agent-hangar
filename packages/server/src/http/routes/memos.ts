import type { Hono } from 'hono';
import type { MemoDto } from '@agent-hangar/shared';
import type { AppDeps } from '../deps.ts';
import { BODY_LIMITS, projectOf, readJson, tooLargeResult } from './common.ts';

/** メモの経路が使う依存。 */
export type MemoRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live' | 'memos'>;

/** プロジェクトのメモの経路。読むと書くを持つ。 */
export function memoRoutes(api: Hono, deps: MemoRouteDeps): void {
  const requireProject = projectOf(deps);

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
}
