import { overlayReplaceable } from './overlay.ts';
import type { Input, ModelMissing, State, Step } from './types.ts';

/**
 * modelMissing 領域：起動した後に、この PC のサーバーに無いモデルで opencode が断られた右下の札（docs/design.md「起動前の準備」）。
 * サーバの opencode.modelMissing（会話の id と、文から取れたモデルの名前）を受けて 1 枚出し、同じ会話の札は 1 枚にまとめる（古いものが先）。
 * 「別のモデルでやり直す」は札を下げ、その会話のプロジェクト（無ければクイックセッション）で、エージェントを opencode にしてモデルの小窓を開いた新しいセッションのダイアログを開く。
 * 確認や入力のあるダイアログが出ているときは差し替えず、札も残す。「閉じる」はその会話の札だけを下げる。
 */
export function modelMissingStep(state: State, input: Input): Step | null {
  const set = (modelMissings: ModelMissing[]): Step => ({ state: { ...state, modelMissings }, effects: [] });
  if (input.kind === 'server' && input.event.type === 'opencode.modelMissing') {
    const { sessionId, model } = input.event;
    const have = state.modelMissings.find((c) => c.sessionId === sessionId);
    return set(have ? state.modelMissings.map((c) => (c.sessionId === sessionId ? { sessionId, model } : c)) : [...state.modelMissings, { sessionId, model }]);
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'launchPrep.missing.dismiss': return set(state.modelMissings.filter((c) => c.sessionId !== i.sessionId));
    case 'launchPrep.missing.retry': {
      if (!overlayReplaceable(state.overlay)) return { state, effects: [] };
      return {
        state: { ...state, modelMissings: state.modelMissings.filter((c) => c.sessionId !== i.sessionId), overlay: { kind: 'newSession', projectId: i.projectId, scratch: i.projectId === null, agent: 'opencode', pickModel: true }, launch: { kind: 'idle' } },
        effects: [{ kind: 'focus', target: 'newSessionName' }],
      };
    }
    default: return null;
  }
}
