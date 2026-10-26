import os from 'node:os';
import path from 'node:path';
import { getJsonc, removeJsonc, setJsonc } from '../edit/index.ts';
import { CLAUDE_MCP_PREFIX } from './mcpCommon.ts';
import { createMcpTarget, readConfigFile, type McpApplyOptions, type McpTargetSpec } from './mcpTarget.ts';
import type { McpEdit, McpFlavor } from './mcpWrite.ts';
import { planMcpFilesWith, planMcpWith, writeMcpWith } from './mcpTarget.ts';
import { defaultTargetPaths } from './paths.ts';

/**
 * Claude の MCP サーバー（`~/.claude.json` の `mcpServers.<名前>`）。id は `claude-mcp:<名前>`。
 *
 * `~/.claude.json` は大きく、Claude Code が頻繁に書く。読むのは mcpServers だけで、書くのも mcpServers の鍵 1 つずつだけにする。
 * 書き方は jsonc の差し替え（S2）で、整形、並び、ほかの鍵はそのまま残る。書く直前に読み直し、書いた後にもう一度読んで確かめる（mcpWrite.ts）。
 * 控えは `backups/claude-mcp-config/<時刻>/` に取り、取れなければ書かない。
 * 古い版は `claude-mcp:` を知らない（運ばない）ので、claude の対象とは別にして、古い版の束で消去に見えないようにする。
 */
export const CLAUDE_MCP_NAME = 'claude-mcp';

const flavor: McpFlavor = {
  name: CLAUDE_MCP_NAME,
  kind: 'claude',
  idPrefix: CLAUDE_MCP_PREFIX,
  itemKind: 'claude-mcp',
  backupDir: 'claude-mcp-config',
  targetOf: (name) => `.claude.json#mcpServers.${name}`,
  edit: (text, _rel, edits: McpEdit[]) => {
    let cur = text ?? '';
    for (const e of edits) cur = e.remove ? removeJsonc(cur, ['mcpServers', e.name]) : setJsonc(cur, ['mcpServers', e.name], e.value);
    return cur;
  },
  root: (text) => getJsonc(text, []),
  tablePath: ['mcpServers'],
};

const jsonPathOf = (o: { claudeJsonPath?: string }): string => o.claudeJsonPath ?? defaultTargetPaths(process.env, os.homedir()).claudeJsonPath;

export const claudeMcpSpec: McpTargetSpec = {
  flavor,
  available: () => true,
  read: (ctx) => {
    const f = readConfigFile(ctx.claudeJsonPath);
    if (f === 'absent' || f === 'blocked') return f;
    let json: unknown;
    try { json = JSON.parse(f.text); } catch { return 'blocked'; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return 'blocked';
    const servers = (json as Record<string, unknown>).mcpServers;
    if (servers === undefined) return { servers: {}, mtime: f.mtime };
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'blocked';
    return { servers: servers as Record<string, unknown>, mtime: f.mtime };
  },
  locate: (o) => { const p = jsonPathOf(o); return { root: path.dirname(p), rel: path.basename(p) }; },
};

export type ClaudeMcpApplyOptions = McpApplyOptions;
export const writeClaudeMcp = (o: McpApplyOptions) => writeMcpWith(claudeMcpSpec, o);
export const planClaudeMcp = (o: { home: string } & Pick<McpApplyOptions, 'claudeJsonPath' | 'exists' | 'userHome'>) => planMcpWith(claudeMcpSpec, o);
export const planClaudeMcpFiles = (o: { home: string } & Pick<McpApplyOptions, 'claudeJsonPath' | 'exists' | 'userHome'>) => planMcpFilesWith(claudeMcpSpec, o);
export const claudeMcpTarget = createMcpTarget(claudeMcpSpec);
