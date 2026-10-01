import type { LiveStatus } from './api.ts';

/**
 * 画面で数えるときのセッションの状態。
 * 実行中は作業中と休みと起動中（hangar の run は生きているが、Claude の一覧にまだ載っていない）を指す。
 * 入力待ちは実行中に含めず、どの画面でも別に数える。
 * どちらでもなければ終了である。
 */
export type LiveFilter = 'running' | 'waiting' | 'ended';

/** Claude の一覧の状態と、hangar の run が生きているかから、画面で数える状態を決める。 */
export function liveFilterOf(live: LiveStatus | null, hasAliveRun: boolean): LiveFilter {
  if (live === 'waiting') return 'waiting';
  if (live !== null || hasAliveRun) return 'running';
  return 'ended';
}
