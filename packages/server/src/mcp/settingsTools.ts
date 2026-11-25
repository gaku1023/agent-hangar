import type { SettingsDto } from '@agent-hangar/shared';
import { defaultLanguage, type GetLanguage } from '../i18n/language.ts';
import { msg, render } from '../i18n/message.ts';
import { ToolError } from './tools.ts';

/**
 * 設定を読み書きする MCP の道具（get_settings と update_settings）。
 * 書くときは項目ごとの段で分ける（2026-11-18 に利用者と決めた）。
 *
 * - direct：見た目と知らせ方。聞かずに書いてよい。
 * - confirm：それ以外の、書けても乗っ取りにならない項目。エージェントがチャットで利用者に聞き、confirmed: true を付けて渡したときだけ書く。
 *   hangar はその申告を確かめられない（propose_session_status と同じ余地）。インジェクションされたエージェントは付けられるので、守るのはうっかりの変更までである。
 * - refused：書かれると任意のコマンドが動く項目（パス、エディタ、準備のコマンド）、会話を外へ出せる項目（要約の宛先と外への許し）、鍵、
 *   専用の道具か画面にしか書かせない項目。MCP からは confirmed があっても受けない。画面で変える。
 *
 * 書くのは画面と同じ PATCH /api/settings の処理（patchSettings）で、値の検査、保存、画面への配りはそちらに任せる。
 * 表は SettingsDto の全部の鍵を持つ。設定を足して段を付け忘れると、型が止める。
 */
export type SettingTier = 'direct' | 'confirm' | 'refused';

/** PATCH にだけある鍵（SettingsDto に返らない書く口）。 */
type WriteOnlyKey = 'summaryApiKey' | 'dryRun';

export const SETTING_TIERS: Record<keyof SettingsDto | WriteOnlyKey, SettingTier> = {
  // 見た目と知らせ方
  language: 'direct', unreadBadge: 'direct', unreadOs: 'direct', unreadPhone: 'direct', sidebarOtherPcs: 'direct', notifyPreference: 'direct',
  // 聞いてから
  terminalApp: 'confirm', defaultModel: 'confirm', autoDone: 'confirm', autoDoneIdleDays: 'confirm', autoPark: 'confirm',
  askStatusAtEnd: 'confirm', liveHints: 'confirm', notifyUser: 'confirm',
  summaryEngine: 'confirm', summaryClaudeModel: 'confirm', summaryHourlyCap: 'confirm',
  opencodeLocalContext: 'confirm', opencodeIdleUnload: 'confirm', contextWarnTokens: 'confirm', contextAlertTokens: 'confirm', codexEnabled: 'confirm', opencodeEnabled: 'confirm', voice: 'confirm',
  remoteControl: 'confirm', peerChatAcceptFromPeers: 'confirm', phoneChatAccept: 'confirm', eventTrigger: 'confirm', translateEnglish: 'confirm',configBundleSync: 'confirm', configKinds: 'confirm',
  codexShareInstructions: 'confirm', codexShareMcp: 'confirm', opencodeShareInstructions: 'confirm', opencodeShareMcp: 'confirm',
  codexInjection: 'confirm', opencodeInjection: 'confirm', codexIntercept: 'confirm', opencodeIntercept: 'confirm', opencodePermissionPreset: 'confirm',
  workspaceRoot: 'confirm', orchestrator: 'confirm',
  // 受けない
  claudeDir: 'refused', tmuxPath: 'refused', nodePath: 'refused', claudePath: 'refused', codexPath: 'refused', opencodePath: 'refused',
  editor: 'refused', opencodeProviderPrep: 'refused',
  summaryApiKey: 'refused', trustedWorkspaceRoot: 'refused', translateHintDeclined: 'refused', permissionPolicy: 'refused',
  configApproval: 'refused', configTargets: 'refused', dryRun: 'refused',
};

export type PatchOutcome = { ok: true; settings: SettingsDto } | { ok: false; error: string };
export type SettingsToolDeps = {
  /** 画面へ返すのと同じ形の設定（鍵は保存の有無だけ）。 */
  settingsDto: () => SettingsDto;
  /** 画面と同じ PATCH /api/settings の処理を通して書く。 */
  patchSettings: (body: Record<string, unknown>) => Promise<PatchOutcome>;
  language?: GetLanguage;
};

const tierOf = (key: string): SettingTier | undefined => (Object.hasOwn(SETTING_TIERS, key) ? SETTING_TIERS[key as keyof typeof SETTING_TIERS] : undefined);
const keysIn = (tier: SettingTier): string[] => Object.entries(SETTING_TIERS).filter(([, t]) => t === tier).map(([k]) => k);

/** 今の値と、項目ごとの段。 */
export function getSettingsTool(deps: SettingsToolDeps) {
  return { settings: deps.settingsDto(), tiers: { direct: keysIn('direct'), confirm: keysIn('confirm'), refused: keysIn('refused') } };
}

/**
 * 設定を書く。changes の鍵を全部先に見て、1 つでも断る鍵があれば何も書かない。
 * confirm の鍵があって confirmed が true でなければ、何も書かずに前と後の値を返す（エージェントはそれを見せて利用者に聞く）。
 */
export async function updateSettingsTool(deps: SettingsToolDeps, args: Record<string, unknown>) {
  const changes = args.changes;
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes) || Object.keys(changes).length === 0) throw new ToolError(msg('mcp.settings.badChanges'));
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new ToolError(msg('common.field.mustBeBoolean', { field: 'confirmed' }));
  const body = changes as Record<string, unknown>;
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => tierOf(k) === undefined);
  if (unknown.length > 0) throw new ToolError(msg('mcp.settings.unknownKey', { keys: unknown.join(', ') }));
  const refused = keys.filter((k) => tierOf(k) === 'refused');
  if (refused.length > 0) throw new ToolError(msg('mcp.settings.refused', { keys: refused.join(', ') }));
  const toConfirm = keys.filter((k) => tierOf(k) === 'confirm');
  if (toConfirm.length > 0 && args.confirmed !== true) {
    const cur = deps.settingsDto() as Record<string, unknown>;
    return {
      status: 'needs_confirmation', keys: toConfirm,
      current: Object.fromEntries(toConfirm.map((k) => [k, cur[k] ?? null])),
      proposed: Object.fromEntries(toConfirm.map((k) => [k, body[k]])),
      note: render((deps.language ?? defaultLanguage)(), msg('mcp.settings.needsConfirmation')),
    };
  }
  const r = await deps.patchSettings(body);
  if (!r.ok) throw new ToolError(r.error);
  const after = r.settings as Record<string, unknown>;
  return { status: 'updated', changed: Object.fromEntries(keys.map((k) => [k, after[k] ?? null])) };
}
