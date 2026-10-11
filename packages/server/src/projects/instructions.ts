import fs from 'node:fs';
import path from 'node:path';
import type { InstructionFileDto, InstructionFileKind } from '@agent-hangar/shared';

/**
 * 指示とメモリのファイルを探す手がかり。
 * configDir は Claude Code の設定フォルダ（いま選んでいるアカウントのもの）、homeDir は利用者のホームである。
 * maxBytes は本文を返す上限で、越えた分は返さない。
 */
export type InstructionsEnv = { configDir: string; homeDir: string; maxBytes?: number };

/** 本文を返す上限の既定。CLAUDE.md は 200 行ほどが目安で、自動メモリの MEMORY.md は 25KB までしか読まれない。 */
const DEFAULT_MAX_BYTES = 256 * 1024;

/** 並べる順と、プロジェクトのフォルダから見た名前。memory はプロジェクトの外にあるので、名前だけを持つ。 */
const PROJECT_FILES: readonly { kind: Exclude<InstructionFileKind, 'memory'>; rel: string }[] = [
  { kind: 'project', rel: 'CLAUDE.md' },
  { kind: 'projectDotClaude', rel: '.claude/CLAUDE.md' },
  { kind: 'local', rel: 'CLAUDE.local.md' },
  { kind: 'agents', rel: 'AGENTS.md' },
];
const MEMORY_NAME = 'MEMORY.md';

/** AGENTS.md の代わりに読まれる、CLAUDE.md の類。 */
const CLAUDE_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 設定の Project instructions（AGENTS.md を読む組み込みのプラグインの instructionFiles）。
 * Claude Code は利用者の settings.json からだけ読み、プロジェクトとローカルの設定では無視する。v2.1.285 より前の id も読む。
 */
function instructionFilesMode(env: InstructionsEnv): string {
  const configs = readJson(path.join(env.configDir, 'settings.json'))?.pluginConfigs as Record<string, { options?: { instructionFiles?: unknown } }> | undefined;
  for (const id of ['cc-plugin-agents-md@builtin', 'agents-md@builtin']) {
    const v = configs?.[id]?.options?.instructionFiles;
    if (typeof v === 'string') return v;
  }
  return 'claude-md-or-agents-md';
}

/**
 * プロジェクトのフォルダとその上に CLAUDE.md の類があるか。
 * 利用者の ~/.claude/CLAUDE.md は数えない（ホームの .claude/CLAUDE.md がそれに当たる）。設定フォルダの CLAUDE.md も同じである。
 */
