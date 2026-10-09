import type { Hono } from 'hono';
import type { AppDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, syncStatusOf, tooLargeResult } from './common.ts';

/** 同期の経路が使う依存。 */
export type SyncRouteDeps = Pick<AppDeps, 'sync' | 'syncSkipped' | 'syncSweep' | 'syncOncePass' | 'cloudUsage' | 'devices' | 'joinToken' | 'configSync'>;

/** 同期の経路。状態、今すぐ同期、一時停止、前面化、使用量、端末の一覧、参加トークン、Claude Code 設定の下見と取り込みを持つ。 */
export function syncRoutes(api: Hono, deps: SyncRouteDeps): void {
  const syncStatus = syncStatusOf(deps);

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
}
