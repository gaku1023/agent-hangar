import type { SessionDto, SessionLockDto } from '@agent-hangar/shared';
import type { Store } from './store.ts';

/**
 * ほかの PC の会話の札に、この PC から答えたあとの手元の見え方。
 * 答えを送った時点で、相手の返事を待たずに待ちを外す（許可は実行中、拒否は入力待ち）。
 * ロック（SessionDto.lock）を書き換えて持つので、行、ホームの帯の数、検索の is:permission が一緒に変わる。
 * sig は答えた時のロックの状態の印（鼓動の時刻は含めない）、raw は相手から届いた最新のロックで、解くときに戻す値である。
 */
export type PeerAnswerHold = { askId: string; sig: string; raw: SessionLockDto; live: 'busy' | 'waiting'; at: number; /** 会話の更新で、答えが相手に届いたと分かった。時間切れでも知らせずに解く。 */ delivered?: true };

/** 相手の状態が動いたかを見る印。鼓動（heartbeatAt）だけの更新は動いたと見ない。 */
const sigOf = (l: SessionLockDto): string => [l.runId, l.stale, l.live ?? '', l.liveAt ?? '', l.reason ?? ''].join('|');

const shown = (raw: SessionLockDto, live: 'busy' | 'waiting'): SessionLockDto => ({ ...raw, live, reason: null });

/** 答えを送った。相手の返事を待たずに待ちを外す。ロックの無い会話（ほかの PC で動いていない）は何もしない。 */
export function holdPeerAnswer(store: Store, sessionId: string, askId: string, live: 'busy' | 'waiting', at: number): Store {
  const s = store.sessions[sessionId];
  const raw = s?.lock;
  if (!s || !raw) return store;
  const hold: PeerAnswerHold = { askId, sig: sigOf(raw), raw, live, at };
  return { ...store, peerAnswered: { ...store.peerAnswered, [sessionId]: hold }, sessions: { ...store.sessions, [sessionId]: { ...s, lock: shown(raw, live) } } };
}

/** その札の答えを、まだ手元の見え方で持っているか（相手の更新が届いていない）。 */
export function peerAnswerHeld(store: Store, sessionId: string, askId: string): boolean {
  return store.peerAnswered[sessionId]?.askId === askId;
}

/** 手元の見え方を持ったまま、答えが届いたかの確かめが無い（時間切れなら届かなかったとみなす）。 */
export function peerAnswerUnconfirmed(store: Store, sessionId: string, askId: string): boolean {
  const hold = store.peerAnswered[sessionId];
  return hold?.askId === askId && !hold.delivered;
}

/**
 * 会話の更新（peerChat.update）を入れたあとに、答えが届いたかを見る。
 * 札に答えが付いた、または後ろに項目が続いたら届いている。
 * そのとき次の札（複数の質問の次の問い）が答えを待っていれば、見え方を解いて本当の状態を出す。そうでなければ届いた印だけ付け、ロックの更新を待つ。
 */
export function confirmPeerAnswer(store: Store, sessionId: string): Store {
  const hold = store.peerAnswered[sessionId];
  const items = store.peerChat[sessionId]?.items;
  if (!hold || hold.delivered || !items) return store;
  const i = items.findIndex((it) => it.ask?.askId === hold.askId);
  if (i < 0 || (!items[i]!.ask!.answered && i === items.length - 1)) return store;
  const next = items.slice(i + 1).some((it) => it.ask && !it.ask.answered);
  if (next) return releasePeerAnswer(store, sessionId, hold.askId);
  return { ...store, peerAnswered: { ...store.peerAnswered, [sessionId]: { ...hold, delivered: true } } };
}

/** 見え方を持っている会話の全部で confirmPeerAnswer を通す（操作の答えに付いてきた会話の状態を入れたあと）。 */
export function confirmPeerAnswers(store: Store): Store {
  let s = store;
  for (const id of Object.keys(store.peerAnswered)) s = confirmPeerAnswer(s, id);
  return s;
}

/** 断られた、または時間切れ。相手から届いた最新のロックに戻す。別の札や、もう捨てた見え方なら何もしない。 */
export function releasePeerAnswer(store: Store, sessionId: string, askId: string): Store {
  const hold = store.peerAnswered[sessionId];
  if (!hold || hold.askId !== askId) return store;
  const { [sessionId]: _, ...rest } = store.peerAnswered;
  const s = store.sessions[sessionId];
  return { ...store, peerAnswered: rest, sessions: s ? { ...store.sessions, [sessionId]: { ...s, lock: hold.raw } } : store.sessions };
}

/**
 * 相手から会話の更新が届いた（session.upsert）。
 * 相手の状態が答えた時と同じなら、届いた値を raw に取って見え方を保つ。動いていたら見え方を捨てて、届いた値をそのまま使う。
 */
export function reconcilePeerAnswer(store: Store, next: SessionDto): { session: SessionDto; peerAnswered: Store['peerAnswered'] } {
  const hold = store.peerAnswered[next.id];
  if (!hold) return { session: next, peerAnswered: store.peerAnswered };
  const { [next.id]: _, ...rest } = store.peerAnswered;
  if (!next.lock || sigOf(next.lock) !== hold.sig) return { session: next, peerAnswered: rest };
  return { session: { ...next, lock: shown(next.lock, hold.live) }, peerAnswered: { ...store.peerAnswered, [next.id]: { ...hold, raw: next.lock } } };
}
