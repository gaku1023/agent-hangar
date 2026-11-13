import type { Collected, LocalItem } from '../collect.ts';
import { endRound, startRound } from '../fileMemo.ts';
import { claudeTarget, CLAUDE_TARGET_NAME } from './claude.ts';
import { agentsSkillsTarget } from './agentsSkills.ts';
import { claudeHooksTarget } from './claudeHooks.ts';
import { claudeKeys2Target } from './claudeKeys2.ts';
import { claudePluginsTarget } from './claudePlugins.ts';
import { claudeMcpTarget } from './claudeMcp.ts';
import { codexMcpTarget } from './codexMcp.ts';
import { codexTarget } from './codex.ts';
import { hangarTarget } from './hangar.ts';
import { opencodeMcpTarget } from './opencodeMcp.ts';
import { opencodeTarget } from './opencode.ts';
import { CONFIG_ITEM_KINDS, type ConfigInboxOp, type ConfigItemKind, type ConfigKindMode } from '@agent-hangar/shared';
import { kindModeIn, type ConfigTarget, type ParsedId, type TargetContext } from './types.ts';

/**
 * 対象の登録。後の対象は、ここの配列に足す（順は id の持ち主を決める順で、先に当たった対象が持ち主）。
 * 試験は registerTarget で仮の対象を足し、戻り値で外す。
 */
// claudeKeys2、claudeHooks、claudePlugins は claude の settings: の一部を分けた対象なので、claude より前に置く。
const registry: ConfigTarget[] = [claudeKeys2Target, claudeHooksTarget, claudePluginsTarget, claudeTarget, codexTarget, opencodeTarget, agentsSkillsTarget, hangarTarget, claudeMcpTarget, codexMcpTarget, opencodeMcpTarget];

export { CLAUDE_TARGET_NAME };
export type { ConfigTarget, ParsedId, TargetContext };

export const allTargets = (): readonly ConfigTarget[] => registry;

/** 試験用。仮の対象を足す。戻り値は外す関数。 */
export function registerTarget(t: ConfigTarget): () => void {
  registry.push(t);
  return () => { const i = registry.indexOf(t); if (i >= 0) registry.splice(i, 1); };
}

/** id の持ち主。どの対象も持たない id は null。 */
export const targetOfId = (id: string): ConfigTarget | null => registry.find((t) => t.owns(id)) ?? null;

/** 3 方向の判定で使う、id の持ち主の名前。持ち主の無い id は、対象が Claude だけだった頃と同じに claude として扱う。 */
export const targetNameOfId = (id: string): string => targetOfId(id)?.name ?? CLAUDE_TARGET_NAME;

/** id を解く。持ち主の対象に任せる。知らない頭は null。 */
export function parseTargetItemId(id: string): ParsedId | null {
  return targetOfId(id)?.parseId(id) ?? null;
}

/** この PC が集める対象の名前。枠だけの対象（placeholder）は、何も運べないので載せない。束の `targets` と 3 方向の判定の「こちらが扱える対象」に使う。 */
export const enabledTargetNames = (ctx: TargetContext): string[] => registry.filter((t) => !t.placeholder && t.enabled(ctx)).map((t) => t.name);

/**
 * 届いた項目に承認（確認）が要るか。種類が確認なら要る。種類が自動でも、権限の鍵（対象の alwaysConfirm）は要る。
 * 種類が切の項目は判定に載らないので、ここには来ない。自動の適用（T2）もこの判定で外す。
 */
export const itemNeedsConfirm = (item: { id: string; kind: ConfigItemKind; op: ConfigInboxOp }, mode: ConfigKindMode): boolean =>
  mode === 'confirm' || (mode === 'auto' && (targetOfId(item.id)?.alwaysConfirm?.(item) ?? false));

/** この PC で切の種類（configKinds が off）。束の目録の offKinds に載せ、3 方向の判定で読み飛ばす。 */
export const offKindsOf = (ctx: Pick<TargetContext, 'kinds'>): ConfigItemKind[] => CONFIG_ITEM_KINDS.filter((k) => kindModeIn(ctx, k) === 'off');

/**
 * 集める対象の項目を全部集めて 1 つにする。
 * 切の種類の項目は束に入れない。対象は有効でも、その種類だけ切のことがある（claude-hooks の statusline だけ切など）。
 * 送らなかった項目の候補も、指す項目の種類が切なら外す。
 */
export function collectAll(ctx: TargetContext): Collected {
  const out: Collected = { items: [], dropped: [], unsent: [], blocked: { ids: new Set(), prefixes: [] }, linkSkipped: {} };
  const seen = new Set<string>();
  // ファイルの読みの記憶（fileMemo.ts）は、この 1 周で見なかったパスを最後に落とす。途中で投げたときは落とさない。
  startRound();
  for (const t of registry) {
    if (!t.enabled(ctx)) continue;
    const c = t.collect(ctx);
    for (const i of c.items) if (!seen.has(i.id) && kindModeIn(ctx, i.kind) !== 'off') { seen.add(i.id); out.items.push(i); }
    out.dropped.push(...c.dropped);
    for (const u of c.unsent) { const k = parseTargetItemId(u.itemId)?.kind; if (!k || kindModeIn(ctx, k) !== 'off') out.unsent.push(u); }
    for (const id of c.blocked.ids) out.blocked.ids.add(id);
    out.blocked.prefixes.push(...c.blocked.prefixes);
    for (const [k, v] of Object.entries(c.linkSkipped ?? {})) { const kind = k as ConfigItemKind; if (kindModeIn(ctx, kind) === 'off') continue; out.linkSkipped![kind] = [...(out.linkSkipped![kind] ?? []), ...(v ?? [])]; }
  }
  endRound();
  out.items.sort((a: LocalItem, b: LocalItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  out.unsent.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
