import { waitingSessionIds, type Store } from '../store/store.ts';
import type { Effect, State, Step } from './types.ts';

/**
 * live 領域：入力待ちの知らせ。
 * 入力待ちのセッションの一覧は、ストアから読む（store.ts の waitingSessionIds）。
 * live.update はプロバイダの id で届くので、hangar のセッションへの引き当てはストアが済ませている。
 * ストアが変わるたびに呼ばれ、前に見た顔ぶれ（waitingSeen）と違うときだけ動く。並びの順だけが変わっても動かない。
 * 新たに入力待ちになったものを右下のカードに積み、通知の効果を出す。
 * 解けたものはカードから下げる。
 * 数が変わったら、バッジの効果を出す。
 *
 * 問いの文は、入力待ちより少し遅れて届くことがある（hook の台本や本文の索引が後になる）。
 * 問いの文なしで知らせたもの（waitingBare）に問いの文が届いたら、同じセッションの通知の効果をもう一度出す。
 * OS は同じ識別子（macOS）と同じタグ（Windows、ブラウザ）の通知を書き換えるので、2 枚にはならない。
 * 待つ時計（timer）は持たない。頁の時計は、窓を最小化すると絞られるからである。
 *
 * 開き直す前に知らせた入力待ちは、開き直しても知らせ直さない。
 * 頁の waitingSeen は起動のたびに空から始まるので、そのままでは起動の直後の一覧の入力待ちをどれも新しく入力待ちになったと読む。
 * そこで、入力待ちの 1 回ごとの鍵（waitingKeys）を localStorage に残し、起動のときに waitingCarried へ読み戻す。
 * この頁で初めて入力待ちと見たセッションの鍵が waitingCarried にあれば、カードとバッジは出すが、通知の効果は出さない。
 */
export function liveStep(state: State, store: Store): Step {
  const ids = waitingSessionIds(store);
  const keys = ids.map((id) => waitingKeyOf(store, id));
  const was = new Set(state.waitingSeen);
  const asked = (id: string) => !!store.sessions[id]?.activity?.question;
  const same = ids.length === was.size && ids.every((id) => was.has(id));
  const keysSame = sameList(keys, state.waitingKeys);
  // 顔ぶれが同じなら、書き換えを待っているものはどれもまだ入力待ちである。
  const late = state.waitingBare.filter(asked);
  if (same && late.length === 0) {
    if (keysSame) return { state, effects: [] };
    // 顔ぶれは同じで、最後の動きの時刻だけが進んだ（本文の索引が追いついたなど）。同じ入力待ちなので、鍵だけ残し直す。
    return { state: { ...state, waitingKeys: keys }, effects: [saveKeys(state.waitingCarried, keys)] };
  }
  const now = new Set(ids);
  const added = ids.filter((id) => !was.has(id));
  // 開き直す前に知らせ終えた入力待ちには、通知の効果を出さない。
  // 引き当てたセッションの鍵は、当たっても外れても使い終える。
  const carried = new Set(state.waitingCarried);
  const told = added.filter((id) => !carried.has(waitingKeyOf(store, id)));
  const addedSet = new Set(added);
  const waitingCarried = state.waitingCarried.filter((k) => !addedSet.has(sessionIdOfWaitingKey(k)));
  // いま開いているセッションは画面に見えているので、カードにはしない。
  const open = state.screen.name === 'session' ? state.screen.id : null;
  const kept = state.waitingToasts.filter((id) => now.has(id));
  const waitingToasts = [...kept, ...added.filter((id) => id !== open)];
  // 通知しなかったものは、問いの文が遅れて届いても書き換えない。
  const waitingBare = [...state.waitingBare.filter((id) => now.has(id) && !asked(id)), ...told.filter((id) => !asked(id))];
  // 窓が背面にあれば、開いているセッションも見えていない。
  // 通知を出すかどうかは、ランタイムと殻が窓の様子と設定を見て決める。
  const effects: Effect[] = [...late.filter((id) => now.has(id)), ...told].map((sessionId) => ({ kind: 'notify.waiting', sessionId }));
  if (ids.length !== state.waitingSeen.length) effects.push({ kind: 'badge', count: ids.length });
  if (!keysSame || waitingCarried.length !== state.waitingCarried.length) effects.push(saveKeys(waitingCarried, keys));
  return { state: { ...state, waitingSeen: ids, waitingBare, waitingToasts, waitingKeys: keys, waitingCarried }, effects };
}

/**
 * 入力待ちの鍵を残す localStorage の鍵。値は鍵の並び（古いものが先）。
 * 起動の設定の NOTIFY_KEY（'notify.waiting'、受け取るかどうか）とは別のものである。
 */
export const WAITING_NOTIFIED_KEY = 'waiting.notified';
/** 読み戻す鍵の数の上限。引き当てられないまま残る鍵（閉じている間に解けたもの）が、開き直すたびに増え続けないようにする。 */
const WAITING_NOTIFIED_MAX = 50;

/**
 * 入力待ちの 1 回の鍵は「セッションの id|最後の動きの時刻」である。
 * 答えればトランスクリプトが伸びて時刻が進むので、閉じている間に答えてまた入力待ちになったものは別の鍵になり、知らせる。
 * 時刻が無ければ空にする。
 */
function waitingKeyOf(store: Store, id: string): string {
  return `${id}|${store.sessions[id]?.lastActivityAt ?? ''}`;
}
const sessionIdOfWaitingKey = (key: string): string => key.slice(0, key.lastIndexOf('|'));
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 残す値は、まだ引き当てていない前の鍵と、いまの入力待ちの鍵である。
 * 前の鍵も残すのは、起動の直後でストアがまだ空か、セッションの動きがまだ届いていない間に、前の鍵を消してしまわないためである。
 */
function saveKeys(carried: string[], keys: string[]): Effect {
  return { kind: 'storage.save', key: WAITING_NOTIFIED_KEY, value: [...carried, ...keys] };
}

/** 残してあった鍵の並びを読む。文字列でないものは捨て、新しい方から上限までにする。 */
export function readWaitingNotified(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string').slice(-WAITING_NOTIFIED_MAX) : [];
}

/**
 * 開いているセッションの入力待ちのカードを下げる。
 * 開いて見たので、離れた後もまた積まない。
 */
export function settleWaiting(state: State): State {
  if (state.screen.name !== 'session' || !state.waitingToasts.includes(state.screen.id)) return state;
  const open = state.screen.id;
  return { ...state, waitingToasts: state.waitingToasts.filter((id) => id !== open) };
}
