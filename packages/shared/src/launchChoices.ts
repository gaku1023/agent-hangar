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

export { MODEL_CHOICES } from './summaryEngine.ts';
