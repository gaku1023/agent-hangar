import type { SessionDto, Translate } from '@agent-hangar/shared';

/**
 * スマホから起動した会話のラベル（試作 F1）。一覧の行（row.ts）とセッションの見出しの札（session.ts）で同じ語を使う。
 * Bypass permissions で起こしたものは「スマホから · Bypass permissions」にし、色に頼らずに見分けられるようにする（赤い枠は CSS）。
 * PC で起こした会話と、他の PC がスマホの依頼で起こした会話（印は起こした PC にだけある）は null。
 */
export function phoneLabelOf(s: Pick<SessionDto, 'fromPhone'>, t: Translate): { label: string; title: string; bypass: boolean } | null {
  if (!s.fromPhone) return null;
  const bypass = s.fromPhone.bypass;
  return { label: t(bypass ? 'phoneLaunch.label.bypass' : 'phoneLaunch.label.plain'), title: t('phoneLaunch.label.title'), bypass };
}
