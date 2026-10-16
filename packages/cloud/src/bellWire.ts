import { MOBILE_ASK_TIMEOUT_MS } from '@agent-hangar/shared';
import type { Env } from './env.ts';

/**
 * 呼び鈴（bell.ts の HangarBell）と Worker（mobile.ts）が分け合う値。
 * bell.ts は workerd の組み込み（cloudflare:workers）を読むので、Node で読む試験や mobile.ts からはこちらを読む。
 */

/** 呼び鈴の実体の名前。 */
export const BELL_NAME = 'bell';
/** Worker が Durable Object に端末の ID を渡す見出し。 */
export const BELL_DEVICE_HEADER = 'x-hangar-device';
/** スマホ 1 台からの問い合わせの回数の上限。 */
export const ASK_RATE = { max: 20, windowMs: 10_000 } as const;
/** 同じ PC が新しくつないだとき、古い WebSocket を閉じる符号。 */
export const REPLACED_CLOSE_CODE = 4000;

/**
 * 答えの待ちの長さ。
 * BELL_ASK_TIMEOUT_MS は試験で待ちを短くするためだけのもので、実物の配備では置かない。
 * 短くする向きにだけ効かせ、MOBILE_ASK_TIMEOUT_MS より長くはしない。
 */
export function askTimeoutMs(env: Pick<Env, 'BELL_ASK_TIMEOUT_MS'>): number {
  const n = Number(env.BELL_ASK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 && n < MOBILE_ASK_TIMEOUT_MS ? n : MOBILE_ASK_TIMEOUT_MS;
}
