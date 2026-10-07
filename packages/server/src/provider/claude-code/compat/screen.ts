import type { Drift } from './types.ts';

/**
 * ターンへ跳ぶときに読む画面の目印（runs/promptJump.ts）。
 * footer は transcript 表示の最下行の文言、prompt-marker は指示の行の頭の記号である。
 */
export type ScreenMark = 'footer' | 'prompt-marker';

export function screenDrift(mark: ScreenMark): Drift {
  return { contract: 'screen', value: mark === 'footer' ? 'transcript-footer=(missing)' : 'prompt-marker=(missing)', version: null };
}

/** 目印を記録するまでに、続けて見つからなかった跳び方の数。 */
export const SCREEN_MISS_THRESHOLD = 3;

/** 跳び方の結果（runs/promptJump.ts の JumpResult と同じ形）。provider から runs を引かないように、ここで形だけ書く。 */
type JumpOutcome = { found: true } | { found: false; reason: 'mode' | 'notFound' };

/**
 * 画面の目印が見つからなかったことを、続けて SCREEN_MISS_THRESHOLD 回になるまで記録しない門。
 * 描き直しが遅い、ダイアログが出ている、ペインが狭いといった一時の事情でも 1 回は見つからないことがある。
 * 形式が変わったのなら毎回見つからないので、続けて見つからないときだけ記録する。
 * 間に 1 回でも見えたら数え直す。
 * しきい値に達した後も見つからないままなら、見つからないたびに返す（回数が本当の失敗の数になる）。
 */
export class ScreenMissGate {
  private readonly misses = new Map<ScreenMark, number>();

  /**
   * 1 回の跳び方の結果を受け取り、記録する目印を返す。
   * missing はその跳び方で見つからなかった目印、result はその跳び方の結果である。
   * footer は、見つからないと言われなかった跳び方では見えていた。
   * 指示の行の記号は、着いたとき、または着けなかったが記号は見つかったときに見えていた。
   * モードで止まった跳び方は記号を読む前に止まっているので、記号については何も言わない。
   */
  observe(missing: readonly ScreenMark[], result: JumpOutcome): ScreenMark[] {
    const out: ScreenMark[] = [];
    const seen: ScreenMark[] = [];
    if (!missing.includes('footer')) seen.push('footer');
    if (!missing.includes('prompt-marker') && (result.found || result.reason === 'notFound')) seen.push('prompt-marker');
    for (const m of seen) this.misses.delete(m);
    for (const m of missing) {
      const n = (this.misses.get(m) ?? 0) + 1;
      this.misses.set(m, n);
      if (n >= SCREEN_MISS_THRESHOLD) out.push(m);
    }
    return out;
  }
}
