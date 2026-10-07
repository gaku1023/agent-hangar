import type { Drift } from './types.ts';

/**
 * ターンへ跳ぶときに読む画面の目印（runs/promptJump.ts）。
 * footer は transcript 表示の最下行の文言、prompt-marker は指示の行の頭の記号である。
 */
export type ScreenMark = 'footer' | 'prompt-marker';

export function screenDrift(mark: ScreenMark): Drift {
  return { contract: 'screen', value: mark === 'footer' ? 'transcript-footer=(missing)' : 'prompt-marker=(missing)', version: null };
}
