import type { LiveAsideDto, LiveStatus } from './api.ts';

/** 見出し、点の読み上げ、パレットで「裏だけ動いている」を言う語。Claude Code の言葉（background）に合わせる。 */
export const ASIDE_WORD = 'バックグラウンドで作業中';
/** 裏だけ動いている間、本体（指揮役）が入力を受け付けていることを言う語。 */
export const ASIDE_FREE = '指揮役は入力を受け付けている';

/**
 * 本体は入力を受け付けていて、裏の作業だけが動いているなら、その印を返す。
 * 入力待ちと休みは本体の状態のほうが強いので、印があっても裏だけとは読まない。
 */
export function asideOf(live: LiveStatus | null, aside: LiveAsideDto | null | undefined): LiveAsideDto | null {
  return live === 'busy' && aside ? aside : null;
}

/** 右の欄の灯の見出し。裏の担当が数えられないとき（workflow など）は、何が動いているかを言わない。 */
export function asideHead(a: LiveAsideDto): string {
  if (a.agents > 0) return `バックグラウンドで ${a.agents} 本`;
  return a.shell ? 'バックグラウンドでシェル' : ASIDE_WORD;
}
