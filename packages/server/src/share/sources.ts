import fs from 'node:fs';
import path from 'node:path';
import { resolveRealFile } from '../provider/claude-code/config/claudeFileWrite.ts';

/**
 * Codex・opencode に渡す、Claude Code の指示（CLAUDE.md）と MCP の登録の読み手（docs/superpowers/plans/2026-10-28-agent-share.md の S2、S3）。
 * 純粋な部分（instructionSources、claudeMcpServers）は、ファイルの有無と JSON の値を受けて、渡すものと渡さないもの（理由つき）を返す。
 * ファイルを読む薄い包みは readShareSources である。ここはどれも読むだけで、何も書かない。
 */

export type ShareFile = { path: string; scope: 'user' | 'project' | 'local'; skipped?: 'agentsMd' };
export type ShareSkipReason = 'reserved' | 'invalid' | 'missingEnv' | 'disabled' | 'unapproved';
export type ShareMcp = {
  name: string;
  source: 'user' | 'local' | 'project';
  /** 形が壊れていて分からないときは、url があれば http、なければ stdio と置く（skipped: invalid が付く）。 */
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 渡さない理由。付いているものは、秘密を画面へ流さないよう、名前、出どころ、方式のほかを持たない。 */
  skipped?: ShareSkipReason;
};

/** hangar 自身の MCP の名前。利用者の登録と衝突させない。 */
export const HANGAR_MCP_NAME = 'hangar';

const slashed = (p: string): string => p.replaceAll('\\', '/');

// ---- 指示 ----

export type InstructionSourcesOptions = {
  cwd: string;
  /** Claude Code の設定フォルダ（アカウントの CLAUDE_CONFIG_DIR に従う）。 */
  claudeDir: string;
  /** 祖先をたどる上限。作業フォルダがホームの下にあるときは、ホームで止める。 */
  homeDir: string;
  exists: (file: string) => boolean;
};

/**
 * 渡す CLAUDE.md の一覧を、読まれる順（利用者、祖先の外側から作業フォルダ、CLAUDE.local.md）に返す。
 * 同じフォルダに AGENTS.md があれば、そのフォルダの CLAUDE.md と .claude/CLAUDE.md は skipped: agentsMd で返す（Codex・opencode が AGENTS.md を自分で読むため）。
 * @ の取り込みは展開しない。
 */
export function instructionSources(o: InstructionSourcesOptions): ShareFile[] {
  const out: ShareFile[] = [];
  const userFile = path.join(o.claudeDir, 'CLAUDE.md');
  if (o.exists(userFile)) out.push({ path: userFile, scope: 'user' });
  const underHome = !path.relative(o.homeDir, o.cwd).startsWith('..') && !path.isAbsolute(path.relative(o.homeDir, o.cwd));
  const dirs: string[] = [];
  for (let d = o.cwd; ; d = path.dirname(d)) {
    dirs.push(d);
    if (underHome && slashed(path.relative(o.homeDir, d)) === '') break;
    if (path.dirname(d) === d) break;
  }
  for (const dir of dirs.reverse()) {
    const agents = o.exists(path.join(dir, 'AGENTS.md'));
    for (const rel of ['CLAUDE.md', '.claude/CLAUDE.md']) {
      const file = path.join(dir, rel);
      // ホームの .claude/CLAUDE.md は、最初のアカウントでは利用者のファイルそのものである。
      if (slashed(file) === slashed(userFile) || !o.exists(file)) continue;
      out.push(agents ? { path: file, scope: 'project', skipped: 'agentsMd' } : { path: file, scope: 'project' });
    }
  }
  const local = path.join(o.cwd, 'CLAUDE.local.md');
  if (o.exists(local)) out.push({ path: local, scope: 'local' });
  return out;
}

// ---- MCP ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isStr) ? (v as string[]) : null);
const strMap = (v: unknown): Record<string, string> | null => (isObj(v) && Object.values(v).every(isStr) ? (v as Record<string, string>) : null);

