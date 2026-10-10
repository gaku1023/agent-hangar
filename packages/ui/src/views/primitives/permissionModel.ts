import type { Translate } from '@agent-hangar/shared';
import type { IconName } from './Icon.tsx';

/** 権限モードの値（`claude --permission-mode` の選択肢）。空は「既定」で、起動の params に含めず Claude Code の設定に従わせる。 */
export const PERMISSION_DEFAULT = '';
export const PERMISSION_BYPASS = 'bypassPermissions';

/**
 * 縦の一覧の並び。既定から、できることの少ない順に並べ、Bypass permissions は最後に置く（呼ぶ側が線で区切り、赤で描く）。
 * 表示名は用語集（4.1）の決定で、日本語でも英語のまま出す。既定だけが言語で替わるので、名前は null にして呼ぶ側が引く。
 */
export const PERMISSION_MODES: { value: string; name: string | null; icon: IconName }[] = [
  { value: PERMISSION_DEFAULT, name: null, icon: 'permissionDefault' },
  { value: 'plan', name: 'Plan', icon: 'permissionPlan' },
  { value: 'manual', name: 'Manual', icon: 'permissionManual' },
  { value: 'acceptEdits', name: 'Accept edits', icon: 'permissionAcceptEdits' },
  { value: 'auto', name: 'Auto', icon: 'permissionAuto' },
  { value: 'dontAsk', name: "Don't ask", icon: 'permissionDontAsk' },
  { value: PERMISSION_BYPASS, name: 'Bypass permissions', icon: 'warning' },
];

/** 値から表示名を引く。空は「既定」、知らない値（新しい版の Claude Code の値など）はそのまま出す。 */
export function permissionLabel(value: string, t: Translate): string {
  if (value === PERMISSION_DEFAULT) return t('launch.value.default');
  return PERMISSION_MODES.find((m) => m.value === value)?.name ?? value;
}
