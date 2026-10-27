import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSecret } from '../secrets.ts';

/**
 * MCP サーバーの設定（claude-mcp、codex-mcp、opencode-mcp）に共通の決まり。SPEC 2・3・4 章、決定 D5。
 *
 * - 項目は名前ごとに 1 つ。値は、そのエージェントが自分の設定ファイルに書く形のまま運ぶ（エージェント間の訳は 0.13）。
 * - 名前が `hangar`、または command が Hangar 自身を指すものは運ばない（Hangar が自分で登録するもので、受け手には受け手の登録がある）。
 * - 受け手に無い絶対パスの command は保留する。
 * - env・headers・bearer_token・URL の問い合わせに秘密らしい値があれば、送らない（「それでも送る」で送れる）。
 */

export type McpFlavorKind = 'claude' | 'codex' | 'opencode';

export const CLAUDE_MCP_PREFIX = 'claude-mcp:';
export const CODEX_MCP_PREFIX = 'codex:mcp:';
export const OPENCODE_MCP_PREFIX = 'opencode:mcp:';

const MAX_NAME = 200;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isStrMap = (v: unknown): boolean => isObject(v) && Object.values(v).every(isStr);

/** Hangar 自身の登録の名前。大文字小文字は区別しない。 */
export const isHangarName = (name: string): boolean => name.toLowerCase() === 'hangar';

export const mcpIdOf = (prefix: string, name: string): string => `${prefix}${encodeURIComponent(name)}`;

/** id から名前を取り出す。形が悪い、往復しない、運ばない名前なら null。 */
export function parseMcpName(prefix: string, id: string): string | null {
  if (!id.startsWith(prefix)) return null;
  let name: string;
  try { name = decodeURIComponent(id.slice(prefix.length)); } catch { return null; }
  if (name === '' || name.length > MAX_NAME || name === '__proto__' || isHangarName(name)) return null;
  return mcpIdOf(prefix, name) === id ? name : null;
}

// ---- 形 ----

/** 起動する command（先頭の語）。stdio でなければ null。 */
export function commandOf(kind: McpFlavorKind, v: Record<string, unknown>): string | null {
  if (kind === 'opencode') return Array.isArray(v.command) && isStr(v.command[0]) ? v.command[0] : null;
  return isStr(v.command) ? v.command : null;
}

/** command に続く引数。 */
function argsOf(kind: McpFlavorKind, v: Record<string, unknown>): string[] {
  if (kind === 'opencode') return Array.isArray(v.command) ? v.command.slice(1).filter(isStr) : [];
  return isStrArray(v.args) ? v.args : [];
}

/** 値の形が、そのエージェントの MCP の設定として読めるか。鍵は知らないものも通す（新しい版の鍵を落とさない）。 */
export function mcpValueFits(kind: McpFlavorKind, v: unknown): v is Record<string, unknown> {
  if (!isObject(v)) return false;
  if (kind === 'claude') {
    const t = v.type;
    if (t !== undefined && t !== 'stdio' && t !== 'http' && t !== 'sse' && t !== 'ws') return false;
    if (t === undefined || t === 'stdio') { if (!isStr(v.command) || v.command === '') return false; } else if (!isStr(v.url) || v.url === '') return false;
    return (v.args === undefined || isStrArray(v.args)) && (v.env === undefined || isStrMap(v.env)) && (v.headers === undefined || isStrMap(v.headers));
  }
  if (kind === 'codex') {
    const hasCmd = v.command !== undefined;
    const hasUrl = v.url !== undefined;
    if (hasCmd === hasUrl) return false;
    if (hasCmd && (!isStr(v.command) || v.command === '')) return false;
    if (hasUrl && (!isStr(v.url) || v.url === '')) return false;
    return (v.args === undefined || isStrArray(v.args)) && (v.env === undefined || isStrMap(v.env)) && (v.http_headers === undefined || isStrMap(v.http_headers))
      && (v.env_http_headers === undefined || isStrMap(v.env_http_headers)) && (v.cwd === undefined || isStr(v.cwd)) && (v.bearer_token === undefined || isStr(v.bearer_token));
  }
  if (v.type === 'local') return isStrArray(v.command) && v.command.length > 0 && v.command[0] !== '' && (v.environment === undefined || isStrMap(v.environment));
  if (v.type === 'remote') return isStr(v.url) && v.url !== '' && (v.headers === undefined || isStrMap(v.headers));
  return false;
}

