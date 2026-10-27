import type { Input, State, Step } from './types.ts';

/**
 * setup 領域：連携の書き込み（MCP の登録と解除、シェル連携、ステータスライン）のボタン。
 * 押されたら殻に頼む（desktop.setup）。殻が見立てを承認の窓に見せ、承認されたときだけ CLI が書く（全体計画の D9）。
 * この領域は、返事を待っている対象を 1 つ覚え、そのあいだ重ねて頼まないことだけを持つ。結果の知らせと取り直しは Runtime が行う。
 */
export function setupStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime') {
    if (input.event.type !== 'setup.done') return null;
    return { state: { ...state, setupRunning: null }, effects: [] };
  }
  if (input.kind !== 'action' || input.action.type !== 'setup.run') return null;
  if (state.setupRunning !== null) return { state, effects: [] };
  return { state: { ...state, setupRunning: input.action.target }, effects: [{ kind: 'desktop.setup', target: input.action.target }] };
}
