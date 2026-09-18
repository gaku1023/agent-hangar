import type { Effect, Input, State, Step } from './types.ts';

/** live 領域：waiting になった Claude のセッションを一度だけトーストにする。 */
export function liveStep(state: State, input: Input): Step | null {
  if (input.kind !== 'server' || input.event.type !== 'live.update') return null;
  const waiting = input.event.live.filter((l) => l.status === 'waiting');
  const seen = new Set(state.waitingSeen);
  const effects: Effect[] = waiting.filter((l) => !seen.has(l.sessionId)).map((l) => ({ kind: 'toast', level: 'info', message: `「${l.name ?? l.sessionId.slice(0, 8)}」があなたの入力を待っています` }));
  const next = waiting.map((l) => l.sessionId);
  const same = next.length === state.waitingSeen.length && next.every((id, i) => id === state.waitingSeen[i]);
  return { state: same ? state : { ...state, waitingSeen: next }, effects };
}
