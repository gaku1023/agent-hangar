import { connectionStep } from './connection.ts';
import { overlayStep } from './overlay.ts';
import { screenStep } from './screen.ts';
import { sessionViewStep } from './sessionView.ts';
import { NOT_YET, type Effect, type Input, type State, type Step } from './types.ts';

export type { State, Input, Effect, Step } from './types.ts';
export { defaultSessionView } from './sessionView.ts';

export function initialState(): State {
  return { screen: { name: 'booting' }, overlay: { kind: 'none' }, connection: 'connecting', reconnectAttempt: 0, sessionView: {}, search: { text: '', filter: {} }, toasts: [], unresolvedQueue: [], nextToastId: 1 };
}

function pushToast(state: State, level: 'info' | 'error', message: string): State {
  return { ...state, toasts: [...state.toasts, { id: String(state.nextToastId), level, message }], nextToastId: state.nextToastId + 1 };
}

const NOT_YET_INTENTS = new Set(['session.new.open', 'session.new.submit', 'session.resume', 'session.fork', 'session.kill', 'session.openTerminalApp', 'session.openEditor', 'session.promote.open', 'session.promote.submit', 'session.takeover', 'session.setMemo', 'tab.open', 'tab.close', 'tab.select', 'split.toggle', 'transcript.toggle', 'todo.add', 'todo.toggle', 'todo.remove', 'memo.save', 'artifact.open', 'artifact.add', 'summary.regenerate', 'sync.now', 'sync.pause', 'project.new.open', 'project.new.submit', 'palette.run']);

/** 直交する領域の状態機械を順に試し、最初に応答した領域の結果を採る。残りは横断的な入力。 */
export function transition(state: State, input: Input): Step {
  for (const step of [connectionStep, screenStep, overlayStep, sessionViewStep]) {
    const r = step(state, input);
    if (r) return r;
  }
  if (input.kind === 'server') {
    if (input.event.type === 'toast') return { state: pushToast(state, input.event.level, input.event.message), effects: [] };
    return { state, effects: [] };
  }
  if (input.kind === 'runtime') {
    if (input.event.type === 'api.failed') return { state: pushToast(state, 'error', input.event.message), effects: [] };
    return { state, effects: [] };
  }
  const i = input.intent;
  switch (i.type) {
    case 'project.setStatus': return { state, effects: [{ kind: 'api.setProjectStatus', projectId: i.id, status: i.status }] };
    case 'settings.update': return { state, effects: [{ kind: 'api.updateSettings', patch: i.patch }] };
    case 'index.rebuild': return { state, effects: [{ kind: 'api.rebuildIndex' }] };
    case 'toast.dismiss': return { state: { ...state, toasts: state.toasts.filter((t) => t.id !== i.id) }, effects: [] };
    default:
      if (NOT_YET_INTENTS.has(i.type)) return { state, effects: [{ kind: 'toast', level: 'info', message: NOT_YET }] };
      return { state, effects: [] };
  }
}
