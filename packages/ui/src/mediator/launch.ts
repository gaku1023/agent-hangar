import { NOT_YET, type Input, type State, type Step } from './types.ts';

/** launch 領域：起動ダイアログ、送信中、失敗。再開とフォークも同じ送信中の状態を使う。 */
export function launchStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const ev = input.event;
    if (ev.type === 'launch.done') {
      const overlay = state.overlay.kind === 'newSession' ? { kind: 'none' as const } : state.overlay;
      return { state: { ...state, launch: { kind: 'idle' }, overlay }, effects: [{ kind: 'navigate', route: { name: 'session', id: ev.sessionId } }] };
    }
    if (ev.type === 'launch.failed') {
      // 起動ダイアログが開いていれば、その中に同じ文言が出るのでトーストは重ねない。
      // 再開とフォークはダイアログを持たないので、そのときだけトーストで知らせる。
      const shown = state.overlay.kind === 'newSession';
      const next = { ...state, launch: { kind: 'failed' as const, message: ev.message } };
      return { state: next, effects: shown ? [] : [{ kind: 'toast', level: 'error', message: ev.message }] };
    }
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'session.new.open':
      if (i.scratch) return { state, effects: [{ kind: 'toast', level: 'info', message: NOT_YET }] };
      return { state: { ...state, overlay: { kind: 'newSession', projectId: i.projectId ?? null }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
    case 'session.new.submit':
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      if (!i.params.projectId) return { state: { ...state, launch: { kind: 'failed', message: 'プロジェクトを選んでください' } }, effects: [] };
      return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.launch', params: i.params }] };
    case 'overlay.close':
      // newSession のときだけ横取りする。
      // overlayStep の overlay.close はキューを進めるだけで、launch を idle に戻せない。
      if (state.overlay.kind !== 'newSession') return null;
      return { state: { ...state, overlay: { kind: 'none' }, launch: { kind: 'idle' } }, effects: [] };
    case 'session.resume': return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.resume', sessionId: i.id }] };
    case 'session.fork': return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.fork', sessionId: i.id }] };
    case 'session.kill': return { state, effects: [{ kind: 'api.killRun', runId: i.runId }] };
    case 'session.openTerminalApp': return { state, effects: [{ kind: 'api.openTerminalApp', runId: i.runId, tabId: i.tabId ?? null }] };
    case 'session.openEditor': return { state, effects: [{ kind: 'api.openEditor', sessionId: i.sessionId }] };
    case 'project.openEditor': return { state, effects: [{ kind: 'api.projectOpenEditor', projectId: i.id }] };
    case 'project.openTerminalApp': return { state, effects: [{ kind: 'api.projectOpenTerminal', projectId: i.id }] };
    default: return null;
  }
}
