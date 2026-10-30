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
 * Done、Archived、Paused にしたセッションは、問いで待っている最中に区切りを付けても Claude は止まらず（休みではないので）、live が waiting のまま残る。
 * 利用者はもう答えないと決めているので、入力待ちには数えず、休み（idle）として扱う。動いている事実は変わらないので、実行中の側には残る。
 * Paused も静かにする（2026-10-31 の利用者の決定。それまでは戻ってくるものとして入力待ちのままにしていた）。
 * ただし、状態を付けた後に休みから動き出したもの（woke、SessionDto の同じ欄）は、そのまま入力待ちにする。見張り（CI の待ちなど）の終わりで動き出した会話の問いは、利用者が待っていたものである。
 * 入力待ちの件数、要対応、バッジ、「入力待ち」の札や色は、すべてこの値から決める（liveFilterOf に渡す live も、これを通す）。
 */
export function quietLive(live: LiveStatus | null, status: SessionStatus | null | undefined, woke = false): LiveStatus | null {
  return live === 'waiting' && isQuietStatus(status) && !woke ? 'idle' : live;
}

/** 知らせを止める状態（Done、Archived、Paused）か。notify_user と入力待ちの通知が見る。 */
export function isQuietStatus(status: SessionStatus | null | undefined): boolean {
  return status === 'done' || status === 'archived' || status === 'paused';
}

/**
 * Claude の一覧の状態と、hangar の run が生きているかから、画面で数える状態を決める。
 * parked（Done か Archived を付けて休みのまま残っているもの、isParked）は、プロセスが残っていても終了に数える。
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
 * 区切り（Done・Archived）を付けたのに、プロセスが休みのまま残っているか。
 * 真なら実行中に数えず、hangar が止められるものは止める。
 * Paused は偽にする。戻ってくる会話なので止めず、実行中のまま出す（2026-10-13 の決定。それまでは Paused も止めていた）。
 * 作業中と入力待ちは偽にする。本当に動いているものと答えを待つものは、印が付いていても見失わせない。
 * 導入時の一括 Done（setBy が import）は偽にする。利用者が区切ると決めたものではないので、動いている会話を巻き込まない。
 * 印より後に起動したプロセスは偽にする。再開して開いたものは、最初の発言で印が外れるまで動いているものとして扱う。
 * 起動時刻は秒に切り捨てて届くので、印の 1 秒以上前に起動したものだけを「前」と言う。
 * 起動時刻が取れないときも偽にする。印を外す側（サーバの stateClears）と同じく、分からないときは今のままにする。
 * 使用制限で止まっている間（limited、リセットの猶予の内）も偽にする。
 * 止めると、Claude Code が予約した自動の続きごと消えるからである。休みに見えても、リセットを待っている。
 */
export function isParked(o: { status: SessionStatus | null; setBy: StateSetBy | null; setAt: number | null; live: LiveStatus | null; processStartedAt: number | null; limited?: boolean }): boolean {
  if ((o.status !== 'done' && o.status !== 'archived') || o.setBy === 'import' || o.setAt === null || o.live !== 'idle' || o.limited) return false;
  return o.processStartedAt !== null && o.processStartedAt + START_PRECISION_MS <= o.setAt;
}
