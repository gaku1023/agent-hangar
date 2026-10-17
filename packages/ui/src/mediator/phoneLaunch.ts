import type { Store } from '../store/store.ts';
import { launchStep } from './launch.ts';
import { screenStep } from './screen.ts';
import type { Input, State, Step } from './types.ts';

/**
 * phoneLaunch 領域：スマホからの依頼でこの PC が会話を起こした右下の通知（試作 F1）。
 * サーバーの phone.launch を受信順に覚え、同じ会話は 1 枚にまとめる（後から受信したもので置き換える）。
 * 「開く」はその会話を開き、「停止」はその run を止める流れ（session.kill、作業中なら確認を出す）に渡す。どちらも通知を下げる。
 * 「閉じる」は通常の通知の時間切れで、通知だけを下げる。Bypass permissions の通知は画面が時間では閉じない。
 * 開けなかった（入力のあるダイアログが開いていて画面を移せない）ときは、通知を残す。
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
      const next = without(i.sessionId);
      const r = launchStep(next, store, { kind: 'action', action: { type: 'session.kill', ...i.stop } });
      return r ?? { state: next, effects: [] };
    }
    default: return null;
  }
}
