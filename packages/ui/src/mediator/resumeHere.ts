import type { Input, State, Step } from './types.ts';

/**
 * resumeHere 領域：他端末の本文を手元に降ろして再開するときの確認。
 * 引き継ぎ（session.takeover）はこのフェーズでは実装しないので、ここでは扱わない。
 *
 * この領域は overlayStep の後ろに置く。
 * 確認のダイアログを閉じるのは overlayStep の overlay.close であって、ここではない。
 * そのおかげで Esc と外側のクリックがそのまま効く。
 */
export function resumeHereStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime' && input.event.type === 'api.conflict' && input.event.kind === 'resumeHere') {
    const e = input.event;
    return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'overwriteTranscript', sessionId: e.sessionId, localSize: e.localSize, remoteSize: e.remoteSize } } }, effects: [] };
  }
  if (input.kind !== 'intent' || input.intent.type !== 'session.resumeHere') return null;
  const i = input.intent;
  const overwrite = i.overwrite === true;
  // 確認ダイアログから承諾したときだけ閉じる。ボタンから直接呼ばれたときは触らない。
  const overlay = overwrite && state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
  return { state: { ...state, overlay }, effects: [{ kind: 'api.resumeHere', sessionId: i.id, overwrite }] };
}
