import type { LiveAsideDto, LiveStatus } from './api.ts';

/** 見出しや札で「裏だけ動いている」を言う語。 */
export const ASIDE_WORD = '裏で作業中';
/** 裏だけ動いている間、本体（指揮役）が入力を受け付けていることを言う語。 */
export const ASIDE_FREE = '指揮役は空いている';

/**
 * 本体は入力を受け付けていて、裏の作業だけが動いているなら、その印を返す。
 * 入力待ちと休みは本体の状態のほうが強いので、印があっても裏だけとは読まない。
 */
export function asideOf(live: LiveStatus | null, aside: LiveAsideDto | null | undefined): LiveAsideDto | null {
  return live === 'busy' && aside ? aside : null;
}

/** サイドバーの行に添える短い語。サブエージェントの本数が分かればそれを添える。シェルの本数は Claude が登録に書かないので数えない。 */
export function asideMark(a: LiveAsideDto): string {
  return a.agents > 0 ? `裏 ${a.agents}` : '裏';
}

/** 右の欄の灯の見出し。裏の担当が数えられないとき（workflow など）は、何が動いているかを言わない。 */
export function asideHead(a: LiveAsideDto): string {
  if (a.agents > 0) return `裏で ${a.agents} 本動いている`;
  return a.shell ? '裏でシェルが動いている' : '裏で作業が動いている';
}
