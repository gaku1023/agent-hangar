import type { Input, State, Step } from './types.ts';

/**
 * resumeHere 領域：他端末の本文を手元に降ろして再開するときの確認。
 * 引き継ぎ（session.takeover）はこのフェーズでは実装しないので、ここでは扱わない。
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
    // 409 は非同期に降ってくるので、利用者が見ている未解決プロジェクトのダイアログを奪うことがある。
    // 奪うぶんはキューの先頭に戻す。戻さないと、再接続するまで二度と聞かれない。
    const open = state.overlay.kind === 'resolveProject' ? state.overlay.projectId : null;
    const unresolvedQueue = open !== null && !state.unresolvedQueue.includes(open) ? [open, ...state.unresolvedQueue] : state.unresolvedQueue;
    // 409 はその要求が終わった合図でもある。ここで送信中を解かないと、確認に答えられなくなる。
    const overlay = { kind: 'confirm' as const, confirm: { kind: 'overwriteTranscript' as const, sessionId: e.sessionId, localSize: e.localSize, remoteSize: e.remoteSize } };
    return { state: { ...state, overlay, unresolvedQueue, launch: { kind: 'idle' } }, effects: [] };
  }
  if (input.kind !== 'intent' || input.intent.type !== 'session.resumeHere') return null;
  const i = input.intent;
  // 起動と昇格と同じ歯止め。二重に走らせると run が 2 つできる。
  if (state.launch.kind === 'submitting') return { state, effects: [] };
  const overwrite = i.overwrite === true;
  // 確認ダイアログから承諾したときだけ閉じる。ボタンから直接呼ばれたときは触らない。
  const overlay = overwrite && state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
  return { state: { ...state, overlay, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.resumeHere', sessionId: i.id, overwrite }] };
}