// ---- Hangar 自身 ----

const WRAPPER_EXT = /\.(exe|cmd|bat|ps1)$/i;
const baseName = (p: string): string => p.split(/[\\/]/).pop()!.replace(WRAPPER_EXT, '').toLowerCase();

/** Hangar 自身の登録か。名前が hangar、または command が hangar を指す。 */
export function isHangarEntry(kind: McpFlavorKind, name: string, v: Record<string, unknown>): boolean {
  if (isHangarName(name)) return true;
  const cmd = commandOf(kind, v);
  if (cmd === null) return false;
  if (baseName(cmd) === 'hangar') return true;
  return [cmd, ...argsOf(kind, v)].some((s) => /agent-hangar|Hangar\.app/i.test(s));
}

// ---- 受け手の保留 ----

export type McpHold = { reason: 'command-missing'; path: string };

const isAbsolutePathLike = (s: string): boolean => s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('~/') || s.startsWith('~\\');

export type McpHoldEnv = { exists?: (p: string) => boolean; home?: string };

/** 受け手の保留。絶対パスの command（codex は cwd も）が、この PC に無ければ保留する。相対の command（npx など）は PATH で探すので保留しない。 */
export function holdOfMcp(kind: McpFlavorKind, v: Record<string, unknown>, env: McpHoldEnv = {}): McpHold | null {
  const exists = env.exists ?? ((p: string) => { try { return fs.existsSync(p); } catch { return false; } });
  const home = env.home ?? os.homedir();
  const resolve = (p: string): string => (p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p);
  const paths = [commandOf(kind, v), kind === 'codex' && isStr(v.cwd) ? v.cwd : null];
  for (const p of paths) if (p !== null && isAbsolutePathLike(p) && !exists(resolve(p))) return { reason: 'command-missing', path: p };
  return null;
}

// ---- 秘密 ----

const SECRET_NAME = /token|secret|passw|api[-_]?key|apikey|authorization|credential|bearer|private[-_]?key|access[-_]?key|cookie/i;
const REFERENCE = /\$\{[^}]+\}|\{env:[^}]+\}|\{file:[^}]+\}|^\$[A-Za-z_]/;
/** 値が環境変数などへの参照（そのまま送ってよい）か。空もそう扱う。 */
const isReference = (s: string): boolean => s.trim() === '' || REFERENCE.test(s);
const literalSecret = (name: string, value: unknown): boolean => isStr(value) && SECRET_NAME.test(name) && !isReference(value);

/** 値の中の秘密らしい文字列。見つけた形の名前を返し、値そのものは返さない。 */
export function mcpSecret(kind: McpFlavorKind, v: Record<string, unknown>): string | null {
  const known = findSecret(JSON.stringify(v));
  if (known) return known;
  const tables = kind === 'opencode' ? ['environment', 'headers'] : kind === 'codex' ? ['env', 'http_headers'] : ['env', 'headers'];
  for (const t of tables) {
    const tab = v[t];
    if (isObject(tab)) for (const [k, val] of Object.entries(tab)) if (literalSecret(k, val)) return 'mcp-credential';
  }
  if (isStr(v.bearer_token) && !isReference(v.bearer_token)) return 'mcp-credential';
  for (const a of argsOf(kind, v)) {
    const m = /^--?([\w-]+)=(.*)$/.exec(a);
    if (m && literalSecret(m[1]!, m[2]!)) return 'mcp-credential';
  }
  if (isStr(v.url)) {
    try {
      for (const [k, val] of new URL(v.url).searchParams) if (literalSecret(k, val)) return 'mcp-credential';
    } catch { /* URL として読めなければ、問い合わせは見ない */ }
  }
  return null;
}

/** {env:X} の X（opencode）。受け手の環境に無ければ、項目に添えて知らせる。 */
export function opencodeMcpEnvRefs(v: unknown): string[] {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (isStr(x)) { for (const m of x.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(m[1]!); } else if (Array.isArray(x)) x.forEach(walk);
    else if (isObject(x)) Object.values(x).forEach(walk);
  };
  walk(v);
  return [...out].sort();
}
