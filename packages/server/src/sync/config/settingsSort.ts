import type { ConfigDropReason } from '@agent-hangar/shared';

/**
 * settings.json の鍵の仕分け（設定の同期の設計書の 2 章）。
 * 公式の鍵は約 260 ある。好みは運び、実行、パス、認証、機械の事情は運ばない。権限は運ぶが、絶対パスの規則だけを落とす。
 * 知らない鍵は運ばず、unknown として記録する。
 *
 * 項目の単位は鍵である（権限だけは `permissions.allow` のように 1 段下の鍵）。
 * 受け取る側も isCarriedSettingsKey で同じ物差しを使い、仕分けの外の鍵が届いても書かない。
 */

/** そのまま運ぶ鍵。好みの値で、パスも実行も含まない。 */
const CARRIED_KEYS = new Set(['model', 'effortLevel', 'language', 'outputStyle', 'theme', 'editorMode', 'cleanupPeriodDays', 'attribution', 'autoMemoryEnabled']);
const CARRIED_PREFIX = 'autoCompact';
/** 権限の下の、運ぶ鍵。 */
const PERMISSION_LISTS = ['allow', 'ask', 'deny'] as const;
const PERMISSION_CARRIED = new Set<string>([...PERMISSION_LISTS, 'defaultMode']);

/** 運ばない鍵の理由。実行は他の PC からの実行経路になり、パスと機械の事情は他の PC で意味を持たない。 */
const DROPPED: { match: (k: string) => boolean; reason: ConfigDropReason }[] = [
  { match: (k) => ['env', 'apiKeyHelper', 'hooks', 'statusLine', 'fileSuggestion'].includes(k), reason: 'execution' },
  { match: (k) => k.startsWith('aws') || k.startsWith('forceLogin'), reason: 'auth' },
  { match: (k) => ['autoMemoryDirectory', 'plansDirectory'].includes(k), reason: 'path' },
  { match: (k) => ['sandbox', 'enabledPlugins', 'extraKnownMarketplaces'].includes(k) || k.endsWith('McpjsonServers'), reason: 'machine' },
];

/** 受け取る側が使う、運んでよい鍵か。`permissions` そのものは、下の鍵に分けて運ぶので含めない。 */
export function isCarriedSettingsKey(key: string): boolean {
  if (CARRIED_KEYS.has(key)) return true;
  if (key.startsWith(CARRIED_PREFIX) && /^[A-Za-z0-9]+$/.test(key)) return true;
  if (key.startsWith('permissions.')) return PERMISSION_CARRIED.has(key.slice('permissions.'.length));
  return false;
}

/**
 * 絶対パスを指す権限の規則か。
 * 括弧の中が `//` で始まる（Claude Code の「ファイルシステムの絶対パス」の書き方）か、ドライブ文字か UNC で始まるもの。
 * `/src/**`（プロジェクトの根からの相対）、`~/x`、`./x` は絶対パスではない。
 * 括弧の中の途中に絶対パスが出てくる Bash の規則（`Bash(cat //etc/hosts)`）は、先頭ではないので落とさない。
 */
export function isAbsolutePathRule(rule: string): boolean {
  const m = /^[A-Za-z][A-Za-z0-9_.]*\((.*)\)$/s.exec(rule);
  if (!m) return false;
  const inner = m[1]!.trimStart();
  return inner.startsWith('//') || /^[A-Za-z]:[\\/]/.test(inner) || inner.startsWith('\\\\');
}

/** 鍵の並びに依らない JSON。同じ値が同じ文字列になるので、指紋に使える。 */
export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, val]) => [k, sort(val)]));
    return x;
  };
  return JSON.stringify(sort(v));
}

export type SortedSetting = { key: string; value: unknown };
export type DroppedKey = { key: string; reason: ConfigDropReason };
export type DroppedRule = { list: 'allow' | 'ask' | 'deny'; rule: string };
export type SettingsSort = { items: SortedSetting[]; dropped: DroppedKey[]; droppedRules: DroppedRule[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 値の型が、その鍵で想定しているものか。想定外は運ばない（相手の設定を壊さない）。 */
export function valueFits(key: string, v: unknown): boolean {
  if (key === 'attribution') return isObject(v);
  if (key === 'cleanupPeriodDays') return typeof v === 'number' && Number.isFinite(v);
  if (key === 'autoMemoryEnabled' || key.startsWith(CARRIED_PREFIX)) return typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string';
  return typeof v === 'string';
}

/**
 * settings.json を読んだ値（JSON.parse の結果）を、運ぶ鍵と運ばない鍵に分ける。
 * allowedRules は、利用者が「それでも送る」を押した絶対パスの規則。残す。
 */
export function sortSettings(json: unknown, o: { allowedRules?: ReadonlySet<string> } = {}): SettingsSort {
  const out: SettingsSort = { items: [], dropped: [], droppedRules: [] };
  if (!isObject(json)) return out;
  for (const [key, value] of Object.entries(json)) {
    if (key === 'permissions') { sortPermissions(value, out, o.allowedRules ?? new Set()); continue; }
    const drop = DROPPED.find((d) => d.match(key));
    if (drop) { out.dropped.push({ key, reason: drop.reason }); continue; }
    if (!isCarriedSettingsKey(key) || !valueFits(key, value)) { out.dropped.push({ key, reason: 'unknown' }); continue; }
    out.items.push({ key, value });
  }
  return out;
}

function sortPermissions(value: unknown, out: SettingsSort, allowedRules: ReadonlySet<string>): void {
  if (!isObject(value)) { out.dropped.push({ key: 'permissions', reason: 'unknown' }); return; }
  for (const [sub, v] of Object.entries(value)) {
    const key = `permissions.${sub}`;
    if (sub === 'additionalDirectories') { out.dropped.push({ key, reason: 'path' }); continue; }
    if (sub === 'defaultMode') {
      if (typeof v === 'string') out.items.push({ key, value: v });
      else out.dropped.push({ key, reason: 'unknown' });
      continue;
    }
    if ((PERMISSION_LISTS as readonly string[]).includes(sub)) {
      if (!Array.isArray(v) || v.some((r) => typeof r !== 'string')) { out.dropped.push({ key, reason: 'unknown' }); continue; }
      const kept: string[] = [];
      for (const rule of v as string[]) {
        if (isAbsolutePathRule(rule) && !allowedRules.has(rule)) out.droppedRules.push({ list: sub as DroppedRule['list'], rule });
        else kept.push(rule);
      }
      // 全部が絶対パスの規則だったときは運ばない。空の配列を運ぶと、相手の規則を消してしまう。
      if (kept.length > 0 || v.length === 0) out.items.push({ key, value: kept });
      continue;
    }
    out.dropped.push({ key, reason: 'unknown' });
  }
}
