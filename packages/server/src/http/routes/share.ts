import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { PRIMARY_ACCOUNT_ID, type SharePreviewAgent } from '@agent-hangar/shared';
import { translatorOf } from '../../i18n/message.ts';
import { claudeJsonFor } from '../../provider/claude-code/config/claudeJson.ts';
import { sharePreview } from '../../share/preview.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';

/** Claude Code の指示と MCP を渡す設定の一覧の経路が使う依存。 */
export type ShareRouteDeps = Pick<AppDeps, 'accounts' | 'shareHome'> & LanguageDeps;

/**
 * 設定の「Claude Code の指示 / MCP を渡す」の下に出す一覧（share/preview.ts）。
 * スイッチの入切に関係なく、入にしたら何を渡すかを返す。読むだけで、何も書かない。
 */
export function shareRoutes(api: Hono, deps: ShareRouteDeps): void {
  const tr = translatorOf(deps.language);
  api.get('/share/preview', (c) => {
    const agent = c.req.query('agent');
    if (agent !== 'codex' && agent !== 'opencode') return c.json({ error: tr('common.field.needed', { field: 'agent' }) }, 400);
    const homeDir = deps.shareHome ?? os.homedir();
    const claude = deps.accounts.store.current();
    const codexHome = deps.accounts.codex?.store.current().dir ?? path.join(homeDir, '.codex');
    return c.json(sharePreview({
      agent: agent as SharePreviewAgent, claudeDir: claude.dir, claudeJsonPath: claudeJsonFor(claude.id === PRIMARY_ACCOUNT_ID ? null : claude.dir, homeDir),
      homeDir, codexHome, env: process.env,
    }));
  });
}
