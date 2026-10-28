import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../config/jsonTextEdit.ts';
import { opencodeConfigPath } from '../provider/opencode/configFile.ts';
import { HANGAR_MCP_NAME, readShareSources, type ShareFile, type ShareMcp, type ShareSkipReason } from './sources.ts';

/**
 * Claude Code の指示と MCP を、opencode の設定（serve の OPENCODE_CONFIG_CONTENT に重ねる分）へ変える（docs/superpowers/plans/2026-10-28-agent-share.md の S1、S4、変換の表）。
 * 指示は `instructions` にファイルの絶対パスを並べる（opencode が自分で読む）。MCP は v2 の `mcp.servers.<名前>` である。
 * opencodeShareConfig は純粋な変換、opencodeShareFor はファイルを読む薄い包みである。どちらも何も書かない。
 */

export type OpencodeShareConfig = { instructions?: string[]; mcp?: { servers: Record<string, unknown> } };
export type OpencodeShareSkip = ShareSkipReason | 'conflict';
export type OpencodeShareReport = {
  files: ShareFile[];
  mcp: { name: string; source: ShareMcp['source']; transport: ShareMcp['transport']; skipped?: OpencodeShareSkip }[];
};

export type OpencodeShareInput = {
  files: ShareFile[];
  mcp: ShareMcp[];
  /** 利用者の opencode の設定にある MCP の名前。同じ名前は opencode の登録を使い、渡さない。 */
  opencodeMcpNames: Set<string>;
  /** 利用者の opencode.json(c) の instructions。opencode が配列を合わせるか置き換えるかが未確認なので、先に並べて保つ。 */
  userInstructions: string[];
};

function serverOf(m: ShareMcp): unknown {
  if (m.transport === 'stdio') {
    return { type: 'local', command: [m.command ?? '', ...(m.args ?? [])], ...(m.env && Object.keys(m.env).length ? { environment: m.env } : {}) };
  }
  return { type: 'remote', url: m.url ?? '', ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}) };
}

export function opencodeShareConfig(o: OpencodeShareInput): { config: OpencodeShareConfig; report: OpencodeShareReport } {
  const config: OpencodeShareConfig = {};
  const shared = o.files.filter((f) => !f.skipped).map((f) => f.path);
  if (shared.length) config.instructions = [...new Set([...o.userInstructions, ...shared])];

  const servers: Record<string, unknown> = {};
  const mcp: OpencodeShareReport['mcp'] = [];
  for (const m of o.mcp) {
    const head = { name: m.name, source: m.source, transport: m.transport };
    const skipped: OpencodeShareSkip | undefined = m.skipped ?? (m.name === HANGAR_MCP_NAME ? 'reserved' : o.opencodeMcpNames.has(m.name) ? 'conflict' : undefined);
    mcp.push(skipped ? { ...head, skipped } : head);
    if (!skipped) servers[m.name] = serverOf(m);
  }
  if (Object.keys(servers).length) config.mcp = { servers };
  return { config, report: { files: o.files, mcp } };
}

// ---- 利用者の opencode の設定 ----

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readConf(file: string): Record<string, unknown> | null {
  try {
    const j = parseJsonc(fs.readFileSync(file, 'utf8'));
    return isObj(j) ? j : null;
  } catch { return null; }
}

/**
 * 利用者の opencode の設定のうち、重ねるときに要る分。グローバル（opencodeConfigPath）を先に、プロジェクトは外の階から作業フォルダへの順に読む。
 * mcp の名前は、v1 の `mcp.<名前>` と v2 の `mcp.servers.<名前>` の両方を数える。読めない設定は無いものとして扱う。
 */
export function userOpencodeConfig(o: { home: string; cwd: string; env: NodeJS.ProcessEnv }): { instructions: string[]; mcpNames: Set<string> } {
  const files = [opencodeConfigPath(o.home, o.env)];
  const dirs: string[] = [];
  for (let d = path.resolve(o.cwd); ; ) {
    dirs.push(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  for (const d of dirs.reverse()) {
    for (const f of ['opencode.json', 'opencode.jsonc', path.join('.opencode', 'opencode.json'), path.join('.opencode', 'opencode.jsonc')]) files.push(path.join(d, f));
  }
  const instructions = new Set<string>();
  const mcpNames = new Set<string>();
  for (const f of files) {
    const j = readConf(f);
    if (!j) continue;
    if (Array.isArray(j.instructions)) for (const x of j.instructions) if (typeof x === 'string') instructions.add(x);
    if (isObj(j.mcp)) {
      for (const k of Object.keys(j.mcp)) if (k !== 'servers') mcpNames.add(k);
      if (isObj(j.mcp.servers)) for (const k of Object.keys(j.mcp.servers)) mcpNames.add(k);
    }
  }
  return { instructions: [...instructions], mcpNames };
}

export type OpencodeShareForOptions = {
  cwd: string;
  /** hangar の HOME（利用者の opencode の設定の場所の元）。 */
  home: string;
  /** 祖先をたどる上限（ホーム）。 */
  homeDir: string;
  /** Claude のいまのアカウントの置き場（CLAUDE_CONFIG_DIR。無ければ ~/.claude）。 */
  claudeDir: string;
  /** その置き場の .claude.json（claudeJsonFor で決める）。 */
  claudeJsonPath: string;
  env: NodeJS.ProcessEnv;
  /** 設定の opencodeShareOf の値。 */
  share: { instructions: boolean; mcp: boolean };
};

/** 2 つとも切なら null（読みにも行かず、serve の設定は今までと同じになる）。入なら、渡すものを設定の形で返す。 */
export function opencodeShareFor(o: OpencodeShareForOptions): OpencodeShareConfig | null {
  if (!o.share.instructions && !o.share.mcp) return null;
  const src = readShareSources({ cwd: o.cwd, claudeDir: o.claudeDir, homeDir: o.homeDir, claudeJsonPath: o.claudeJsonPath, env: o.env });
  const user = userOpencodeConfig({ home: o.home, cwd: o.cwd, env: o.env });
  const { config } = opencodeShareConfig({
    files: o.share.instructions ? src.instructions.map(({ text: _text, ...f }) => f) : [],
    mcp: o.share.mcp ? src.mcp : [],
    opencodeMcpNames: user.mcpNames,
    userInstructions: user.instructions,
  });
  return config;
}
