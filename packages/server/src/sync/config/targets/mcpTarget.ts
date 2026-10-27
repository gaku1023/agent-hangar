import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { ApplyOptions, PlanReader, WritePaths } from '../apply.ts';
import type { Collected, LocalItem, UnsentCandidate } from '../collect.ts';
import { canonicalJson } from '../settingsSort.ts';
import { commandOf, holdOfMcp, isHangarEntry, mcpIdOf, mcpSecret, mcpValueFits, parseMcpName, type McpHold, type McpHoldEnv } from './mcpCommon.ts';
import { planMcp, planMcpFiles, planMcpOps, writeMcp, type McpFlavor } from './mcpWrite.ts';
import type { ConfigTarget, TargetContext, TargetStore } from './types.ts';

/**
 * MCP の対象（claude-mcp、codex-mcp、opencode-mcp）に共通の、集め方と対象の組み立て。
 * 入れ物の読み方（read）と書き方（McpFlavor）だけを対象ごとに持つ。
 *
 * - 名前ごとに 1 項目。値は、そのエージェントの設定ファイルの中の形のまま運ぶ。
 * - Hangar 自身の登録、形の読めない値は運ばない。形の読めないものは、同名の項目が届いても上書きしないよう塞ぐ。
 * - 秘密らしい値があれば withheld にして「送らなかった項目」に出す。「それでも送る」を選んだ項目（同じ指紋のとき）は送る。
 * - 入切は設定の `configTargets` で、既定は切。承諾は設定が each のあいだ、消去も含めて全部（起動するコマンドを足すため）。
 */

export type McpRead = { servers: Record<string, unknown>; mtime: number } | 'absent' | 'blocked';

export type McpTargetSpec = {
  flavor: McpFlavor;
  /** 書き戻しの入れ物と控えの置き場（stores.ts）。 */
  store: TargetStore;
  /** 入れ物から、MCP の表（名前→値）を読む。 */
  read(ctx: TargetContext): McpRead;
  /** この PC で、この対象を扱えるか（Codex・opencode が有効か）。入切の前に見る。 */
  available(ctx: TargetContext): boolean;
  /** 書く先のファイル（入れ物と、そこからの相対パス）。 */
  locate(o: McpPaths): { root: string; rel: string };
};

/** 書き戻しに渡す入れ物のパスと、保留の判定の差し替え口（WritePaths のうち MCP が使う分）。無ければこの PC の既定。 */
export type McpPaths = Pick<WritePaths, 'claudeJsonPath' | 'codexHome' | 'opencodeDir' | 'exists' | 'userHome'>;
export type McpApplyOptions = ApplyOptions;

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 大きすぎる入れ物は読まない（~/.claude.json は大きいので、普通の項目の上限より広くとる）。 */
export const MAX_CONFIG_BYTES = 64 * 1024 * 1024;
/** 項目 1 つの上限。 */
const MAX_ITEM_BYTES = 256 * 1024;

/** 入れ物のファイルを読む。無い→'absent'、リンク・通常でない・大きすぎる・読めない→'blocked'。 */
export function readConfigFile(file: string): { text: string; mtime: number } | 'absent' | 'blocked' {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'blocked'; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_CONFIG_BYTES) return 'blocked';
  try { return { text: fs.readFileSync(file, 'utf8'), mtime: Math.floor(st.mtimeMs) }; } catch { return 'blocked'; }
}

