import type { Context } from 'hono';
import type { Hono } from 'hono';
import { errorText, translatorOf } from '../../i18n/message.ts';
import { ConfigSyncError } from '../../sync/config/service.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, syncStatusOf, tooLargeResult } from './common.ts';

/** 同期の経路が使う依存。 */
export type SyncRouteDeps = Pick<AppDeps, 'sync' | 'syncSkipped' | 'syncSweep' | 'syncOncePass' | 'cloudUsage' | 'devices' | 'joinToken' | 'configSync' | 'configBundle'> & LanguageDeps;

/** 同期の経路。状態、今すぐ同期、一時停止、前面化、使用量、端末の一覧、参加トークン、Claude Code 設定の下見と取り込み（旧実装）、作り直した設定の同期（/config-sync/*）を持つ。 */
export function syncRoutes(api: Hono, deps: SyncRouteDeps): void {
  const tr = translatorOf(deps.language);
  const syncStatus = syncStatusOf(deps);

  // 同期。どれも既存の authMiddleware の下にあり、鍵付きの入口と 3 つの検査を通る。
  api.get('/sync/status', (c) => c.json(syncStatus()));
  api.post('/sync/now', async (c) => { await deps.sync.syncNow(); return c.json(syncStatus()); });
  api.post('/sync/pause', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { paused?: unknown };
    if (typeof body.paused !== 'boolean') return c.json({ error: tr('common.field.mustBeBoolean', { field: 'paused' }) }, 400);
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
  api.get('/sync/config/preview', (c) => (deps.configSync ? c.json(deps.configSync.preview()) : c.json({ error: tr('sync.error.notConfigured') }, 404)));
  api.post('/sync/config/pull', async (c) => (deps.configSync ? c.json(await deps.configSync.pull()) : c.json({ error: tr('sync.error.notConfigured') }, 404)));

  // 作り直した設定の同期。旧実装の /sync/config/* とは別の経路で、~/.claude に書く操作は持たない。
  // 書くのは hangar の置き場の「適用の指示書」だけで、適用は殻の命令と hangar config apply が行う。
  const bundle = async (c: Context, fn: (api: NonNullable<typeof deps.configBundle>) => unknown | Promise<unknown>, empty = false) => {
    const api = deps.configBundle;
    if (!api) return c.json({ error: tr('sync.error.notConfigured') }, 404);
    try {
      const r = await fn(api);
      return empty ? c.body(null, 204) : c.json(r as object | null);
    } catch (e) {
      if (e instanceof ConfigSyncError) return c.json({ error: errorText(deps.language(), e) }, e.status);
      throw e;
    }
  };
  api.get('/config-sync', (c) => bundle(c, (b) => b.dto()));
  api.get('/config-sync/outgoing', (c) => bundle(c, (b) => b.outgoing()));
  api.get('/config-sync/inbox', (c) => bundle(c, (b) => b.inbox()));
  api.get('/config-sync/conflicts', (c) => bundle(c, (b) => b.conflicts()));
  api.get('/config-sync/unsent', (c) => bundle(c, (b) => b.unsent()));
  // 送るのは自分のクラウドへの送信で、~/.claude には書かないので HTTP に載せてよい。
  api.post('/config-sync/unsent/:id/send', (c) => bundle(c, (b) => b.sendUnsent(c.req.param('id'))));
  api.get('/config-sync/backups', (c) => bundle(c, (b) => b.backups()));
  api.get('/config-sync/apply-order', (c) => bundle(c, (b) => b.applyOrder()));
  api.put('/config-sync/apply-order', async (c) => {
    if (!deps.configBundle) return c.json({ error: tr('sync.error.notConfigured') }, 404);
    const b = await readJson(c, BODY_LIMITS.configOrder);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.configOrder, tr);
    const items = (b.value as { items?: unknown } | undefined)?.items;
    if (!Array.isArray(items)) return c.json({ error: tr('configSync.error.badBody') }, 400);
    return bundle(c, (api) => api.putApplyOrder(items as Parameters<typeof api.putApplyOrder>[0]));
  });
  api.delete('/config-sync/apply-order', (c) => bundle(c, (b) => b.deleteApplyOrder(), true));
}
