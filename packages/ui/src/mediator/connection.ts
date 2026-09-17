import type { Input, State, Step } from './types.ts';

/** connection 領域：WebSocket の状態と再接続。開いたら必ず bootstrap を取り直す。 */
export function connectionStep(state: State, input: Input): Step | null {
  if (input.kind !== 'runtime') return null;
  switch (input.event.type) {
    case 'ws.open': return { state: { ...state, connection: 'connected', reconnectAttempt: 0 }, effects: [{ kind: 'api.bootstrap' }] };
    case 'ws.close': {
      const attempt = state.reconnectAttempt + 1;
      return { state: { ...state, connection: 'disconnected', reconnectAttempt: attempt }, effects: [{ kind: 'ws.reconnectAfter', ms: Math.min(1000 * 2 ** attempt, 15000) }] };
    }
    default: return null;
  }
}
