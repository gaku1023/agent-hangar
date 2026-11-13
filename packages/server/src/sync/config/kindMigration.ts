import { CONFIG_KIND_KEYS, defaultConfigKindMode, type ConfigApproval, type ConfigItemKind, type ConfigKindKey, type ConfigKindMode } from '@agent-hangar/shared';

/**
 * 旧い設定（configApproval と configTargets）から、種類ごとの状態（configKinds）を作る（2026-11-13 の決定 11）。
 * config/paths.ts の loadSettings が、configKinds が無く configBundleSync が入りの設定を読んだときに 1 回だけ使う。
 * loadSettings は対象の登録（targets/index.ts）を読めない（hangar の対象が loadSettings を読むので循環する）。
 * そのため種類と対象の対応はここに表で持ち、kindMigration.test.ts が登録の kinds と食い違わないことを見る。
 */

/** 種類ごとの、その種類を運ぶ対象。claude は入切を持たない（いつも入り）。 */
export const KIND_TARGETS: Readonly<Record<ConfigItemKind, readonly string[]>> = {
  'claude-md': ['claude'], keybindings: ['claude'], skills: ['claude'], commands: ['claude'], agents: ['claude'], memory: ['claude'],
  settings: ['claude', 'claude-keys2'],
  'claude-hooks': ['claude-hooks'], 'claude-statusline': ['claude-hooks'], plugins: ['claude-plugins'],
  'claude-mcp': ['claude-mcp'], 'codex-mcp': ['codex-mcp'], 'opencode-mcp': ['opencode-mcp'],
  'codex-file': ['codex'], 'codex-config': ['codex'],
  'opencode-file': ['opencode'], 'opencode-config': ['opencode'], 'opencode-cli': ['opencode'],
  'agents-skills': ['agents-skills'], 'hangar-pref': ['hangar'],
};

/**
 * configApproval が each のとき、承認が要った種類。各対象の旧い needsApproval を読んで決めた。
 * 項目の一部だけ承認が要った種類（settings の権限の鍵、codex-config の権限の鍵、opencode-config の permission、
 * codex-file の rules・skills・hooks.json、opencode-file の themes 以外）も、厳しい側に倒して確認にする。
 * hangar-pref は configApproval の鍵だけが承認だったが、その鍵は運ばなくなったので既定（自動）のまま。
 */
const NEEDED_APPROVAL: ReadonlySet<ConfigItemKind> = new Set<ConfigItemKind>([
  'skills', 'commands', 'agents', 'settings',
  'claude-hooks', 'claude-statusline', 'plugins', 'claude-mcp', 'codex-mcp', 'opencode-mcp',
  'codex-file', 'codex-config', 'opencode-file', 'opencode-config', 'agents-skills',
]);

export function migrateConfigKinds(s: { configApproval?: ConfigApproval; configTargets?: Record<string, boolean> }): Record<ConfigKindKey, ConfigKindMode> {
  const targets = s.configTargets ?? {};
  const out = {} as Record<ConfigKindKey, ConfigKindMode>;
  for (const k of CONFIG_KIND_KEYS) {
    if (k === 'transcript') { out[k] = defaultConfigKindMode(k); continue; }
    // その種類を運ぶ対象が全部切（configTargets で入でない）なら切。claude はいつも入り。
    const on = KIND_TARGETS[k].some((t) => t === 'claude' || targets[t] === true);
    if (!on) out[k] = 'off';
    else if (NEEDED_APPROVAL.has(k)) out[k] = s.configApproval === 'auto' ? 'auto' : 'confirm';
    else out[k] = defaultConfigKindMode(k);
  }
  return out;
}
