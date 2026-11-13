import type { ConfigItemKind } from './api.ts';

/**
 * 設定の同期の、種類ごとの状態（2026-11-13 の決定 2〜4）。
 * off は送らず受けない、confirm は画面の確認から適用する、auto は届いたらサーバが適用する。
 * 会話の本文（transcript）は off と auto だけを取る。
 * 選んだ内容は hangar の好み（hangar:configKinds）に乗り、全部の PC で共通になる。
 */
export type ConfigKindMode = 'off' | 'confirm' | 'auto';
export type ConfigKindKey = ConfigItemKind | 'transcript';
export type ConfigKinds = Partial<Record<ConfigKindKey, ConfigKindMode>>;

/** 設定の項目の種類。api.ts の ConfigItemKind と同じ並びを保つ（configKinds.test.ts が数を見る）。 */
export const CONFIG_ITEM_KINDS: readonly ConfigItemKind[] = [
  'claude-md', 'settings', 'keybindings', 'skills', 'commands', 'agents', 'memory',
  'claude-mcp', 'claude-hooks', 'claude-statusline', 'plugins', 'codex-file', 'codex-config', 'codex-mcp',
  'opencode-file', 'opencode-config', 'opencode-cli', 'opencode-mcp', 'agents-skills', 'hangar-pref',
];
export const CONFIG_KIND_KEYS: readonly ConfigKindKey[] = [...CONFIG_ITEM_KINDS, 'transcript'];

/** 自動で走るコード。既定は確認で、ほかは自動。 */
const CONFIRM_BY_DEFAULT: ReadonlySet<ConfigKindKey> = new Set(['claude-hooks', 'claude-statusline', 'plugins', 'claude-mcp', 'codex-mcp', 'opencode-mcp']);

export const defaultConfigKindMode = (kind: ConfigKindKey): ConfigKindMode => (CONFIRM_BY_DEFAULT.has(kind) ? 'confirm' : 'auto');

const KEY_SET: ReadonlySet<string> = new Set(CONFIG_KIND_KEYS);
export const isConfigKindKey = (v: unknown): v is ConfigKindKey => typeof v === 'string' && KEY_SET.has(v);

/** その種類が取れる値か。会話の本文は確認を取らない。 */
export const isConfigKindModeFor = (kind: ConfigKindKey, v: unknown): v is ConfigKindMode =>
  v === 'off' || v === 'auto' || (v === 'confirm' && kind !== 'transcript');

/** 書き込みで受ける形か。知っている鍵と、その鍵が取れる値だけ。空の対象は通す。 */
export function isConfigKindsPatch(v: unknown): v is ConfigKinds {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.entries(v).every(([k, x]) => isConfigKindKey(k) && isConfigKindModeFor(k, x));
}

/** 種類の状態。書かれていない、または形の悪い値は既定に寄せる。server の Settings と ui の SettingsDto の両方が使う。 */
export function configKindModeOf(s: { configKinds?: ConfigKinds | null } | null | undefined, kind: ConfigKindKey): ConfigKindMode {
  const v = s?.configKinds?.[kind];
  return isConfigKindModeFor(kind, v) ? v : defaultConfigKindMode(kind);
}

/** 21 鍵を全部埋めた状態。SettingsDto に載せる形。 */
export function configKindsOf(s: { configKinds?: ConfigKinds | null } | null | undefined): Record<ConfigKindKey, ConfigKindMode> {
  return Object.fromEntries(CONFIG_KIND_KEYS.map((k) => [k, configKindModeOf(s, k)])) as Record<ConfigKindKey, ConfigKindMode>;
}
