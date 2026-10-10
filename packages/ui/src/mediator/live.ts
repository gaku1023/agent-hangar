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
 */
export function liveStep(state: State, store: Store): Step {
  const ids = waitingSessionIds(store);
  const was = new Set(state.waitingSeen);
  if (ids.length === was.size && ids.every((id) => was.has(id))) return { state, effects: [] };
  const now = new Set(ids);
  const seen = new Set(state.waitingSeen);
  const added = ids.filter((id) => !seen.has(id));
  // いま開いているセッションは画面に見えているので、カードにはしない。
  const open = state.screen.name === 'session' ? state.screen.id : null;
  const kept = state.waitingToasts.filter((id) => now.has(id));
  const waitingToasts = [...kept, ...added.filter((id) => id !== open)];
  // 窓が背面にあれば、開いているセッションも見えていない。
  // 通知を出すかどうかは、ランタイムが窓の様子と設定を見て決める。
  const effects: Effect[] = added.map((sessionId) => ({ kind: 'notify.waiting', sessionId }));
  if (ids.length !== state.waitingSeen.length) effects.push({ kind: 'badge', count: ids.length });
  return { state: { ...state, waitingSeen: ids, waitingToasts }, effects };
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
