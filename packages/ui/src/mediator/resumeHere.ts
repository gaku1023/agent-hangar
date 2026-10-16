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
  const takeoverStep = takeoverOf(state, input);
  if (takeoverStep) return takeoverStep;
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

/**
 * ほかの PC で動いている会話を、停止を頼んでから引き継ぐ流れ。
 *
 * 確認の 1 枚（resumeHere）で承諾すると、同じ 1 枚が進み具合（takeover）に変わり、頼みを送る。
 * 段の変化は takeover.update のサーバの知らせで届く（頼みの応答も Runtime が同じ道で流す）。
 * ready なら閉じて今の再開に入る。timeout なら同じ 1 枚が警告に変わり、取り消す、もう少し待つ、このまま引き継ぐ（force）を選ばせる。
 *
 * 閉じるのは取り消し（session.takeover.cancel）だけにする。overlay.close で閉じるとサーバに待ちが残る。
 * 1 枚の Esc と外側のクリックは、View が overlay.close の代わりに cancel を送る。
 * 再開が通ったあとに取り下げは送らない。サーバの cancel は force の頼みも取り下げるからである。
 */
function takeoverOf(state: State, input: Input): Step | null {
  const o = state.overlay;
  const shown = o.kind === 'confirm' && o.confirm.kind === 'takeover' ? o.confirm : null;
  if (input.kind === 'server' && input.event.type === 'takeover.update') {
    const dto = input.event.takeover;
    // 出ている 1 枚の会話の知らせだけを受ける。ほかの会話と、閉じた後と、頼む前の知らせは捨てる。
    if (!shown || shown.sessionId !== dto.sessionId) return null;
    if (dto.stage === 'cancelled') return { state: { ...state, overlay: { kind: 'none' } }, effects: [] };
    if (dto.stage === 'ready') {
      return { state: { ...state, overlay: { kind: 'none' }, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.resumeHere', sessionId: dto.sessionId, overwrite: shown.plan.replace !== null }] };
    }
    return { state: { ...state, overlay: { kind: 'confirm', confirm: { ...shown, takeover: dto } } }, effects: [] };
  }
  if (input.kind !== 'action') return null;
  const a = input.action;
  if (a.type === 'session.takeover.start') {
    const effects: Step['effects'] = [{ kind: 'api.takeoverStart', sessionId: a.id, force: a.force }];
    if (o.kind === 'confirm' && o.confirm.kind === 'resumeHere' && o.confirm.sessionId === a.id) {
      return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'takeover', sessionId: a.id, plan: o.confirm.plan, takeover: null } } }, effects };
    }
    // 返事がない 1 枚の「このまま引き継ぐ」。1 枚はそのまま、force の頼みを送る。
    if (shown && shown.sessionId === a.id) return { state, effects };
    // 出ている 1 枚が無ければ、待ちを見せる先が無い。頼みを送らない。
    return { state, effects: [] };
  }
  if (a.type === 'session.takeover.cancel') {
    const mine = shown !== null && shown.sessionId === a.id;
    return { state: mine ? { ...state, overlay: { kind: 'none' } } : state, effects: [{ kind: 'api.takeoverCancel', sessionId: a.id }] };
  }
  if (a.type === 'session.takeover.extend') return { state, effects: [{ kind: 'api.takeoverExtend', sessionId: a.id }] };
  return null;
}
