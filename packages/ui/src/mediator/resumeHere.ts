import type { Input, State, Step } from './types.ts';

/**
 * resumeHere 領域：他端末の本文を手元に降ろして再開するときの確認。
 *
 * 押した（session.resumeHere.open）ら、確認に出すもの（前の PC とこの PC）を取りに行き、届いたら確認の 1 枚を毎回出す。
 * 確認で承諾すると session.resumeHere が来て、写して再開する。手元の方が小さいときは、さらに上書きの確認（409）が出る。
 *
 * この領域は overlayStep の後ろに置く。
 * 確認のダイアログを閉じるのは overlayStep の overlay.close であって、ここではない。
 * そのおかげで Esc と外側のクリックがそのまま効く。
 *
 * 送信中の状態は launch を共有する。
 * この操作は本文を降ろして新しい run を立てるので、再開やフォークと同じ「起動の進み」だからである。
 * 解くのも launchStep の launch.done と launch.failed に任せる。
 */
export function resumeHereStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime' && input.event.type === 'api.conflict' && input.event.kind === 'resumeHere') {
    const e = input.event;
    // 409 はその要求が終わった合図でもある。ここで送信中を解かないと、確認に答えられなくなる。
    const overlay = { kind: 'confirm' as const, confirm: { kind: 'overwriteTranscript' as const, sessionId: e.sessionId, localSize: e.localSize, remoteSize: e.remoteSize } };
    return { state: { ...state, overlay, launch: { kind: 'idle' } }, effects: [] };
  }
  if (input.kind === 'runtime' && input.event.type === 'resumeHere.plan') {
    const plan = input.event.plan;
    return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'resumeHere', sessionId: plan.sessionId, plan } } }, effects: [] };
  }
  if (input.kind === 'action' && input.action.type === 'session.resumeHere.open') {
    // 送信中は取りに行かない。確認を出しても、承諾が二重送信の歯止めで捨てられる。
    if (state.launch.kind === 'submitting') return { state, effects: [] };
    return { state, effects: [{ kind: 'api.resumeHerePlan', sessionId: input.action.id }] };
  }
  if (input.kind !== 'action' || input.action.type !== 'session.resumeHere') return null;
  const i = input.action;
  // 起動と昇格と同じ歯止め。二重に走らせると run が 2 つできる。
  if (state.launch.kind === 'submitting') return { state, effects: [] };
  const overwrite = i.overwrite === true;
  // 確認ダイアログから承諾したときだけ閉じる。ボタンから直接呼ばれたときは触らない。
  // 確認の 1 枚（resumeHere）からの承諾は上書きを伴わないので、その確認が出ているときも閉じる。
  const fromConfirm = state.overlay.kind === 'confirm' && (overwrite || (state.overlay.confirm.kind === 'resumeHere' && state.overlay.confirm.sessionId === i.id));
  const overlay = fromConfirm ? { kind: 'none' as const } : state.overlay;
  return { state: { ...state, overlay, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.resumeHere', sessionId: i.id, overwrite }] };
}
