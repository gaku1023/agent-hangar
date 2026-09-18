import type { Input, State, Step } from './types.ts';

function nameError(name: string): string | null {
  const t = name.trim();
  if (!t) return '名前を入力してください';
  if (t.includes('/')) return '名前に / は使えません';
  return null;
}

/** promote 領域：スクラッチのセッションをプロジェクトへ昇格するダイアログ。 */
export function promoteStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type === 'promote.done') return { state: { ...state, overlay: { kind: 'promoted', projectId: e.projectId, moved: e.moved, reason: e.reason }, promote: { kind: 'idle' } }, effects: [] };
    if (e.type === 'promote.failed') return { state: { ...state, promote: { kind: 'failed', message: e.message } }, effects: [{ kind: 'toast', level: 'error', message: e.message }] };
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  if (i.type === 'session.promote.open') return { state: { ...state, overlay: { kind: 'promote', sessionId: i.id }, promote: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'promoteName' }] };
  if (i.type === 'session.promote.submit') {
    // 送信中の二重送信は捨てる。
    if (state.promote.kind === 'submitting') return { state, effects: [] };
    const err = nameError(i.name);
    if (err) return { state: { ...state, promote: { kind: 'failed', message: err } }, effects: [] };
    return { state: { ...state, promote: { kind: 'submitting' } }, effects: [{ kind: 'api.promote', sessionId: i.id, name: i.name.trim(), gitInit: i.gitInit, moveFiles: i.moveFiles }] };
  }
  // overlayStep のキュー処理より先に横取りして、昇格の状態も idle に戻す。
  if (i.type === 'overlay.close' && (state.overlay.kind === 'promote' || state.overlay.kind === 'promoted')) {
    return { state: { ...state, overlay: { kind: 'none' }, promote: { kind: 'idle' } }, effects: [] };
  }
  return null;
}
