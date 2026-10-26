/**
 * rollout（codex の会話の記録、jsonl）の形の控え。行の種類ごとに、キーの道とその型だけを畳む。値は見ない。
 * hangar の読み手（provider/codex/transcript/）が頼る形が変わったかを、ログイン無しで採った記録で見張る（docs/design.md「Codex の互換の見張り」）。
 */

/** hangar が読み捨てる行。形が変わっても読み手に響かないので、見ない（transcript/normalize.ts の DROPPED_LINE_TYPES と同じ）。 */
const IGNORED_LINE_TYPES: ReadonlySet<string> = new Set(['world_state']);

/** 行の種類の名前。`type`、payload に type があれば `type/payload.type`。 */
export function lineKeyOf(rec: unknown): string | null {
  if (typeof rec !== 'object' || rec === null) return null;
  const r = rec as { type?: unknown; payload?: { type?: unknown } };
  if (typeof r.type !== 'string') return null;
  const pt = r.payload && typeof r.payload === 'object' ? r.payload.type : undefined;
  return typeof pt === 'string' ? `${r.type}/${pt}` : r.type;
}

function typeOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

function flatten(v: unknown, path: string, into: Map<string, Set<string>>): void {
  if (Array.isArray(v)) { for (const x of v) flatten(x, `${path}[]`, into); return; }
  if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) flatten(x, path === '' ? k : `${path}.${k}`, into);
    return;
  }
  const set = into.get(path) ?? new Set<string>();
  set.add(typeOf(v));
  into.set(path, set);
}

/** 行の並びを、種類ごとの形（道 → 型の和）に畳む。 */
export function shapeOfRollout(lines: readonly unknown[]): Record<string, Record<string, string>> {
  const byKey = new Map<string, Map<string, Set<string>>>();
  for (const rec of lines) {
    const key = lineKeyOf(rec);
    if (key === null || IGNORED_LINE_TYPES.has((rec as { type: string }).type)) continue;
    const paths = byKey.get(key) ?? new Map<string, Set<string>>();
    flatten(rec, '', paths);
    byKey.set(key, paths);
  }
  const out: Record<string, Record<string, string>> = {};
  for (const key of [...byKey.keys()].sort()) {
    const paths = byKey.get(key)!;
    out[key] = Object.fromEntries([...paths.keys()].sort().map((p) => [p, [...paths.get(p)!].sort().join('|')]));
  }
  return out;
}
