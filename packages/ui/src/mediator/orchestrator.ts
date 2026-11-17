import type { Input, State, Step } from './types.ts';

/**
 * 統括の柱の操作（docs/design.md「統括」）。
 * 会話と記録は Runtime が読む事実なので Store が持つ（store/orchestrator.ts）。ここは画面の操作を効果にするだけで、State は変えない。
 */
export function orchestratorStep(state: State, input: Input): Step | null {
  if (input.kind !== 'action') return null;
  const a = input.action;
  switch (a.type) {
    case 'orchestrator.open': return { state, effects: [{ kind: 'orchestrator', command: { op: 'load' } }] };
    case 'orchestrator.pillar': {
      // 柱の開閉が変わったら、その場だけ開いていた右の欄（tocPeek）を戻す。開いた直後は畳んだ形から、閉じた後は保存した開閉から始める。
      const peeking = state.panes.tocPeek.length > 0 || Object.values(state.sessionView).some((v) => v.tocPeek);
      if (state.orchestratorOpen === a.open && !peeking) return { state, effects: [] };
      const sessionView = Object.fromEntries(Object.entries(state.sessionView).map(([id, v]) => [id, v.tocPeek ? { ...v, tocPeek: false } : v]));
      return { state: { ...state, orchestratorOpen: a.open, sessionView, panes: { ...state.panes, tocPeek: [] } }, effects: [] };
    }
    case 'orchestrator.send': return { state, effects: [{ kind: 'orchestrator', command: { op: 'send', text: a.text, ...(a.origin !== undefined ? { origin: a.origin } : {}) } }] };
    default: return null;
  }
}
