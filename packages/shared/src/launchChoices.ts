/**
 * 新しい会話を起こすときに選べる値。PC の新規セッションのダイアログとスマホの画面が同じ値を使う。
 * 空は「既定」で、起動の params に含めず Claude Code の設定に従わせる。
 */
export const PERMISSION_MODE_VALUES = ['', 'plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type PermissionModeValue = (typeof PERMISSION_MODE_VALUES)[number];

export { MODEL_CHOICES } from './summaryEngine.ts';
