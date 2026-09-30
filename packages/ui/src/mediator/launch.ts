import type { Input, State, Step } from './types.ts';

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
      // スクラッチはプロジェクトを選ばずに開く。ダイアログ側でプロジェクトの選択欄を隠す。
      return { state: { ...state, overlay: { kind: 'newSession', projectId: i.projectId ?? null, scratch: i.scratch === true }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
    case 'session.new.submit':
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      if (!i.params.projectId && !i.params.scratch) return { state: { ...state, launch: { kind: 'failed', message: 'プロジェクトを選んでください' } }, effects: [] };
      return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.launch', params: i.params }] };
    case 'overlay.close':
      // newSession のときだけ横取りする。
      // overlayStep の overlay.close はキューを進めるだけで、launch を idle に戻せない。
      if (state.overlay.kind !== 'newSession') return null;
      return { state: { ...state, overlay: { kind: 'none' }, launch: { kind: 'idle' } }, effects: [] };
    case 'session.resume': return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.resume', sessionId: i.id }] };
    case 'session.fork': return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.fork', sessionId: i.id }] };
    case 'session.attach':
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.attach', sessionId: i.id }] };
    case 'session.adopt': {
      // 外のターミナルの claude を終わらせるので、押しただけでは動かさず、先に確認を出す。
      if (!i.confirmed) return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'adoptSession', sessionId: i.id } } }, effects: [] };
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      const overlay = state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      // 元の claude が終わるのを待つので、開くまで数秒かかる。押したことが伝わるよう先に一言出す。
      return { state: { ...state, overlay, launch: { kind: 'submitting' } }, effects: [{ kind: 'toast', level: 'info', message: '引き取っています' }, { kind: 'api.adopt', sessionId: i.id }] };
    }
    case 'session.kill': {
      // サーバの停止はシェルタブを全部閉じてから tmux を落とす。
      // 作業中の Claude かシェルタブを巻き込むときだけ先に確認を出し、休みで巻き込むものが無ければすぐ止める。
      if (!i.confirmed && (i.working || i.shellTabs > 0)) {
        return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'killRun', runId: i.runId, working: i.working, shellTabs: i.shellTabs } } }, effects: [] };
      }
      const overlay = i.confirmed && state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      return { state: { ...state, overlay }, effects: [{ kind: 'api.killRun', runId: i.runId }] };
    }
    case 'session.openTerminalApp': return { state, effects: [{ kind: 'api.openTerminalApp', runId: i.runId, tabId: i.tabId ?? null }] };
    case 'session.openEditor': return { state, effects: [{ kind: 'api.openEditor', sessionId: i.sessionId }] };
    case 'project.openEditor': return { state, effects: [{ kind: 'api.projectOpenEditor', projectId: i.id }] };
    case 'project.openTerminalApp': return { state, effects: [{ kind: 'api.projectOpenTerminal', projectId: i.id }] };
    default: return null;
  }
}
