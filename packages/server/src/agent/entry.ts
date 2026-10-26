import { AGENT_KINDS, codexEnabledOf, codexInterceptOf, opencodeEnabledOf, opencodeInterceptOf, type AgentKind, type SettingsDto } from '@agent-hangar/shared';
import { findCodex, findOpencode } from '../config/tools.ts';

type EnabledFields = Pick<SettingsDto, 'opencodeEnabled' | 'opencodeIntercept' | 'codexEnabled' | 'codexIntercept'>;
/** 断る文に入れる設定の欄名の鍵。欄を足したらここにも足す（msg の型が、鍵を取り違えると落とす）。 */
export type EnabledLabelKey = 'settings.label.opencodeEnabled' | 'settings.label.codexEnabled';
export type InterceptLabelKey = 'settings.label.opencodeIntercept' | 'settings.label.codexIntercept';

/**
 * エージェントごとの入口の表。有効か、バイナリの場所、外のターミナルの横取り、断る文の欄名、設定のどの欄が変わったら動く部品を直すか。
 * 起動の入口（runs/manager.ts）と配線（boot/runs.ts）、設定の書き替え（config/settingsUpdate.ts）は、ここを引く。
 * 新しいエージェントは AgentKind に足したうえで、ここに 1 行足す。
 * Claude Code は常に有効で、実行ファイルは claudeBin（RunManagerDeps）が持つので bin は null を返す。
 */
export type AgentEntry = {
  enabled: (s: EnabledFields) => boolean;
  intercept: (s: EnabledFields) => boolean;
  bin: () => string | null;
  /** 有効でないとき、断る文に入れる設定の欄名。Claude Code は常に有効なので無い。 */
  enabledLabelKey: EnabledLabelKey | null;
  interceptLabelKey: InterceptLabelKey | null;
  /** 入り切りが変わると、シェルの包み（tmux のパスと各 agent() の有無）を書き直す設定の欄。 */
  shellKeys: readonly (keyof SettingsDto)[];
  /** 入り切りの欄。変わるとスマホの一覧（受信箱の素）を組み直す。 */
  enabledKeys: readonly (keyof SettingsDto)[];
};

export const AGENT_ENTRY: Record<AgentKind, AgentEntry> = {
  'claude-code': { enabled: () => true, intercept: () => false, bin: () => null, enabledLabelKey: null, interceptLabelKey: null, shellKeys: [], enabledKeys: [] },
  opencode: {
    enabled: opencodeEnabledOf,
    intercept: opencodeInterceptOf,
    bin: () => findOpencode(),
    enabledLabelKey: 'settings.label.opencodeEnabled',
    interceptLabelKey: 'settings.label.opencodeIntercept',
    shellKeys: ['opencodeEnabled', 'opencodeIntercept'],
    enabledKeys: ['opencodeEnabled'],
  },
  // Codex（ベータ）。PATH から探す（ChatGPT.app の同梱は使わない）。driver は段 B の後続で足す（それまで起動は断る）。
  codex: {
    enabled: codexEnabledOf,
    intercept: codexInterceptOf,
    bin: () => findCodex(),
    enabledLabelKey: 'settings.label.codexEnabled',
    interceptLabelKey: 'settings.label.codexIntercept',
    shellKeys: ['codexEnabled', 'codexIntercept'],
    enabledKeys: ['codexEnabled'],
  },
};

/** 設定の書き替えで、どれかの agent の欄が含まれているか見るための欄名の一覧。 */
export function agentSettingsKeys(which: 'shell' | 'enabled'): (keyof SettingsDto)[] {
  const out = new Set<keyof SettingsDto>();
  for (const k of AGENT_KINDS) for (const key of which === 'shell' ? AGENT_ENTRY[k].shellKeys : AGENT_ENTRY[k].enabledKeys) out.add(key);
  return [...out];
}
