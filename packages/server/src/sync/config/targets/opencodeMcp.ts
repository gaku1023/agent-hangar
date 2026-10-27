import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getJsonc, removeJson, removeJsonc, setJson, setJsonc } from '../edit/index.ts';
import { OPENCODE_MCP_PREFIX, opencodeMcpEnvRefs } from './mcpCommon.ts';
import { createMcpTarget, planMcpFilesWith, planMcpWith, readConfigFile, writeMcpWith, type McpApplyOptions, type McpTargetSpec } from './mcpTarget.ts';
import type { McpEdit, McpFlavor } from './mcpWrite.ts';
import { defaultTargetPaths } from './paths.ts';
import { OPENCODE_MCP_STORE } from './stores.ts';

/**
 * opencode の MCP サーバー（opencode.json(c) の `mcp.<名前>`）。id は `opencode:mcp:<名前>`。
 *
 * opencode の対象（S5）と同じく、jsonc があれば jsonc を正とし（jsonc は体裁を保って差し替え）、無ければ opencode.json に書く（opencode が書くのと同じ 2 空白で整形し直す）。
 * opencode の対象は mcp を読み飛ばし、この対象が別に集める。古い版は `opencode:` を知らない（運ばない）。
 * `{env:X}` はそのまま運ぶ。受け手の環境に X が無ければ opencodeMcpNotes で知らせる。
 */
export const OPENCODE_MCP_NAME = 'opencode-mcp';

const CONFIG_JSON = 'opencode.json';
const CONFIG_JSONC = 'opencode.jsonc';

/** 両方あるときの正は jsonc。 */
function configFileName(dir: string): string | null {
  for (const n of [CONFIG_JSONC, CONFIG_JSON]) { try { fs.lstatSync(path.join(dir, n)); return n; } catch { /* 無い */ } }
  return null;
}

const flavor: McpFlavor = {
  name: OPENCODE_MCP_NAME,
  kind: 'opencode',
  idPrefix: OPENCODE_MCP_PREFIX,
  itemKind: 'opencode-mcp',
  backupDir: 'opencode-mcp-config',
  targetOf: (name) => `${CONFIG_JSON}#mcp.${name}`,
  edit: (text, rel, edits: McpEdit[]) => {
    const jsonc = rel === CONFIG_JSONC;
    const set = jsonc ? setJsonc : setJson;
    const del = jsonc ? removeJsonc : removeJson;
    let cur = text ?? '';
    for (const e of edits) cur = e.remove ? del(cur, ['mcp', e.name]) : set(cur, ['mcp', e.name], e.value);
    return cur;
  },
  root: (text) => getJsonc(text, []),
  tablePath: ['mcp'],
};

const dirOf = (o: { opencodeDir?: string }): string => o.opencodeDir ?? defaultTargetPaths(process.env, os.homedir()).opencodeDir;

export const opencodeMcpSpec: McpTargetSpec = {
  flavor,
  store: OPENCODE_MCP_STORE,
  available: (ctx) => ctx.opencodeEnabled,
  read: (ctx) => {
    const name = configFileName(ctx.opencodeDir);
    if (name === null) return 'absent';
    const f = readConfigFile(path.join(ctx.opencodeDir, name));
    if (f === 'absent' || f === 'blocked') return f;
    let servers: unknown;
    try { servers = getJsonc(f.text, ['mcp']); } catch { return 'blocked'; }
    if (servers === undefined) return { servers: {}, mtime: f.mtime };
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'blocked';
    return { servers: servers as Record<string, unknown>, mtime: f.mtime };
  },
  locate: (o) => { const dir = dirOf(o); return { root: dir, rel: configFileName(dir) ?? CONFIG_JSON }; },
};

/** 項目に添える知らせ。受け手の環境に無い `{env:X}` の X。opencode は無い変数を空文字にして黙って壊れる。 */
export function opencodeMcpNotes(item: { id: string; content: Buffer }, env: NodeJS.ProcessEnv = process.env): { missingEnv: string[] } {
  if (!item.id.startsWith(OPENCODE_MCP_PREFIX)) return { missingEnv: [] };
  let v: unknown;
  try { v = JSON.parse(item.content.toString('utf8')); } catch { return { missingEnv: [] }; }
  return { missingEnv: opencodeMcpEnvRefs(v).filter((x) => env[x] === undefined) };
}

export const writeOpencodeMcp = (o: McpApplyOptions) => writeMcpWith(opencodeMcpSpec, o);
export const planOpencodeMcp = (o: { home: string } & Pick<McpApplyOptions, 'opencodeDir' | 'exists' | 'userHome'>) => planMcpWith(opencodeMcpSpec, o);
export const planOpencodeMcpFiles = (o: { home: string } & Pick<McpApplyOptions, 'opencodeDir' | 'exists' | 'userHome'>) => planMcpFilesWith(opencodeMcpSpec, o);
export const opencodeMcpTarget = createMcpTarget(opencodeMcpSpec);
