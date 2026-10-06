import type { RateWindowDto, UsageDto } from './api.ts';

/**
 * 使用率の窓を、いまの時刻で読み直す。
 * 値は、そのアカウントのセッションが動いている間に statusline から届いたものしか無い。
 * 休んでいる間に戻る時刻を過ぎた窓は、届いた値のままでは古いので 0% にする。
 * 次の窓はそのアカウントを次に使ったときに始まるので、戻る時刻は分からず null にする。
 */
export function windowAt(w: RateWindowDto | null, now: number): RateWindowDto | null {
  if (w === null || w.resetsAt === null || now < w.resetsAt) return w;
  return { usedPercent: 0, resetsAt: null };
}

/** 5 時間と週の両方を windowAt で読み直す。どちらも変わらなければ同じものを返す。 */
export function usageAt(u: UsageDto, now: number): UsageDto {
  const fiveHour = windowAt(u.fiveHour, now);
  const sevenDay = windowAt(u.sevenDay, now);
  return fiveHour === u.fiveHour && sevenDay === u.sevenDay ? u : { ...u, fiveHour, sevenDay };
}