const normKey = (p: string): string => {
  const r = path.resolve(slashed(p)).normalize('NFC');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** `${VAR}` と `${VAR:-既定}` を展開する。Claude Code と同じく、未定義のときだけ既定を使う（空文字は定義済み）。未定義で既定が無ければ null。 */
function expand(text: string, env: Record<string, string | undefined>): string | null {
  let missing = false;
  const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, dflt: string | undefined) => {
    const v = env[name];
    if (v !== undefined) return v;
    if (dflt !== undefined) return dflt;
    missing = true;
    return '';
  });
  return missing ? null : out;
}

/** 展開できたら値、未定義の変数があれば null。 */
function expandAll<T extends string | string[] | Record<string, string>>(v: T, env: Record<string, string | undefined>): T | null {
  if (isStr(v)) return expand(v, env) as T | null;
  if (Array.isArray(v)) {
    const r = v.map((x) => expand(x, env));
    return r.includes(null) ? null : (r as unknown as T);
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    const e = expand(x, env);
    if (e === null) return null;
    out[k] = e;
  }
  return out as T;
}

type Parsed = Pick<ShareMcp, 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers'>;

/** 1 件を読む。形が壊れていれば null。 */
function parseOne(raw: unknown): Parsed | null {
  if (!isObj(raw)) return null;
  const type = raw.type;
  if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'sse') return null;
  const transport = type ?? 'stdio';
  if (transport === 'stdio') {
    if (!isStr(raw.command) || raw.command === '') return null;
    const args = raw.args === undefined ? undefined : strList(raw.args);
    const env = raw.env === undefined ? undefined : strMap(raw.env);
    if (args === null || env === null) return null;
    return { transport, command: raw.command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
  }
  if (!isStr(raw.url) || raw.url === '') return null;
  const headers = raw.headers === undefined ? undefined : strMap(raw.headers);
  if (headers === null) return null;
  return { transport, url: raw.url, ...(headers ? { headers } : {}) };
}

function guessTransport(raw: unknown): ShareMcp['transport'] {
  if (isObj(raw) && (raw.type === 'sse' || raw.type === 'http')) return raw.type;
  return isObj(raw) && isStr(raw.url) ? 'http' : 'stdio';
}

export type ClaudeMcpOptions = {
  cwd: string;
  /** ~/.claude.json（アカウントの置き場のもの）を読んだ値。 */
  claudeJson: unknown;
  /** 作業フォルダの .mcp.json を読んだ値。無ければ null。 */
  mcpJson: unknown | null;
  /** `${VAR}` を展開する環境。hangar のものを渡す。 */
  env: Record<string, string | undefined>;
  /** 作業フォルダの実体のパス。.claude.json の projects の鍵が実体で書かれているときのため。 */
  cwdReal?: string;
  /** .mcp.json の承認の鍵（enableAllProjectMcpServers、enabledMcpjsonServers、disabledMcpjsonServers）を持つ settings の値。設定フォルダの settings.json と、作業フォルダの .claude/settings.json、settings.local.json。 */
  settings?: unknown[];
};

const NAMES = (v: unknown): string[] => strList(v) ?? [];

/**
 * 渡す MCP の登録を、中立の形で返す。範囲は S3：利用者（mcpServers）、そのフォルダ（projects[cwd].mcpServers）、承認済みの .mcp.json。
 * 同じ名前は local、project、user の順に強いものを 1 件だけ返す（Claude Code と同じ）。並びも local、project、user の順である。
 * 渡さないものも skipped に理由を付けて返す（設定の画面の「渡さないもの」）。claude.ai のコネクタとプラグインの MCP は読まない。
 */
