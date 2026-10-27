import { createHash } from 'node:crypto';
import { ApplyError } from '../apply.ts';
import type { Collected, LocalItem } from '../collect.ts';
import { CLAUDE_PLUGIN_KEYS, canonicalJson, valueFits } from '../settingsSort.ts';
import { planItemOps, planItems, readSettingsForCollect, writeItems, type ItemSpec } from './settingsItemWriter.ts';
import { CLAUDE_STORE } from './stores.ts';
import type { ConfigTarget } from './types.ts';

/**
 * Claude の enabledPlugins と extraKnownMarketplaces（SPEC 2 章、6 章）。今は運ばない鍵を、承認つきで運ぶ。
 *
 * - id は `settings:enabledPlugins`、`settings:extraKnownMarketplaces`（kind plugins）。claude より前に登録し、claude.owns から外した。
 *   古い版はこの 2 つを machine として運ばないので、古い版の束に無いことが消去に見えないよう、別の対象にしてある。
 * - marketplace がローカルのパス（directory、file、パスを指す url など）なら、その marketplace と、それ由来の plugin（`名前@marketplace`）は送り手が運ばない。
 *   届いた中身にローカルの marketplace があれば、受け手は保留する（別の版から届いたときの備え）。
 * - 書き戻しは、届いた値に、手元のローカルの marketplace とその plugin を足して残す。
 * - 入切は設定の `configTargets`（既定は切）。承認は設定が each のあいだ、消去も含めて全部。
 */
export const CLAUDE_PLUGINS_NAME = 'claude-plugins';

export type PluginHold = 'local-marketplace';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PATHISH = /^(?:[/~.\\]|[A-Za-z]:[\\/]|file:)/i;

/** marketplace の宣言がこの PC のパスを指しているか。 */
export function isLocalMarketplace(entry: unknown): boolean {
  if (typeof entry === 'string') return PATHISH.test(entry);
  if (!isObject(entry)) return false;
  const src = isObject(entry.source) ? entry.source : entry;
  const kind = src.source;
  if (kind === 'directory' || kind === 'file' || kind === 'local') return true;
  if (typeof src.path === 'string') return true;
  for (const k of ['url', 'repo']) if (typeof src[k] === 'string' && PATHISH.test(src[k] as string)) return true;
  return false;
}

const marketOf = (pluginId: string): string | null => { const i = pluginId.lastIndexOf('@'); return i > 0 ? pluginId.slice(i + 1) : null; };
const localMarkets = (markets: unknown): Set<string> => new Set(isObject(markets) ? Object.entries(markets).filter(([, v]) => isLocalMarketplace(v)).map(([k]) => k) : []);

/** 送り手が運ぶ部分。ローカルの marketplace と、それ由来の plugin を除く。 */
function carriedPart(key: string, value: Record<string, unknown>, markets: unknown): Record<string, unknown> {
  const local = localMarkets(markets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '__proto__') continue;
    if (key === 'extraKnownMarketplaces' ? local.has(k) : local.has(marketOf(k) ?? '\0')) continue;
    out[k] = v;
  }
  return out;
}

/** 受け手の保留。ローカルの marketplace が含まれていれば書かない。 */
export function holdOfPlugins(id: string, content: Buffer): PluginHold | null {
  if (id !== 'settings:extraKnownMarketplaces') return null;
  try {
    const v: unknown = JSON.parse(content.toString('utf8'));
    return isObject(v) && localMarkets(v).size > 0 ? 'local-marketplace' : null;
  } catch { return null; }
}

function specOf(key: string): ItemSpec {
  const id = `settings:${key}`;
  return {
    key,
    decode(blob) {
      let value: unknown;
      try { value = JSON.parse(blob.toString('utf8')); } catch { throw new ApplyError('bad-content', `受信した設定の値を読み込めません（${id}）。`); }
      if (!isObject(value) || !valueFits(key, value)) throw new ApplyError('bad-content', `受信した設定の値が、キーの型に合いません（${id}）。`);
      if (holdOfPlugins(id, blob)) throw new ApplyError('unsafe', 'plugin の配布元がこの PC のディレクトリを指しているため、書き込みません。');
      return { value, files: [] };
    },
    merge(cur, remote) {
      // 手元だけのもの（ローカルの marketplace と、それ由来の plugin）は残す。
      const mine = isObject(cur[key]) ? (cur[key] as Record<string, unknown>) : {};
      const local = localMarkets(cur.extraKnownMarketplaces);
      const keep = Object.entries(mine).filter(([k]) => (key === 'extraKnownMarketplaces' ? local.has(k) : local.has(marketOf(k) ?? '\0')));
      const merged: Record<string, unknown> = { ...(isObject(remote) ? remote : {}) };
      for (const [k, v] of keep) if (k !== '__proto__' && !(k in merged)) merged[k] = v;
      return Object.keys(merged).length > 0 || isObject(remote) ? merged : undefined;
    },
    marks: () => [],
  };
}

function collect(ctx: { claudeDir: string }): Collected {
  const out: Collected = { items: [], dropped: [], unsent: [], blocked: { ids: new Set(), prefixes: [] } };
  const read = readSettingsForCollect(ctx.claudeDir);
  if (read === 'absent') return out;
  if (read === 'blocked') { for (const k of CLAUDE_PLUGIN_KEYS) out.blocked.ids.add(`settings:${k}`); return out; }
  for (const key of ['enabledPlugins', 'extraKnownMarketplaces']) {
    const raw = read.json[key];
    if (!isObject(raw) || Object.keys(raw).length === 0 || !valueFits(key, raw)) continue;
    const part = carriedPart(key, raw, read.json.extraKnownMarketplaces);
    if (Object.keys(part).length === 0) continue;
    const content = Buffer.from(canonicalJson(part));
    const item: LocalItem = { id: `settings:${key}`, kind: 'plugins', label: key, sha256: createHash('sha256').update(content).digest('hex'), size: content.length, marks: [], content, mtime: read.mtime, target: `settings.json#${key}`, withheld: null };
    out.items.push(item);
  }
  return out;
}

export function createClaudePluginsTarget(): ConfigTarget {
  const specs = (): Map<string, ItemSpec> => new Map([...CLAUDE_PLUGIN_KEYS].map((k) => [`settings:${k}`, specOf(k)]));
  return {
    name: CLAUDE_PLUGINS_NAME,
    owns: (id) => id.startsWith('settings:') && CLAUDE_PLUGIN_KEYS.has(id.slice('settings:'.length)),
    parseId: (id) => (id.startsWith('settings:') && CLAUDE_PLUGIN_KEYS.has(id.slice('settings:'.length)) ? { kind: 'plugins', ref: { type: 'settings', key: id.slice('settings:'.length) } } : null),
    enabled: (t) => t.switches?.[CLAUDE_PLUGINS_NAME] === true,
    collect,
    planWrite: (w) => planItems(w, specs()),
    write: (w) => writeItems(w, specs()),
    planOps: (w, read) => planItemOps(w, specs(), read),
    store: CLAUDE_STORE,
    needsApproval: (_item, approval) => approval === 'each',
    isMachineBound: () => false,
  };
}

export const claudePluginsTarget: ConfigTarget = createClaudePluginsTarget();
