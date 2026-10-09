/**
 * Cloudflare の無料枠の 1 日の上限に当たったときの約束（作り替えの全体計画の D4）。
 *
 * hangar は量を数えない。
 * 上限に当たると Cloudflare が断るので、その失敗を見分けて、次の UTC の 0 時まで退く。
 * 見分けるのはサーバ（packages/server/src/sync/client.ts）で、Worker（段 1 の PR 6 から）は D1 の上限の失敗を 429 と下の本文で返す。
 */

/** 当たった上限。d1-read と d1-write は D1 の 1 日の行の上限、requests は Workers の 1 日の要求の上限（error 1027）である。 */
export type CloudLimitKind = 'd1-read' | 'd1-write' | 'requests';

const KINDS: readonly CloudLimitKind[] = ['d1-read', 'd1-write', 'requests'];

/**
 * D1 が上限で断ったときのメッセージに含まれる語。
 * Worker もこれを見て、D1 の失敗を 429 に替える（段 1 の PR 6）。
 */
export const D1_LIMIT_MESSAGES = {
  'd1-read': 'free tier daily row read limit',
  'd1-write': 'free tier daily row write limit',
} as const;

/** Worker が上限の失敗を返すときの 429 の本文。resetAt は次の UTC の 0 時（ミリ秒）である。 */
export type CloudLimitBody = { error: 'limit'; limit: CloudLimitKind; resetAt: number };

/** 次の UTC の 0 時。Cloudflare の 1 日の枠はここで戻る。ちょうど 0 時なら翌日の 0 時を返す。 */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** D1 の失敗のメッセージから、当たった上限を読む。上限の失敗でなければ null。 */
export function d1LimitOf(message: string): 'd1-read' | 'd1-write' | null {
  if (message.includes(D1_LIMIT_MESSAGES['d1-read'])) return 'd1-read';
  if (message.includes(D1_LIMIT_MESSAGES['d1-write'])) return 'd1-write';
  return null;
}

/**
 * 状態番号が 400 以上の応答が、上限による失敗かを読む。上限でなければ null を返す（例外を投げない）。
 *
 * 見分けるのは 3 つである。
 * 1. Worker の 429 と CloudLimitBody（段 1 の PR 6 から）。
 * 2. 本文に D1 の上限のメッセージを含むもの。形と状態番号は問わない。
 * 3. JSON でなく、本文に 1027 を含むもの。Workers の 1 日の要求の上限は、Worker を通らずに Cloudflare が返し、
 *    状態番号も本文の形も文書に無い（error 1027）。番号は語の境目で見る（ray ID のような 16 進の中の並びは数えない）。
 */
export function readCloudLimit(status: number, text: string): CloudLimitKind | null {
  if (status < 400) return null;
  let body: unknown;
  let isJson = true;
  try { body = JSON.parse(text); } catch { isJson = false; }
  if (isJson) {
    const b = body as Partial<CloudLimitBody> | null;
    if (status === 429 && b && b.error === 'limit' && KINDS.includes(b.limit as CloudLimitKind)) return b.limit as CloudLimitKind;
    return d1LimitOf(text);
  }
  return d1LimitOf(text) ?? (/\b1027\b/.test(text) ? 'requests' : null);
}
