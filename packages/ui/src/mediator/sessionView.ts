import type { Effect, Input, SessionViewState, State, Step } from './types.ts';

export function defaultSessionView(): SessionViewState {
  return { agentId: null, showThinking: false, showRaw: false, follow: true, summaryOpen: false };
}

function patch(state: State, id: string, p: Partial<SessionViewState>): Step {
  const cur = state.sessionView[id] ?? defaultSessionView();
  const next = { ...cur, ...p };
  const effects: Effect[] = [{ kind: 'storage.save', key: `sv:${id}`, value: next }];
  return { state: { ...state, sessionView: { ...state.sessionView, [id]: next } }, effects };
}

/** sessionView 領域：セッション画面の一時状態。localStorage に保存し、同期しない。 */
export function sessionViewStep(state: State, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'transcript.appended') {
    const open = state.screen.name === 'session' && state.screen.id === input.event.sessionId;
    return { state, effects: open ? [{ kind: 'api.loadEvents', sessionId: input.event.sessionId, fromSeq: -1 }] : [] };
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'transcript.showThinking': return patch(state, i.sessionId, { showThinking: i.show });
    case 'transcript.showRaw': return patch(state, i.sessionId, { showRaw: i.show });
    case 'transcript.follow': return patch(state, i.sessionId, { follow: i.follow });
    case 'summary.toggle': return patch(state, i.sessionId, { summaryOpen: !(state.sessionView[i.sessionId] ?? defaultSessionView()).summaryOpen });
    case 'transcript.loadMore': return { state, effects: [{ kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: -1 }] };
    default: return null;
  }
}
