import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import { overlayReplaceable } from './overlay.ts';
import type { Input, State, Step } from './types.ts';

/**
 * projectCreate 領域：プロジェクト画面の作成のダイアログ。
 * 2 つのダイアログが共有する未登録の一覧と Finder の結果は、取った値なので Store が持つ。
 * 作成で終えたらそのプロジェクトの画面へ移り、作成して始めるなら新しいセッションのダイアログを開く。
 */
export function projectCreateStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type !== 'project.create.done' && e.type !== 'project.create.failed') return null;
    // 送信中でなければ（送った直後に閉じた）、結果で画面を動かさない。ただし黙って捨てない。
    if (state.projectCreate.kind !== 'submitting') {
      return { state, effects: [e.type === 'project.create.failed' ? { kind: 'toast', level: 'error', message: e.message } : { kind: 'toast', level: 'info', message: translatorOf(store)('mediator.projectCreate.created') }] };
    }
    if (e.type === 'project.create.failed') return { state: { ...state, projectCreate: { kind: 'failed', message: e.message } }, effects: [] };
    const done = { ...state, projectCreate: { kind: 'idle' as const } };
    if (e.startSession) return { state: { ...done, overlay: { kind: 'newSession', projectId: e.projectId, scratch: false }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
    return { state: { ...done, overlay: { kind: 'none' } }, effects: [{ kind: 'navigate', route: { name: 'project', id: e.projectId } }] };
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'project.new.open':
      // 確認や入力のあるダイアログが出ていれば、差し替えない（overlay.ts の overlayReplaceable）。
      if (!overlayReplaceable(state.overlay)) return { state, effects: [] };
      return { state: { ...state, overlay: { kind: 'newProject' }, projectCreate: { kind: 'idle' } }, effects: [] };
    case 'project.new.submit':
      if (state.projectCreate.kind === 'submitting') return { state, effects: [] };
      return { state: { ...state, projectCreate: { kind: 'submitting' } }, effects: [{ kind: 'api.createProject', place: i.place, startSession: i.startSession }] };
    case 'folder.pick': return { state, effects: [{ kind: 'desktop.pickFolder' }] };
    case 'overlay.close':
      // overlayStep のキュー処理より先に横取りして、作成の状態も idle に戻す。
      if (state.overlay.kind !== 'newProject') return null;
      return { state: { ...state, overlay: { kind: 'none' }, projectCreate: { kind: 'idle' } }, effects: [] };
    default: return null;
  }
}
