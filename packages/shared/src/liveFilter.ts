import type { LiveStatus } from './api.ts';
import type { SessionStatus } from './sessionState.ts';

/**
 * 画面で数えるときのセッションの状態。
 * 実行中は作業中と休みと起動中（hangar の run は生きているが、Claude の一覧にまだ載っていない）を指す。
 * 入力待ちは実行中に含めず、どの画面でも別に数える。
 * どちらでもなければ終了である。
 */
export type LiveFilter = 'running' | 'waiting' | 'ended';

/**
 * Claude の一覧の状態と、hangar の run が生きているかから、画面で数える状態を決める。
 * parked（区切りを付けて休みのまま残っているもの、isParked）は、プロセスが残っていても終了に数える。
 */
export function liveFilterOf(live: LiveStatus | null, hasAliveRun: boolean, parked = false): LiveFilter {
  if (parked) return 'ended';
  if (live === 'waiting') return 'waiting';
  if (live !== null || hasAliveRun) return 'running';
  return 'ended';
}

/**
 * 区切り（Paused・Done・Archived）を付けたのに、プロセスが休みのまま残っているか。
 * 真なら実行中に数えず、hangar が止められるものは止める。
 * 作業中と入力待ちは偽にする。本当に動いているものと答えを待つものは、印が付いていても見失わせない。
 * 印より後に起動したプロセスは偽にする。再開して開いたものは、最初の発言で印が外れるまで動いているものとして扱う。
 * 起動時刻が取れないときも偽にする。印を外す側（サーバの stateClears）と同じく、分からないときは今のままにする。
 */
export function isParked(o: { status: SessionStatus | null; setAt: number | null; live: LiveStatus | null; processStartedAt: number | null }): boolean {
  if (o.status === null || o.setAt === null || o.live !== 'idle') return false;
  return o.processStartedAt !== null && o.processStartedAt <= o.setAt;
}
