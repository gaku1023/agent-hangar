import type { Input, State, Step } from './types.ts';

function popQueue(state: State): State {
  const [next, ...rest] = state.unresolvedQueue;
  return next ? { ...state, overlay: { kind: 'resolveProject', projectId: next }, unresolvedQueue: rest } : { ...state, overlay: { kind: 'none' }, unresolvedQueue: [] };
}

/** 未解決のプロジェクトを 1 つ出す。既に何か出ていればキューに積む。 */
function openResolve(state: State, id: string): Step {
  if (state.overlay.kind === 'resolveProject' && state.overlay.projectId === id) return { state, effects: [] };
  if (state.unresolvedQueue.includes(id)) return { state, effects: [] };
  if (state.overlay.kind === 'none') return { state: { ...state, overlay: { kind: 'resolveProject', projectId: id } }, effects: [] };
  return { state: { ...state, unresolvedQueue: [...state.unresolvedQueue, id] }, effects: [] };
}

/** overlay 領域：ダイアログとパレット。未解決プロジェクトは一つずつ出す。 */
export function overlayStep(state: State, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'project.unresolved') return openResolve(state, input.event.projectId);
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'project.resolve.open': return openResolve(state, i.id);
    case 'project.resolve': return { state: popQueue(state), effects: [{ kind: 'api.resolveProject', projectId: i.id, action: i.action }] };
    case 'overlay.close': return { state: popQueue(state), effects: [] };
    case 'palette.open': return { state: { ...state, overlay: { kind: 'palette' } }, effects: [] };
    case 'palette.close': return { state: { ...state, overlay: { kind: 'none' } }, effects: [] };
    default: return null;
  }
}
