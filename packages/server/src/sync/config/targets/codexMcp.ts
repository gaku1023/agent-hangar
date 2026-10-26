import os from 'node:os';
import { getToml, removeToml, setToml } from '../edit/index.ts';
import { CODEX_CONFIG_FILE } from '../ids.ts';
import { CODEX_MCP_PREFIX } from './mcpCommon.ts';
import { createMcpTarget, planMcpFilesWith, planMcpWith, readConfigFile, writeMcpWith, type McpApplyOptions, type McpTargetSpec } from './mcpTarget.ts';
import type { McpEdit, McpFlavor } from './mcpWrite.ts';
import { defaultTargetPaths } from './paths.ts';

/**
 * Codex の MCP サーバー（`$CODEX_HOME/config.toml` の `[mcp_servers.<名前>]` 表）。id は `codex:mcp:<名前>`。
 *
 * 表ごと（`env` や `http_headers` の小表も）1 項目で、書くときは表ごと差し替える（S2 の setToml）。コメントと並びは保つ。
 * 好みの鍵を書く codex の対象（`codex:toml:`）と同じ config.toml に書くが、どちらも書く直前に読み直して自分の鍵だけを差し替えるので、互いの鍵を消さない。
 * codex の対象は mcp_servers を読み飛ばし、この対象が別に集める。古い版は `codex:` を知らない（運ばない）。
 */
export const CODEX_MCP_NAME = 'codex-mcp';

const flavor: McpFlavor = {
  name: CODEX_MCP_NAME,
  kind: 'codex',
  idPrefix: CODEX_MCP_PREFIX,
  itemKind: 'codex-mcp',
  backupDir: 'codex-mcp-config',
  targetOf: (name) => `${CODEX_CONFIG_FILE}#mcp_servers.${name}`,
  edit: (text, _rel, edits: McpEdit[]) => {
    let cur = text ?? '';
    for (const e of edits) cur = e.remove ? removeToml(cur, ['mcp_servers', e.name]) : setToml(cur, ['mcp_servers', e.name], e.value);
    return cur;
  },
  root: (text) => getToml(text, []),
  tablePath: ['mcp_servers'],
};

const homeOf = (o: { codexHome?: string }): string => o.codexHome ?? defaultTargetPaths(process.env, os.homedir()).codexHome;

export const codexMcpSpec: McpTargetSpec = {
  flavor,
  // その PC で Codex が有効なときだけ。
  available: (ctx) => ctx.codexEnabled,
  read: (ctx) => {
    const f = readConfigFile(`${ctx.codexHome}/${CODEX_CONFIG_FILE}`);
    if (f === 'absent' || f === 'blocked') return f;
    let servers: unknown;
    try { servers = getToml(f.text, ['mcp_servers']); } catch { return 'blocked'; }
    if (servers === undefined) return { servers: {}, mtime: f.mtime };
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'blocked';
    return { servers: { ...(servers as Record<string, unknown>) }, mtime: f.mtime };
  },
  locate: (o) => ({ root: homeOf(o), rel: CODEX_CONFIG_FILE }),
};

export const writeCodexMcp = (o: McpApplyOptions) => writeMcpWith(codexMcpSpec, o);
export const planCodexMcp = (o: { home: string } & Pick<McpApplyOptions, 'codexHome' | 'exists' | 'userHome'>) => planMcpWith(codexMcpSpec, o);
export const planCodexMcpFiles = (o: { home: string } & Pick<McpApplyOptions, 'codexHome' | 'exists' | 'userHome'>) => planMcpFilesWith(codexMcpSpec, o);
export const codexMcpTarget = createMcpTarget(codexMcpSpec);
