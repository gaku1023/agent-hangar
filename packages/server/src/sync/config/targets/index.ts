import type { Collected, LocalItem } from '../collect.ts';
import { claudeTarget, CLAUDE_TARGET_NAME } from './claude.ts';
import type { ConfigTarget, ParsedId, TargetContext } from './types.ts';

/**
 * 対象の登録。後の対象は、ここの配列に足す（順は id の持ち主を決める順で、先に当たった対象が持ち主）。
 * 試験は registerTarget で仮の対象を足し、戻り値で外す。
 */
const registry: ConfigTarget[] = [claudeTarget];

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

/** この PC が集める対象の名前。 */
export const enabledTargetNames = (ctx: TargetContext): string[] => registry.filter((t) => t.enabled(ctx)).map((t) => t.name);

/** 集める対象の項目を全部集めて 1 つにする。 */
export function collectAll(ctx: TargetContext): Collected {
  const out: Collected = { items: [], dropped: [], unsent: [], blocked: { ids: new Set(), prefixes: [] } };
  const seen = new Set<string>();
  for (const t of registry) {
    if (!t.enabled(ctx)) continue;
    const c = t.collect(ctx);
    for (const i of c.items) if (!seen.has(i.id)) { seen.add(i.id); out.items.push(i); }
    out.dropped.push(...c.dropped);
    out.unsent.push(...c.unsent);
    for (const id of c.blocked.ids) out.blocked.ids.add(id);
    out.blocked.prefixes.push(...c.blocked.prefixes);
  }
  out.items.sort((a: LocalItem, b: LocalItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  out.unsent.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
