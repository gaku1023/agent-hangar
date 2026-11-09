import type { Input, State, Step } from './types.ts';

/** 覚えておく印の数の上限。行が出ないまま残った古い印は、新しい印が来たときに押し出される。 */
export const WAKE_GLOW_KEPT = 8;

/**
 * wakeGlow 領域：できごとで Paused の会話を起こしたとき、サイドバーの行が Active に入る瞬間に 1 度だけ光らせる印（#563 の E4）。
 * サーバの session.woken（会話の id と時刻）を受けて覚え、同じ会話は 1 つにまとめる。
 * 行が光り終えたら wakeGlow.seen で下げる。下げたあとに同じ会話が動き出しても、光らせない。
 * 行が出ないまま残る印は、WAKE_GLOW_KEPT を越えたら古い方から落とす。見せるときは時刻を見て、古い印は使わない（presenters/shell.ts）。
 * 起こしたのが利用者の操作かできごとかは、状態の setBy では分からない（どちらも user）ので、この知らせだけが手掛かりである。
 */
export function wakeGlowStep(state: State, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'session.woken') {
    const { id, at } = input.event;
    const wakeGlow = [...state.wakeGlow.filter((g) => g.id !== id), { id, at }].slice(-WAKE_GLOW_KEPT);
    return { state: { ...state, wakeGlow }, effects: [] };
  }
  if (input.kind === 'action' && input.action.type === 'wakeGlow.seen') {
    const id = input.action.id;
    if (!state.wakeGlow.some((g) => g.id === id)) return { state, effects: [] };
    return { state: { ...state, wakeGlow: state.wakeGlow.filter((g) => g.id !== id) }, effects: [] };
  }
  return null;
}
