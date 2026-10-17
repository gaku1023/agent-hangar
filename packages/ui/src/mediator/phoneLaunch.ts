import type { Store } from '../store/store.ts';
import { launchStep } from './launch.ts';
import { screenStep } from './screen.ts';
import type { Effect, Input, State, Step } from './types.ts';

/**
 * phoneLaunch 領域：スマホからの依頼でこの PC が会話を起こした右下の通知（試作 F1）。
 * サーバーの phone.launch を受信順に覚え、同じ会話は 1 枚にまとめる（後から受信したもので置き換える）。
 * 「開く」はその会話を開いて通知を下げる。開けなかった（入力のあるダイアログが開いていて画面を移せない）ときは、通知を残す。
 * 「停止」はその run を止める流れ（session.kill、作業中なら確認を出す）に渡す。
 * 通知を下げるのは停止を実際に送ったときで、確認をキャンセルしたら通知は残る（settlePhoneLaunches）。
 * 「閉じる」は通知だけを下げる。通常の通知は時間切れで、Bypass permissions の通知は見出しの閉じるボタンで送る。
 */
export function phoneLaunchStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'phone.launch') {
    const l = input.event.launch;
    return { state: { ...state, phoneLaunches: [...state.phoneLaunches.filter((x) => x.sessionId !== l.sessionId), l] }, effects: [] };
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  const without = (id: string): State => ({ ...state, phoneLaunches: state.phoneLaunches.filter((x) => x.sessionId !== id) });
  switch (i.type) {
    case 'phoneLaunch.dismiss': return { state: without(i.sessionId), effects: [] };
    case 'phoneLaunch.open': {
      const moved = screenStep(state, store, { kind: 'action', action: { type: 'session.open', id: i.sessionId } });
      if (!moved || moved.effects.length === 0) return { state, effects: [] };
      return { state: { ...moved.state, phoneLaunches: without(i.sessionId).phoneLaunches }, effects: moved.effects };
    }
    case 'phoneLaunch.stop': {
      const r = launchStep(state, store, { kind: 'action', action: { type: 'session.kill', ...i.stop } }) ?? { state, effects: [] };
      const sent = r.effects.some((e) => e.kind === 'api.killRun');
      return sent ? { ...r, state: { ...r.state, phoneLaunches: r.state.phoneLaunches.filter((x) => x.sessionId !== i.sessionId) } } : r;
    }
    default: return null;
  }
}

/**
 * どの入力の後にも合わせる、スマホから起動した会話の通知の整え。
 * その会話の画面を開いた（開き方を問わない）ら、見えているので下げ、離れた後も再び出さない。
 * その会話の run へ停止を送った（通知の「停止」の確認を経たものも、セッションのメニューからのものも）ら下げる。
 */
export function settlePhoneLaunches(state: State, store: Store, effects: readonly Effect[]): State {
  if (state.phoneLaunches.length === 0) return state;
  const drop = new Set<string>();
  if (state.screen.name === 'session') drop.add(state.screen.id);
  for (const e of effects) {
    if (e.kind !== 'api.killRun') continue;
    const sid = store.runs[e.runId]?.sessionId;
    if (sid) drop.add(sid);
  }
  if (!state.phoneLaunches.some((l) => drop.has(l.sessionId))) return state;
  return { ...state, phoneLaunches: state.phoneLaunches.filter((l) => !drop.has(l.sessionId)) };
}
