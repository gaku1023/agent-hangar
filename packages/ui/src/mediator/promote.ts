import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import type { Translate } from '@agent-hangar/shared';
import type { Effect, Input, State, Step } from './types.ts';

function nameError(name: string, t: Translate): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t('mediator.promote.nameRequired');
  // サーバの checkDirName と同じく、どちらの OS の区切りも名前に入れさせない。
  if (trimmed.includes('/') || trimmed.includes('\\')) return t('mediator.promote.nameSlash');
  return null;
}

/** promote 領域：スクラッチのセッションをプロジェクトへ昇格するダイアログ。 */
export function promoteStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type !== 'promote.done' && e.type !== 'promote.failed') return null;
    // 送信中でなければ、遅れて届いた結果で状態を書き換えない。
    // ただし黙って捨てない。送信の直後に閉じた利用者にも、結果はトーストで届く。
    if (state.promote.kind !== 'submitting') {
      const toast: Effect = e.type === 'promote.failed'
        ? { kind: 'toast', level: 'error', message: e.message }
        : { kind: 'toast', level: 'info', message: translatorOf(store)('mediator.promote.promoted') };
      return { state, effects: [toast] };
    }
    if (e.type === 'promote.done') return { state: { ...state, overlay: { kind: 'promoted', projectId: e.projectId, moved: e.moved, reason: e.reason }, promote: { kind: 'idle' } }, effects: [] };
    if (e.type === 'promote.failed') return { state: { ...state, promote: { kind: 'failed', message: e.message } }, effects: [{ kind: 'toast', level: 'error', message: e.message }] };
    return null;
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  if (i.type === 'session.promote.open') return { state: { ...state, overlay: { kind: 'promote', sessionId: i.id }, promote: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'promoteName' }] };
  if (i.type === 'session.promote.submit') {
    // 送信中の二重送信は捨てる。
    if (state.promote.kind === 'submitting') return { state, effects: [] };
    const err = nameError(i.name, translatorOf(store));
    if (err) return { state: { ...state, promote: { kind: 'failed', message: err } }, effects: [] };
    return { state: { ...state, promote: { kind: 'submitting' } }, effects: [{ kind: 'api.promote', sessionId: i.id, name: i.name.trim(), gitInit: i.gitInit, moveFiles: i.moveFiles }] };
  }
  // overlayStep のキュー処理より先に横取りして、昇格の状態も idle に戻す。
  if (i.type === 'overlay.close' && (state.overlay.kind === 'promote' || state.overlay.kind === 'promoted')) {
    return { state: { ...state, overlay: { kind: 'none' }, promote: { kind: 'idle' } }, effects: [] };
  }
  return null;
}
