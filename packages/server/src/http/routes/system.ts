import type { Hono } from 'hono';
import { statuslineStatus } from '../../config/statusline.ts';
import type { AppDeps } from '../deps.ts';

/** 索引、準備の確かめ、互換、要約器の経路が使う依存。 */
export type SystemRouteDeps = Pick<AppDeps, 'indexer' | 'hub' | 'settings' | 'shellHook' | 'readiness' | 'compat' | 'summary'>;

/**
 * この PC の道具立ての経路。
 * 索引の作り直し、statusline と包み方の状態、準備の確かめ、Claude Code との互換、要約器のモデルと試しを持つ。
 */
export function systemRoutes(api: Hono, deps: SystemRouteDeps): void {
  api.post('/index/rebuild', (c) => {
    void deps.indexer.rebuild().catch((e: unknown) => {
      deps.hub.broadcast({ type: 'toast', level: 'error', message: `索引の作り直しに失敗しました: ${e instanceof Error ? e.message : String(e)}` });
    });
    return c.body(null, 202);
  });
  api.get('/statusline', (c) => c.json(statuslineStatus(deps.settings().claudeDir)));
  api.get('/shell-hook', (c) => c.json(deps.shellHook()));
  api.get('/readiness', async (c) => c.json(await deps.readiness()));
  api.get('/compat', async (c) => c.json(await deps.compat()));
  api.get('/summarizer/models', async (c) => c.json({ models: await deps.summary.listModels() }));
  api.post('/summarizer/test', async (c) => c.json(await deps.summary.test()));
}
