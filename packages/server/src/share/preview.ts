import fs from 'node:fs';
import type { SharePreviewAgent, SharePreviewDto } from '@agent-hangar/shared';
import { resolveRealFile } from '../provider/claude-code/config/claudeFileWrite.ts';
import { readCodexConfig } from '../provider/codex/share.ts';
import { codexShareLaunch, DEFAULT_SHARE_BUDGET } from './codex.ts';
import { opencodeShareConfig, userOpencodeConfig } from './opencode.ts';
import { claudeMcpServers, instructionSources } from './sources.ts';

/**
 * 設定の画面向けの、入にしたら何を渡すかの一覧（docs/superpowers/plans/2026-10-28-agent-share.md の T5）。
 * 作業フォルダは決まらないので、利用者の CLAUDE.md（Claude のいまのアカウントの置き場）と、利用者の MCP の登録（.claude.json の mcpServers）だけで作る。
 * 名前のぶつかりは、Codex はいまの Codex アカウントの config.toml、opencode は利用者のグローバルの opencode.json(c) で見る。
 * 読むだけで、何も書かない。秘密（env、headers の値）は返さない。
 */
export type SharePreviewOptions = {
  agent: SharePreviewAgent;
  /** Claude のいまのアカウントの置き場。 */
  claudeDir: string;
  /** その置き場の .claude.json（claudeJsonFor で決める）。 */
  claudeJsonPath: string;
  homeDir: string;
  /** いまの Codex アカウントの CODEX_HOME。 */
  codexHome: string;
  env: NodeJS.ProcessEnv;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(resolveRealFile(file), 'utf8')) as unknown; } catch { return null; }
}
function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** 登録の本文から、既定が無くて環境にも無い `${VAR}` の最初の名前を拾う。値は読まない。 */
function missingEnvName(raw: unknown, env: Record<string, string | undefined>): string | undefined {
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;
  for (const m of JSON.stringify(raw ?? null).matchAll(re)) if (m[2] === undefined && env[m[1]!] === undefined) return m[1];
  return undefined;
}

export function sharePreview(o: SharePreviewOptions): SharePreviewDto {
  const claudeJson = readJson(o.claudeJsonPath);
  const root = isObj(claudeJson) ? claudeJson : {};
  // フォルダごとの登録（projects）は作業フォルダが決まらないと使えないので、読ませない。
  const userJson = { ...root, projects: undefined };
  const files = instructionSources({ cwd: o.homeDir, claudeDir: o.claudeDir, homeDir: o.homeDir, exists: isFile }).filter((f) => f.scope === 'user');
  const mcp = claudeMcpServers({ cwd: o.homeDir, claudeJson: userJson, mcpJson: null, env: o.env, settings: [] }).filter((m) => m.source === 'user');
  const userServers = isObj(root.mcpServers) ? root.mcpServers : {};
  const withEnvName = <T extends { name: string; skipped?: string }>(m: T): T & { envName?: string } => {
    if (m.skipped !== 'missingEnv') return m;
    const envName = missingEnvName(userServers[m.name], o.env);
    return envName ? { ...m, envName } : m;
  };

  if (o.agent === 'codex') {
    const cx = readCodexConfig(o.codexHome);
    const { report } = codexShareLaunch({
      files: files.map((f) => ({ ...f, text: readText(f.path) })), mcp, codexMcpNames: cx.mcpNames, userFallback: cx.fallback, budget: DEFAULT_SHARE_BUDGET,
    });
    return { files: report.files, mcp: report.mcp.map(withEnvName) };
  }
  const user = userOpencodeConfig({ home: o.homeDir, cwd: o.homeDir, env: o.env });
  const { report } = opencodeShareConfig({ files, mcp, opencodeMcpNames: user.mcpNames, userInstructions: user.instructions });
  return {
    files: report.files.map((f) => ({ path: f.path, scope: f.scope, status: f.skipped ? 'agentsMd' : 'inline' })),
    mcp: report.mcp.map(withEnvName),
  };
}
