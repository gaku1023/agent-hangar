import { overlayReplaceable } from './overlay.ts';
import type { Input, State, Step } from './types.ts';

/**
 * accounts 領域：Claude Code のアカウントの操作。
 * Mediator は Store を見ないので、判断に要る値（作業中か）は UiAction が運ぶ。
 * 別のアカウントでの再開は起動の一種なので、送信中の状態（launch）は起動と共有する。
 * 結果（launch.done、launch.failed）は launchStep が受ける。
 * アカウントを足すダイアログの送信は accountAdd が持ち、結果（account.add.done、account.add.failed）はここで受ける。
 */
export function accountsStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type !== 'account.add.done' && e.type !== 'account.add.failed') return null;
    // 送った後にダイアログを閉じていれば、失敗だけをトーストで知らせる（黙って捨てない）。通ったものは一覧に出るので知らせない。
    if (state.accountAdd.kind !== 'submitting' || state.overlay.kind !== 'addAccount') {
      return { state: { ...state, accountAdd: { kind: 'idle' } }, effects: e.type === 'account.add.failed' ? [{ kind: 'toast', level: 'error', message: e.message }] : [] };
    }
    if (e.type === 'account.add.failed') return { state: { ...state, accountAdd: { kind: 'failed', message: e.message } }, effects: [] };
    return { state: { ...state, overlay: { kind: 'none' }, accountAdd: { kind: 'idle' } }, effects: [] };
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'account.switchSession': {
      // 動いている claude を止めて別の置き場で再開するので、押しただけでは動かさず、先に確認を出す。
      if (!i.confirmed) return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'switchAccount', sessionId: i.sessionId, accountId: i.accountId, working: i.working } } }, effects: [] };
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      const overlay = state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      return { state: { ...state, overlay, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.accounts.switchSession', sessionId: i.sessionId, accountId: i.accountId }] };
    }
    case 'account.add.open':
      // 確認や入力のあるダイアログが出ていれば、差し替えない（overlay.ts の overlayReplaceable）。
      if (!overlayReplaceable(state.overlay)) return { state, effects: [] };
      return { state: { ...state, overlay: { kind: 'addAccount' }, accountAdd: { kind: 'idle' } }, effects: [] };
    case 'account.add': {
      const name = i.name.trim();
      if (name === '' || state.accountAdd.kind === 'submitting') return { state, effects: [] };
      const dir = i.dir.trim();
      return { state: { ...state, accountAdd: { kind: 'submitting' } }, effects: [{ kind: 'api.accounts.add', name, dir: dir === '' ? null : dir }] };
    }
    case 'account.add.pick': return { state, effects: [{ kind: 'desktop.pickFolder', defaultPath: i.defaultPath }] };
    case 'overlay.close':
      // overlayStep より先に横取りして、送信の状態も idle に戻す。
      if (state.overlay.kind !== 'addAccount') return null;
      return { state: { ...state, overlay: { kind: 'none' }, accountAdd: { kind: 'idle' } }, effects: [] };
    case 'account.remove': {
      if (!i.confirmed) return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'removeAccount', accountId: i.accountId } } }, effects: [] };
      const overlay = state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      return { state: { ...state, overlay }, effects: [{ kind: 'api.accounts.remove', accountId: i.accountId }] };
    }
    default: return null;
  }
}
