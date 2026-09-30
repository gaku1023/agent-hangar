import type { Effect, Input, State, Step } from './types.ts';

/**
 * live 領域：入力待ちの知らせ。
 * 入力待ちのセッションの一覧は、ランタイムが hangar のセッションの id に引き当てて届ける（waiting.changed）。
 * 新たに入力待ちになったものを右下のカードに積み、通知の効果を出す。
 * 解けたものはカードから下げる。
 * 数が変わったら、バッジの効果を出す。
 */
export function liveStep(state: State, input: Input): Step | null {
  if (input.kind !== 'runtime' || input.event.type !== 'waiting.changed') return null;
  const ids = input.event.ids;
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
