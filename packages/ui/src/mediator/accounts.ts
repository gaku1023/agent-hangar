import type { Input, State, Step } from './types.ts';

/**
 * accounts 領域：Claude Code のアカウントの操作。
 * Mediator は Store を見ないので、判断に要る値（作業中か）は Intent が運ぶ。
 * 別のアカウントでの再開は起動の一種なので、送信中の状態（launch）は起動と共有する。
 * 結果（launch.done、launch.failed）は launchStep が受ける。
 */
export function accountsStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'accounts.load': return { state, effects: [{ kind: 'api.accounts.load' }] };
    case 'account.choose': return { state, effects: [{ kind: 'api.accounts.setCurrent', accountId: i.accountId }] };
    case 'account.switchSession': {
      // 動いている claude を止めて別の置き場で再開するので、押しただけでは動かさず、先に確認を出す。
      if (!i.confirmed) return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'switchAccount', sessionId: i.sessionId, accountId: i.accountId, working: i.working } } }, effects: [] };
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      const overlay = state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      return { state: { ...state, overlay, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.accounts.switchSession', sessionId: i.sessionId, accountId: i.accountId }] };
    }
    case 'account.add': {
      const name = i.name.trim();
      return { state, effects: name === '' ? [] : [{ kind: 'api.accounts.add', name }] };
    }
    case 'account.update': {
      const patch = { ...(i.name !== undefined ? { name: i.name } : {}), ...(i.color !== undefined ? { color: i.color } : {}) };
      return { state, effects: [{ kind: 'api.accounts.update', accountId: i.accountId, patch }] };
    }
    case 'account.remove': {
      if (!i.confirmed) return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'removeAccount', accountId: i.accountId } } }, effects: [] };
      const overlay = state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      return { state: { ...state, overlay }, effects: [{ kind: 'api.accounts.remove', accountId: i.accountId }] };
    }
    case 'account.login': return { state, effects: [{ kind: 'api.accounts.login', accountId: i.accountId }] };
    case 'account.login.cancel': return { state, effects: [{ kind: 'api.accounts.cancelLogin', accountId: i.accountId }] };
    case 'account.refresh': return { state, effects: [{ kind: 'api.accounts.refresh', accountId: i.accountId }] };
    default: return null;
  }
}
