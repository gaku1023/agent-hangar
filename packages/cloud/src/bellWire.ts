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
/** 鳴らすときに、PC どうしの頼みの知らせの種類と頼みの ID を渡す見出し（無ければ従来の { t: 'launch' }）。 */
export const BELL_RING_KIND_HEADER = 'x-hangar-ring-kind';
export const BELL_RING_ID_HEADER = 'x-hangar-ring-id';
/** BELL_RING_KIND_HEADER にこの値を載せると、{ t: 'changes' }（同じクラウドの別の PC が変更を push した。pull を早める）を送る。頼みの ID は要らない。 */
export const BELL_CHANGES_KIND = 'changes';
/** スマホ 1 台からの問い合わせの回数の上限。 */
export const ASK_RATE = { max: 20, windowMs: 10_000 } as const;
/** PC 1 台からの会話の問い合わせ（POST /peer/ask）の回数の上限（互換の版 11）。 */
export const PEER_ASK_RATE = { max: 120, windowMs: 60_000 } as const;
/** 会話の問い合わせの答えの待ちに足す余裕。実際の待ちは waitMs にこれを足した長さである。 */
export const PEER_ASK_GRACE_MS = 5_000;
/** 同じ PC が新しくつないだとき、古い WebSocket を閉じる符号。 */
export const REPLACED_CLOSE_CODE = 4000;

/**
 * 会話の問い合わせの、waitMs に足す余裕の長さ（5 秒）。
 * 試験では BELL_ASK_TIMEOUT_MS で短くできる（短くする向きにだけ効く）。
 */
export function peerAskGraceMs(env: Pick<Env, 'BELL_ASK_TIMEOUT_MS'>): number {
  const n = Number(env.BELL_ASK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 && n < PEER_ASK_GRACE_MS ? n : PEER_ASK_GRACE_MS;
}

/**
 * 答えの待ちの長さ。
 * BELL_ASK_TIMEOUT_MS は試験で待ちを短くするためだけのもので、実物の配備では置かない。
 * 短くする向きにだけ効かせ、MOBILE_ASK_TIMEOUT_MS より長くはしない。
 */
export function askTimeoutMs(env: Pick<Env, 'BELL_ASK_TIMEOUT_MS'>): number {
  const n = Number(env.BELL_ASK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 && n < MOBILE_ASK_TIMEOUT_MS ? n : MOBILE_ASK_TIMEOUT_MS;
}
