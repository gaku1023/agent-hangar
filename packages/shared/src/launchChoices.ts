import { AGENT_KINDS, type AgentKind } from './agents.ts';
/**
 * 新しい会話を起こすときに選べる値。PC の新規セッションのダイアログとスマホの画面が同じ値を使う。
 * 空は「既定」で、起動の params に含めず Claude Code の設定に従わせる。
 */
export const PERMISSION_MODE_VALUES = ['', 'plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type PermissionModeValue = (typeof PERMISSION_MODE_VALUES)[number];

/**
 * effort の選択肢。PC の新規セッションの札とスマホの画面と、スマホの依頼を受ける PC が同じ値を使う。
 * 空は「既定」で、起動の params に含めず Claude Code の設定に従わせる。
 */
export const EFFORT_VALUES = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortValue = (typeof EFFORT_VALUES)[number];

export function isEffort(v: unknown): v is EffortValue {
  return typeof v === 'string' && (EFFORT_VALUES as readonly string[]).includes(v);
}

/**
 * 起こすエージェント（新しいセッションの「エージェント」の札）。並びは札の一覧の順で、先頭が既定である。
 * opencode（ベータ）は設定で有効にしたときだけ選べる。
 */
export const AGENT_VALUES = AGENT_KINDS;
export type AgentValue = AgentKind;

export function isAgentValue(v: unknown): v is AgentValue {
  return typeof v === 'string' && (AGENT_VALUES as readonly string[]).includes(v);
}

/** opencode のモードの既定。opencode が既定で使う primary のエージェントである。 */
export const OPENCODE_DEFAULT_MODE = 'build';

/** モードの一覧から、はじめに選んでおくモード。build があれば build、無ければ先頭、一覧が空なら空（params に載せない）。 */
export function defaultOpencodeMode(modes: readonly { id: string }[]): string {
  return modes.some((m) => m.id === OPENCODE_DEFAULT_MODE) ? OPENCODE_DEFAULT_MODE : modes[0]?.id ?? '';
}

export { MODEL_CHOICES } from './summaryEngine.ts';
