import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import type { Effect, Input, State, Step } from './types.ts';

/** connection 領域：WebSocket の状態と再接続。開いたら必ず bootstrap を取り直す。 */
export function connectionStep(state: State, store: Store, input: Input): Step | null {
  // 待ち時間を飛ばして今すぐ試す。自動の再接続とは別に、人が押せる道を残す。
  if (input.kind === 'action') return input.action.type === 'conn.retry' ? { state, effects: [{ kind: 'ws.connect' }] } : null;
  if (input.kind !== 'runtime') return null;
  switch (input.event.type) {
    case 'ws.open': {
      const effects: Effect[] = [{ kind: 'api.bootstrap' }];
      // 一度も切れていない最初の接続は「追いついた」ではないので黙る。
      if (state.reconnectAttempt > 0) effects.push({ kind: 'toast', level: 'info', message: translatorOf(store)('mediator.connection.caughtUp') });
      return { state: { ...state, connection: 'connected', reconnectAttempt: 0, staleSince: null, nextRetryAt: null }, effects };
    }
    case 'ws.close': {
      const attempt = state.reconnectAttempt + 1;
      const ms = Math.min(1000 * 2 ** attempt, 15000);
      const at = input.event.at;
      return {
        // 再接続に失敗しても staleSince は動かさない。古さは切れた最初の瞬間から数える。
        state: { ...state, connection: 'disconnected', reconnectAttempt: attempt, staleSince: state.staleSince ?? at, nextRetryAt: at + ms },
        effects: [{ kind: 'ws.reconnectAfter', ms }],
      };
    }
    default: return null;
  }
}
