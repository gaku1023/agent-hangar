/**
 * D1 の 1 日の上限に当たった失敗を見分ける（全体計画の D4）。
 *
 * Worker も端末も量を数えない。上限に当たったことは、D1 が返す失敗の文で知る。
 * 上限は日が変われば戻るので、直りようのない 500 ではなく、待てば通る 429 で返し、戻る時刻を添える。
 * 端末（packages/server の同期）は 429 を受けたら次の UTC の 0 時まで退く。
 * 本文の型と文の語と戻る時刻の計算は、端末と約束を共有するので shared の cloudLimit.ts に置いてある。
 *
 * Workers の 1 日の要求の上限（error 1027）は Worker を通らずに Cloudflare が返すので、ここでは扱わない。
 */
import { d1LimitOf, nextUtcMidnight, type CloudLimitBody } from '@agent-hangar/shared';

/** cause をたどる段の上限。輪になった cause で止まらないためである。 */
const MAX_CAUSE_DEPTH = 4;

/** 例外の文と、その原因（cause）の文を小文字にしてつなぐ。D1 は原因の側に本当の文を入れることがある。 */
function textsOf(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < MAX_CAUSE_DEPTH && cur instanceof Error; i++) {
    parts.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return parts.join('\n').toLowerCase();
}

/** 例外が D1 の上限の失敗なら、その種類を返す。ほかの失敗と Error でない値は null。 */
export function d1LimitOfError(e: unknown): 'd1-read' | 'd1-write' | null {
  return d1LimitOf(textsOf(e));
}

/** 429 で返す本文。resetAt は上限が戻る時刻（次の UTC の 0 時、epoch のミリ秒）である。 */
export function limitBody(kind: 'd1-read' | 'd1-write', now: number): CloudLimitBody {
  return { error: 'limit', limit: kind, resetAt: nextUtcMidnight(now) };
}
