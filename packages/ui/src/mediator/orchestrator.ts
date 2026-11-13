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
    case 'orchestrator.send': return { state, effects: [{ kind: 'orchestrator', command: { op: 'send', text: a.text } }] };
    default: return null;
  }
}