export function claudeMcpServers(o: ClaudeMcpOptions): ShareMcp[] {
  const root = isObj(o.claudeJson) ? o.claudeJson : {};
  const projects = isObj(root.projects) ? root.projects : {};
  const wanted = new Set([normKey(o.cwd), ...(o.cwdReal ? [normKey(o.cwdReal)] : [])]);
  const entry = Object.entries(projects).find(([k]) => wanted.has(normKey(k)))?.[1];
  const proj = isObj(entry) ? entry : {};

  const disabled = new Set(NAMES(proj.disabledMcpServers));
  const enabledJson = new Set(NAMES(proj.enabledMcpjsonServers));
  const disabledJson = new Set(NAMES(proj.disabledMcpjsonServers));
  let enableAll = proj.enableAllProjectMcpServers === true;
  // 承認は、.claude.json の projects 側と settings の側を合わせて判定する。どれかで有効なら承認、無効の指定が勝つ。
  for (const st of o.settings ?? []) {
    if (!isObj(st)) continue;
    if (st.enableAllProjectMcpServers === true) enableAll = true;
    for (const n of NAMES(st.enabledMcpjsonServers)) enabledJson.add(n);
    for (const n of NAMES(st.disabledMcpjsonServers)) disabledJson.add(n);
  }

  const groups: { source: ShareMcp['source']; servers: Obj }[] = [
    { source: 'local', servers: isObj(proj.mcpServers) ? proj.mcpServers : {} },
    { source: 'project', servers: isObj(o.mcpJson) && isObj(o.mcpJson.mcpServers) ? o.mcpJson.mcpServers : {} },
    { source: 'user', servers: isObj(root.mcpServers) ? root.mcpServers : {} },
  ];

  const seen = new Set<string>();
  const out: ShareMcp[] = [];
  for (const { source, servers } of groups) {
    for (const [name, raw] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const parsed = parseOne(raw);
      const head = { name, source, transport: parsed?.transport ?? guessTransport(raw) };
      const skip = (skipped: ShareSkipReason): void => { out.push({ ...head, skipped }); };
      if (name === HANGAR_MCP_NAME) { skip('reserved'); continue; }
      if (!parsed) { skip('invalid'); continue; }
      if (disabled.has(name) || (source === 'project' && disabledJson.has(name))) { skip('disabled'); continue; }
      if (source === 'project' && !enableAll && !enabledJson.has(name)) { skip('unapproved'); continue; }
      const x: Parsed = { transport: parsed.transport };
      let ok = true;
      for (const k of ['command', 'url', 'args', 'env', 'headers'] as const) {
        const v = parsed[k];
        if (v === undefined) continue;
        const e = expandAll(v, o.env);
        if (e === null) { ok = false; break; }
        (x as Record<string, unknown>)[k] = e;
      }
      if (!ok) { skip('missingEnv'); continue; }
      out.push({ ...head, ...x });
    }
  }
  return out;
}

// ---- 読みの包み ----

export type ShareSourcesOptions = {
  cwd: string;
  claudeDir: string;
  homeDir: string;
  /** その置き場の .claude.json（claudeJsonFor で決める）。 */
  claudeJsonPath: string;
  env: Record<string, string | undefined>;
};
export type ShareSources = { instructions: (ShareFile & { text: string | null })[]; mcp: ShareMcp[] };

function readJsonFile(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(resolveRealFile(file), 'utf8')) as unknown; } catch { return null; }
}
function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** 指示の本文と MCP の登録を読む。ファイルが無い、壊れているときは空として扱い、投げない。 */
export function readShareSources(o: ShareSourcesOptions): ShareSources {
  const instructions = instructionSources({ cwd: o.cwd, claudeDir: o.claudeDir, homeDir: o.homeDir, exists: isFile }).map((f) => ({ ...f, text: f.skipped ? null : readText(f.path) }));
  let cwdReal: string | undefined;
  try { cwdReal = fs.realpathSync.native(o.cwd); } catch { cwdReal = undefined; }
  const settings = [path.join(o.claudeDir, 'settings.json'), path.join(o.cwd, '.claude', 'settings.json'), path.join(o.cwd, '.claude', 'settings.local.json')].map(readJsonFile);
  const mcp = claudeMcpServers({ cwd: o.cwd, ...(cwdReal ? { cwdReal } : {}), claudeJson: readJsonFile(o.claudeJsonPath), mcpJson: readJsonFile(path.join(o.cwd, '.mcp.json')), env: o.env, settings });
  return { instructions, mcp };
}