export function collectMcp(spec: McpTargetSpec, ctx: TargetContext): Collected {
  const f = spec.flavor;
  const out: Collected = { items: [], dropped: [], unsent: [], blocked: { ids: new Set(), prefixes: [] } };
  const r = spec.read(ctx);
  if (r === 'absent') return out;
  if (r === 'blocked') { out.blocked.prefixes.push(f.idPrefix); return out; }
  const maxItems = ctx.maxItems ?? 5000;
  const names = Object.keys(r.servers).sort();
  for (const name of names) {
    const value = r.servers[name];
    const id = mcpIdOf(f.idPrefix, name);
    if (isHangarEntry(f.kind, name, isObject(value) ? value : {})) continue; // Hangar 自身は運ばない（塞ぎもしない）
    // 運べない名前（形の悪い名前、読めない値）は、同名の項目が届いても手元を上書きしないよう塞ぐ。
    if (parseMcpName(f.idPrefix, id) === null || !mcpValueFits(f.kind, value)) { out.blocked.ids.add(id); continue; }
    const content = Buffer.from(canonicalJson(value));
    if (content.length > MAX_ITEM_BYTES || out.items.length >= maxItems) { out.blocked.ids.add(id); continue; }
    const hash = sha256(content);
    let withheld: LocalItem['withheld'] = null;
    const found = mcpSecret(f.kind, value);
    if (found) {
      const uid = `secret:${id}`;
      const allowed = ctx.allowedUnsent.get(uid) === hash;
      out.unsent.push({ id: uid, kind: 'secret', itemId: id, label: name, reason: `secret:${found}`, contentSha256: hash, allowed } satisfies UnsentCandidate);
      if (!allowed) withheld = 'secret';
    }
    // 起動するコマンドを足す項目なので、承諾の窓で実行の印を付けて見せる。
    out.items.push({ id, kind: f.itemKind, label: name, sha256: hash, size: content.length, marks: commandOf(f.kind, value) !== null ? ['shell'] : [], content, mtime: r.mtime, target: f.targetOf(name), withheld });
  }
  return out;
}

/** 受け手の保留。内容を見て、書いてはいけない理由を返す。service の held に載せるのは S11。 */
export function holdOfMcpItem(spec: McpTargetSpec, content: Buffer, env: McpHoldEnv = {}): McpHold | null {
  let v: unknown;
  try { v = JSON.parse(content.toString('utf8')); } catch { return null; }
  return mcpValueFits(spec.flavor.kind, v) ? holdOfMcp(spec.flavor.kind, v, env) : null;
}

export function writeMcpWith(spec: McpTargetSpec, o: McpApplyOptions): ReturnType<typeof writeMcp> {
  return writeMcp(spec.flavor, o, { ...spec.locate(o), exists: o.exists, home: o.userHome });
}

export function planMcpWith(spec: McpTargetSpec, o: { home: string } & McpPaths): ReturnType<typeof planMcp> {
  return planMcp(spec.flavor, o, { exists: o.exists, home: o.userHome });
}

export function planMcpFilesWith(spec: McpTargetSpec, o: { home: string } & McpPaths): ReturnType<typeof planMcpFiles> {
  return planMcpFiles(spec.flavor, o, { ...spec.locate(o), exists: o.exists, home: o.userHome });
}

export function planMcpOpsWith(spec: McpTargetSpec, o: { home: string } & McpPaths, read: PlanReader): ReturnType<typeof planMcpOps> {
  return planMcpOps(spec.flavor, o, { ...spec.locate(o), exists: o.exists, home: o.userHome }, read);
}

export function createMcpTarget(spec: McpTargetSpec): ConfigTarget {
  const f = spec.flavor;
  return {
    name: f.name,
    owns: (id) => id.startsWith(f.idPrefix),
    parseId: (id) => {
      const name = parseMcpName(f.idPrefix, id);
      return name === null ? null : { kind: f.itemKind, ref: { type: f.name as 'claude-mcp' | 'codex-mcp' | 'opencode-mcp', name } };
    },
    // その PC で扱える（Codex・opencode が有効）ときだけ、対象ごとの入切を見る。既定は切。
    enabled: (ctx) => spec.available(ctx) && ctx.switches?.[f.name] === true,
    collect: (ctx) => collectMcp(spec, ctx),
    planWrite: (o) => planMcpWith(spec, o),
    write: (o) => writeMcpWith(spec, o),
    planOps: (o, read) => planMcpOpsWith(spec, o, read),
    store: spec.store,
    needsApproval: (_item, approval) => approval === 'each',
    isMachineBound: () => false,
  };
}
