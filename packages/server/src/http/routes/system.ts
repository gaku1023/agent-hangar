import type { Hono } from 'hono';
import { statuslineStatus } from '../../provider/claude-code/config/statusline.ts';
import { errorText, translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';

/** 索引、準備の確かめ、互換、要約器の経路が使う依存。 */
export type SystemRouteDeps = Pick<AppDeps, 'indexer' | 'hub' | 'settings' | 'shellHook' | 'readiness' | 'compat' | 'summary'> & LanguageDeps;

/**
 * この PC の道具立ての経路。
 * 索引の作り直し、statusline と包み方の状態、準備の確かめ、Claude Code との互換、要約器のモデルと試しを持つ。
 */
export function systemRoutes(api: Hono, deps: SystemRouteDeps): void {
  const language = deps.language;
  const tr = translatorOf(deps.language);
  api.post('/index/rebuild', (c) => {
    void deps.indexer.rebuild().catch((e: unknown) => {
      deps.hub.broadcast({ type: 'toast', level: 'error', message: tr('system.index.rebuildFailed', { reason: errorText(language(), e) }) });
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
