import type { PaletteCommand } from '@agent-hangar/shared';
import type { Input, State, Step } from './types.ts';

/** `cmd:new-session` のような項目 ID を種類と残りに割る。 */
function splitId(id: string): [string, string] {
  const at = id.indexOf(':');
  return at < 0 ? [id, ''] : [id.slice(0, at), id.slice(at + 1)];
}

function paletteRun(state: State, command: PaletteCommand): Step {
  const closed: State = { ...state, overlay: { kind: 'none' } };
  const [kind, rest] = splitId(command.id);
  if (kind === 'project') return { state: closed, effects: [{ kind: 'navigate', route: { name: 'project', id: rest } }] };
  if (kind === 'session') return { state: closed, effects: [{ kind: 'navigate', route: { name: 'session', id: rest } }] };
  if (kind === 'cmd') {
    switch (rest) {
      case 'new-session': return { state: { ...closed, overlay: { kind: 'newSession', projectId: null, scratch: false }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
      case 'new-scratch': return { state: { ...closed, overlay: { kind: 'newSession', projectId: null, scratch: true }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
      case 'settings': return { state: closed, effects: [{ kind: 'navigate', route: { name: 'settings' } }] };
      case 'rebuild-index': return { state: closed, effects: [{ kind: 'api.rebuildIndex' }] };
    }
  }
  return { state: closed, effects: [] };
}

/** workbench 領域：TODO、メモ、アーティファクト、事後要約、パレットの実行。状態はほとんど持たない。 */
export function workbenchStep(state: State, input: Input): Step | null {
  if (input.kind === 'server') {
    const e = input.event;
    if (e.type === 'summary.failed') return { state: { ...state, summaryFailed: { ...state.summaryFailed, [e.sessionId]: e.message } }, effects: [] };
    if (e.type === 'summary.pending' || e.type === 'summary.updated') {
      if (!state.summaryFailed[e.sessionId]) return { state, effects: [] };
      const { [e.sessionId]: _drop, ...rest } = state.summaryFailed;
      return { state: { ...state, summaryFailed: rest }, effects: [] };
    }
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    // 追加した後も入力欄に居座らせて、続けて書けるようにする。
    case 'todo.add': return i.text.trim() ? { state, effects: [{ kind: 'api.addTodo', projectId: i.projectId, text: i.text.trim() }, { kind: 'focus', target: 'todoInput' }] } : { state, effects: [] };
    case 'todo.toggle': return { state, effects: [{ kind: 'api.toggleTodo', id: i.id }] };
    case 'todo.remove': return { state, effects: [{ kind: 'api.removeTodo', id: i.id }] };
    case 'memo.save': return { state, effects: [{ kind: 'api.saveMemo', projectId: i.projectId, markdown: i.markdown }] };
    case 'session.setMemo': return { state, effects: [{ kind: 'api.setSessionMemo', sessionId: i.id, text: i.text }] };
    case 'artifact.open': return { state, effects: [{ kind: 'api.openArtifact', id: i.id }] };
    case 'artifact.openEditor': return { state, effects: [{ kind: 'api.openArtifactEditor', id: i.id }] };
    case 'artifact.add': return i.url.trim() ? { state, effects: [{ kind: 'api.addArtifact', projectId: i.projectId, url: i.url.trim() }] } : { state, effects: [] };
    case 'summary.regenerate': return { state, effects: [{ kind: 'api.regenerateSummary', sessionId: i.sessionId }] };
    case 'summarizer.test': return { state, effects: [{ kind: 'api.testSummarizer' }] };
    // 幅の変更は SplitPane の IntentBoundary が処理する。ここへ来るのは境界の外で発行されたときだけで、無視してよい。
    case 'split.resize': return { state, effects: [] };
    case 'palette.run': return paletteRun(state, i.command);
    default: return null;
  }
}
