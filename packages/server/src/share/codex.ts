import type { InjectionEntry } from '../agent/types.ts';
import type { ShareFile, ShareMcp, ShareSkipReason } from './sources.ts';

/**
 * Claude Code の指示と MCP の登録を、Codex の起動に渡す形へ変える純粋な変換（docs/superpowers/plans/2026-10-28-agent-share.md の S1、S5、S7 と変換の表）。
 * 何も読まず、何も書かない。返すのは app-server の `-c` の値（TOML）、app-server の環境に足す変数、追記の段、設定の画面向けの報告である。
 * 秘密（MCP の env と headers の値）は config に入れず、必ず env に入れる。config には環境変数の名前だけを書く。
 */

export type CodexShareFileStatus = 'inline' | 'pointer' | 'native' | 'agentsMd' | 'unreadable';
export type CodexShareSkip = ShareSkipReason | 'conflict' | 'sse';
export type CodexShareReport = {
  files: { path: string; scope: ShareFile['scope']; status: CodexShareFileStatus }[];
  /** 秘密を画面へ流さないよう、名前、出どころ、方式と理由だけを持つ。 */
  mcp: { name: string; source: ShareMcp['source']; transport: ShareMcp['transport']; skipped?: CodexShareSkip }[];
};
export type CodexShareLaunch = { config: string[]; env: Record<string, string>; instructions: InjectionEntry | null; report: CodexShareReport };

export type CodexShareOptions = {
  files: (ShareFile & { text: string | null })[];
  mcp: ShareMcp[];
  /** Codex の config.toml にすでにある MCP の名前。同じ名前は渡さない。 */
  codexMcpNames: Set<string>;
  /** 利用者の config.toml の project_doc_fallback_filenames。無ければ null。 */
  userFallback: string[] | null;
  /** 追記に入れる本文の合わせた上限（字）。Windows の引数の長さの上限（8191 字）に収めるため。 */
  budget: number;
  /** 指示を渡すか（既定は渡す）。偽なら fallback も段も作らない。 */
  instructions?: boolean;
};

/** 追記に入れる本文の合わせた上限の既定。 */
export const DEFAULT_SHARE_BUDGET = 4000;

/** TOML の基本文字列（launcher.ts の toml() と同じ書き方）。 */
const toml = (s: string): string => JSON.stringify(s);
const tomlList = (a: readonly string[]): string => JSON.stringify(a);

const heading = (f: ShareFile): string => `# Claude Code の指示（${f.path}）\n`;
const pointer = (f: ShareFile): string => `次のファイルも読んで従ってください：${f.path}\n`;

function instructionsPart(o: CodexShareOptions): { config: string[]; entry: InjectionEntry | null; files: CodexShareReport['files'] } {
  const files: CodexShareReport['files'] = [];
  const parts: string[] = [];
  let used = 0;
  for (const f of o.files) {
    if (f.skipped) { files.push({ path: f.path, scope: f.scope, status: 'agentsMd' }); continue; }
    // 作業フォルダの CLAUDE.md は、fallback の指定で Codex が自分で読む。本文は入れない。
    if (f.scope === 'project') { files.push({ path: f.path, scope: f.scope, status: 'native' }); continue; }
    if (f.text === null) { files.push({ path: f.path, scope: f.scope, status: 'unreadable' }); continue; }
    if (used + f.text.length > o.budget) {
      parts.push(`${pointer(f)}`);
      files.push({ path: f.path, scope: f.scope, status: 'pointer' });
      continue;
    }
    used += f.text.length;
    parts.push(`${heading(f)}${f.text.endsWith('\n') ? f.text : `${f.text}\n`}`);
    files.push({ path: f.path, scope: f.scope, status: 'inline' });
  }
  const fallback = [...(o.userFallback ?? [])];
  if (!fallback.includes('CLAUDE.md')) fallback.push('CLAUDE.md');
  return {
    config: [`project_doc_fallback_filenames=${tomlList(fallback)}`],
    entry: parts.length ? { key: 'share', text: `\n${parts.join('\n')}` } : null,
    files,
  };
}

/** 環境変数の名前に使える形（英数字と _）にする。 */
const envPart = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();

function mcpPart(o: CodexShareOptions): { config: string[]; env: Record<string, string>; mcp: CodexShareReport['mcp'] } {
  const config: string[] = [];
  const env: Record<string, string> = {};
  const used = new Set<string>();
  const report: CodexShareReport['mcp'] = [];
  for (const m of o.mcp) {
    const head = { name: m.name, source: m.source, transport: m.transport };
    const skip = (skipped: CodexShareSkip): void => { report.push({ ...head, skipped }); };
    if (m.skipped) { skip(m.skipped); continue; }
    if (o.codexMcpNames.has(m.name)) { skip('conflict'); continue; }
    if (m.transport === 'sse') { skip('sse'); continue; }
    // Codex の -c は鍵を点で区切るだけで、TOML の引用を解かない（引用符ごと名前になる。codex 0.165.0 で確かめた）。
    if (!/^[A-Za-z0-9_-]+$/.test(m.name)) { skip('invalid'); continue; }
    const key = `mcp_servers.${m.name}`;
    if (m.transport === 'stdio') {
      if (!m.command) { skip('invalid'); continue; }
      const e = m.env ?? {};
      // env_vars は親の同じ名前の変数を渡すので、同じ名前で違う値が 2 つあれば後のものを渡さない。
      if (Object.entries(e).some(([k, v]) => k in env && env[k] !== v)) { skip('invalid'); continue; }
      Object.assign(env, e);
      config.push(`${key}.command=${toml(m.command)}`);
      if (m.args?.length) config.push(`${key}.args=${tomlList(m.args)}`);
      if (Object.keys(e).length) config.push(`${key}.env_vars=${tomlList(Object.keys(e))}`);
    } else {
      if (!m.url) { skip('invalid'); continue; }
      config.push(`${key}.url=${toml(m.url)}`);
      const pairs: string[] = [];
      Object.entries(m.headers ?? {}).forEach(([h, v], i) => {
        let name = `HANGAR_MCP_${envPart(m.name)}_${i}`;
        for (let n = 2; used.has(name); n += 1) name = `HANGAR_MCP_${envPart(m.name)}_${i}_${n}`;
        used.add(name);
        env[name] = v;
        pairs.push(`${toml(h)}=${toml(name)}`);
      });
      if (pairs.length) config.push(`${key}.env_http_headers={${pairs.join(',')}}`);
    }
    report.push(head);
  }
  return { config, env, mcp: report };
}

/** Codex の app-server に渡す共有の設定、環境、追記の段、報告を組む。 */
export function codexShareLaunch(o: CodexShareOptions): CodexShareLaunch {
  const withInstructions = o.instructions !== false;
  const ins = withInstructions ? instructionsPart(o) : { config: [], entry: null, files: [] };
  const mcp = mcpPart(o);
  return { config: [...ins.config, ...mcp.config], env: mcp.env, instructions: ins.entry, report: { files: ins.files, mcp: mcp.mcp } };
}
