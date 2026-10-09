import type { LiveAsideDto, LiveStatus, Translate } from '@agent-hangar/shared';

/** 見出し、点の読み上げ、パレットで「裏だけ動いている」を言う語。Claude Code の言葉（background）に合わせる。 */
export const asideWord = (t: Translate): string => t('common.aside.word');
/** 裏だけ動いている間、本体（メイン会話）が入力を受け付けていることを言う語。 */
export const asideFree = (t: Translate): string => t('common.aside.free');

/**
 * 本体は入力を受け付けていて、裏の作業だけが動いているなら、その印を返す。
 * 入力待ちと休みは本体の状態のほうが強いので、印があっても裏だけとは読まない。
 */
export function asideOf(live: LiveStatus | null, aside: LiveAsideDto | null): LiveAsideDto | null {
  return live === 'busy' && aside ? aside : null;
}

/** 右の欄の灯の見出し。裏の担当が数えられないとき（workflow など）は、何が動いているかを言わない。 */
export function asideHead(t: Translate, a: LiveAsideDto): string {
  if (a.agents > 0) return t('common.aside.agents', { n: a.agents });
  return a.shell ? t('common.aside.shell') : asideWord(t);
}
