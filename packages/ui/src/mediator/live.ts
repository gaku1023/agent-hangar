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
 */
export function liveStep(state: State, store: Store): Step {
  const ids = waitingSessionIds(store);
  const was = new Set(state.waitingSeen);
  const asked = (id: string) => !!store.sessions[id]?.activity?.question;
  const same = ids.length === was.size && ids.every((id) => was.has(id));
  // 顔ぶれが同じなら、書き換えを待っているものはどれもまだ入力待ちである。
  const late = state.waitingBare.filter(asked);
  if (same && late.length === 0) return { state, effects: [] };
  const now = new Set(ids);
  const added = ids.filter((id) => !was.has(id));
  // いま開いているセッションは画面に見えているので、カードにはしない。
  const open = state.screen.name === 'session' ? state.screen.id : null;
  const kept = state.waitingToasts.filter((id) => now.has(id));
  const waitingToasts = [...kept, ...added.filter((id) => id !== open)];
  const waitingBare = [...state.waitingBare.filter((id) => now.has(id) && !asked(id)), ...added.filter((id) => !asked(id))];
  // 窓が背面にあれば、開いているセッションも見えていない。
  // 通知を出すかどうかは、ランタイムと殻が窓の様子と設定を見て決める。
  const effects: Effect[] = [...late.filter((id) => now.has(id)), ...added].map((sessionId) => ({ kind: 'notify.waiting', sessionId }));
  if (ids.length !== state.waitingSeen.length) effects.push({ kind: 'badge', count: ids.length });
  return { state: { ...state, waitingSeen: ids, waitingBare, waitingToasts }, effects };
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