function hasClaudeFile(projectPath: string, env: InstructionsEnv): boolean {
  const userFiles = new Set([path.join(env.homeDir, '.claude', 'CLAUDE.md'), path.join(env.configDir, 'CLAUDE.md')]);
  for (let dir = projectPath; ; dir = path.dirname(dir)) {
    if (CLAUDE_FILES.some((rel) => { const p = path.join(dir, rel); return !userFiles.has(p) && isFile(p); })) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/** AGENTS.md を Claude Code が起動時に読むか。既定では、CLAUDE.md の類が無いときだけ読む。 */
function agentsRead(projectPath: string, env: InstructionsEnv): boolean {
  const mode = instructionFilesMode(env);
  if (mode === 'claude-md-and-agents-md') return true;
  if (mode === 'claude-md' || mode === 'managed-only') return false;
  return !hasClaudeFile(projectPath, env);
}

/**
 * 自動メモリの場所を決める git のリポジトリの根。
 * worktree（.git がファイル）は gitdir の commondir をたどり、元のリポジトリの根にする。git の外ならプロジェクトのフォルダである。
 */
function repoRoot(projectPath: string): string {
  for (let dir = projectPath; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    let st: fs.Stats | null = null;
    try { st = fs.statSync(dotGit); } catch { st = null; }
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return dir;
      const gitdir = path.resolve(dir, m[1]!.trim());
      try {
        const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
        return path.basename(common) === '.git' ? path.dirname(common) : dir;
      } catch {
        return dir;
      }
    }
    if (path.dirname(dir) === dir) return projectPath;
  }
}

/** autoMemoryDirectory の値を絶対パスにする。絶対パスか ~/ で始まるものだけを受け、ほかは null。 */
function memoryDirSetting(v: unknown, homeDir: string): string | null {
  if (typeof v !== 'string' || v === '') return null;
  if (v.startsWith('~/')) return path.join(homeDir, v.slice(2));
  return path.isAbsolute(v) ? v : null;
}

/**
 * 自動メモリのフォルダ。
 * autoMemoryDirectory はローカル、プロジェクト、利用者の設定の順に効く。無ければ <設定フォルダ>/projects/<リポジトリの根の slug>/memory である。
 * slug は英数字以外を - にしたもの（sync/config/ids.ts の slugOfPath と同じ規則）。
 */
function memoryDir(projectPath: string, env: InstructionsEnv): string {
  const sources = [path.join(projectPath, '.claude', 'settings.local.json'), path.join(projectPath, '.claude', 'settings.json'), path.join(env.configDir, 'settings.json')];
  for (const file of sources) {
    const dir = memoryDirSetting(readJson(file)?.autoMemoryDirectory, env.homeDir);
    if (dir) return dir;
  }
  return path.join(env.configDir, 'projects', repoRoot(projectPath).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
}

/** 種類ごとのファイルのパス（あるかは問わない）。 */
function pathOf(projectPath: string, kind: InstructionFileKind, env: InstructionsEnv): string {
  if (kind === 'memory') return path.join(memoryDir(projectPath, env), MEMORY_NAME);
  return path.join(projectPath, PROJECT_FILES.find((f) => f.kind === kind)!.rel);
}

/** 本文を上限まで読む。UTF-8 の文字の途中で切らないよう、切れた最後の文字は落とす。 */
function readHead(file: string, size: number, maxBytes: number): { markdown: string | null; truncated: boolean } {
  try {
    if (size <= maxBytes) return { markdown: fs.readFileSync(file, 'utf8'), truncated: false };
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, maxBytes, 0); } finally { fs.closeSync(fd); }
    let end = maxBytes;
    // 末尾から、文字の先頭のバイト（10xxxxxx でないもの）を探し、その文字が収まり切っていなければ落とす。
    let i = end - 1;
    while (i > 0 && (buf[i]! & 0xc0) === 0x80) i--;
    const lead = buf[i]!;
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (i + need > end) end = i;
    return { markdown: buf.subarray(0, end).toString('utf8'), truncated: true };
  } catch {
    return { markdown: null, truncated: false };
  }
}

/**
 * プロジェクトの指示とメモリのファイルのうち、あるものを決まった順に返す。
 * 並べるのはルートの CLAUDE.md、.claude/CLAUDE.md、CLAUDE.local.md、AGENTS.md と、自動メモリの MEMORY.md である。
 * 親フォルダの CLAUDE.md、~/.claude/CLAUDE.md、.claude/rules、@import は並べない（読まれるものの全体は /context で見る）。
 * ファイルは作らず、読むだけである。
 */
export function readInstructions(projectPath: string, env: InstructionsEnv): InstructionFileDto[] {
  const maxBytes = env.maxBytes ?? DEFAULT_MAX_BYTES;
  const entries: { kind: InstructionFileKind; name: string }[] = [...PROJECT_FILES.map((f) => ({ kind: f.kind, name: f.rel })), { kind: 'memory', name: MEMORY_NAME }];
  const out: InstructionFileDto[] = [];
  for (const e of entries) {
    const file = pathOf(projectPath, e.kind, env);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    const read = e.kind === 'agents' ? agentsRead(projectPath, env) : true;
    out.push({ kind: e.kind, name: e.name, size: st.size, updatedAt: Math.round(st.mtimeMs), read, ...readHead(file, st.size, maxBytes) });
  }
  return out;
}

/** エディタで開くファイルのパス。無ければ null（作らない）。 */
export function instructionFilePath(projectPath: string, kind: InstructionFileKind, env: InstructionsEnv): string | null {
  const file = pathOf(projectPath, kind, env);
  return isFile(file) ? file : null;
}
