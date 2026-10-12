import type { LiveStatus } from './api.ts';
import type { SessionStatus, StateSetBy } from './sessionState.ts';

/**
 * 画面で数えるときのセッションの状態。
 * 実行中は作業中と休みと起動中（hangar の run は生きているが、Claude の一覧にまだ載っていない）を指す。
 * 入力待ちは実行中に含めず、どの画面でも別に数える。
 * どちらでもなければ終了である。
 */
export type LiveFilter = 'running' | 'waiting' | 'ended';

/**
 * 利用者の注意を求める数や印に使う、セッションの動き。
 * Done と Archived にしたセッションは、問いで待っている最中に区切りを付けても Claude は止まらず（休みではないので）、live が waiting のまま残る。
 * 利用者はもう答えないと決めているので、入力待ちには数えず、休み（idle）として扱う。動いている事実は変わらないので、実行中の側には残る。
 * Paused は戻ってくるものなので、そのまま入力待ちにする。
 * 入力待ちの件数、要対応、バッジ、「入力待ち」の札や色は、すべてこの値から決める（liveFilterOf に渡す live も、これを通す）。
 */
export function quietLive(live: LiveStatus | null, status: SessionStatus | null | undefined): LiveStatus | null {
  return live === 'waiting' && (status === 'done' || status === 'archived') ? 'idle' : live;
}

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

/** 起動時刻の粗さ。Claude の登録の起動時刻は秒までしか持たない。 */
const START_PRECISION_MS = 1000;

/**
 * 区切り（Paused・Done・Archived）を付けたのに、プロセスが休みのまま残っているか。
 * 真なら実行中に数えず、hangar が止められるものは止める。
 * 作業中と入力待ちは偽にする。本当に動いているものと答えを待つものは、印が付いていても見失わせない。
 * 導入時の一括 Done（setBy が import）は偽にする。利用者が区切ると決めたものではないので、動いている会話を巻き込まない。
 * 印より後に起動したプロセスは偽にする。再開して開いたものは、最初の発言で印が外れるまで動いているものとして扱う。
 * 起動時刻は秒に切り捨てて届くので、印の 1 秒以上前に起動したものだけを「前」と言う。
 * 起動時刻が取れないときも偽にする。印を外す側（サーバの stateClears）と同じく、分からないときは今のままにする。
 * 使用制限で止まっている間（limited、リセットの猶予の内）も偽にする。
 * 止めると、Claude Code が予約した自動の続きごと消えるからである。休みに見えても、リセットを待っている。
 */
export function isParked(o: { status: SessionStatus | null; setBy: StateSetBy | null; setAt: number | null; live: LiveStatus | null; processStartedAt: number | null; limited?: boolean }): boolean {
  if (o.status === null || o.setBy === 'import' || o.setAt === null || o.live !== 'idle' || o.limited) return false;
  return o.processStartedAt !== null && o.processStartedAt + START_PRECISION_MS <= o.setAt;
}
