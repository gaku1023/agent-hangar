import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LaunchSpec } from '../../agent/types.ts';
import { claudeJsonFor } from '../claude-code/config/claudeJson.ts';
import { getToml } from '../../sync/config/edit/index.ts';
import { codexShareLaunch, DEFAULT_SHARE_BUDGET, type CodexShareLaunch } from '../../share/codex.ts';
import { readShareSources } from '../../share/sources.ts';

/**
 * 起動のたびに、Claude Code の指示と MCP の登録を読み、Codex の app-server に渡す形にする（計画 2026-10-28-agent-share の T3）。
 * 読む置き場は、起こす会話のアカウントのもの（Claude は CLAUDE_CONFIG_DIR、無ければ ~/.claude。Codex は CODEX_HOME、無ければ ~/.codex）。
 * どちらも何も書かない。
 */
export type CodexShareDeps = {
  /** 設定の codexShareInstructions と codexShareMcp。呼ばれた時点の値を読む。 */
  share: () => { instructions: boolean; mcp: boolean };
  homeDir?: string;
  /** `${VAR}` を展開する環境。hangar の環境を渡す。 */
  env?: Record<string, string | undefined>;
  budget?: number;
};

export type CodexConfig = { mcpNames: Set<string>; fallback: string[] | null };

export function readCodexConfig(codexHome: string): CodexConfig {
  let text: string;
  try { text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); } catch { return { mcpNames: new Set(), fallback: null }; }
  let servers: unknown;
  let fallback: unknown;
  try { servers = getToml(text, ['mcp_servers']); fallback = getToml(text, ['project_doc_fallback_filenames']); } catch { return { mcpNames: new Set(), fallback: null }; }
  const names = servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
  return { mcpNames: new Set(names), fallback: Array.isArray(fallback) && fallback.every((x) => typeof x === 'string') ? (fallback as string[]) : null };
}

/** 両方切なら null（今と同じ argv と環境にするため、呼び手は何も足さない）。 */
export function codexShareFor(spec: LaunchSpec, d: CodexShareDeps): CodexShareLaunch | null {
  const on = d.share();
  if (!on.instructions && !on.mcp) return null;
  const homeDir = d.homeDir ?? os.homedir();
  const claudeConfigDir = spec.env.CLAUDE_CONFIG_DIR?.trim() || null;
  const codexHome = spec.env.CODEX_HOME?.trim() || path.join(homeDir, '.codex');
  const src = readShareSources({ cwd: spec.cwd, claudeDir: claudeConfigDir ?? path.join(homeDir, '.claude'), homeDir, claudeJsonPath: claudeJsonFor(claudeConfigDir, homeDir), env: d.env ?? process.env });
  const cx = readCodexConfig(codexHome);
  return codexShareLaunch({
    files: on.instructions ? src.instructions : [],
    mcp: on.mcp ? src.mcp : [],
    codexMcpNames: cx.mcpNames,
    userFallback: cx.fallback,
    budget: d.budget ?? DEFAULT_SHARE_BUDGET,
    instructions: on.instructions,
  });
}
