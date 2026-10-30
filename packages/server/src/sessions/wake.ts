import type { Db } from '../db/open.ts';

/**
 * 休みから作業中へ移った時刻を、会話ごとに覚える（2026-10-31）。
 * 状態（Done・Archived・Paused）を付けた後にこれが進んでいれば、その会話は付けた後に動き出した（woke）とみなし、知らせを止めない。
 * 付けたターンの間は作業中か入力待ちのままで休みを挟まないので、そのターンの notify_user と入力待ちは静かになる。
 * 見張り（CI の待ちなど）の終わりで動き出したときと、同じプロセスで続けて打ったときは、休みから作業中へ移るので知らせる。
 *
 * 手元の覚えで、DB に書かない。サーバを起こし直すと忘れ、付けた後に動き出したものも静かな側に戻る。
 * 実行中の一覧を見る受け手（liveChange.ts）が書き、セッションを組む所（db/queries.ts）が読む。
 * setParkingSwitch と同じく DB に結ぶ。呼び手ごとに引数で渡すと、セッションを組む全ての経路（一覧、配信、MCP）に通す必要があるからである。
 */
const wakes = new WeakMap<Db, Map<string, number>>();

/** 会話が休みから作業中へ移った。 */
export function noteWake(db: Db, sessionId: string, at: number): void {
  let m = wakes.get(db);
  if (!m) { m = new Map(); wakes.set(db, m); }
  m.set(sessionId, at);
}

/** 状態を付けた時刻（setAt）より後に、休みから動き出したか。付けた時刻が無ければ偽。 */
export function wokeSince(db: Db, sessionId: string, setAt: number | null): boolean {
  const at = wakes.get(db)?.get(sessionId);
  return setAt !== null && at !== undefined && at >= setAt;
}
