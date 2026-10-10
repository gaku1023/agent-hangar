import type { Input, State, Step } from './types.ts';

/**
 * 通知を受け取るかを残す localStorage の鍵。
 * 値は真偽値そのもの。
 * 無ければ環境ごとの既定に従う。
 */
export const NOTIFY_KEY = 'notify.waiting';

/**
 * 通知の受け取りの切り替え。
 * 通知を出せるか、受け取るかは Runtime しか知らない事実なので、Store が持つ（store.ts の notify）。ここは切り替えを効果にするだけである。
 * 受け取るにするときは許可を求める。切り替わるのは、許可の結果を Runtime が Store に入れたときである。
 * ブラウザの許可ダイアログは利用者の操作の中でしか出せないので、この効果は押した操作のその場で走る。
 * 受け取らないにするときは、Runtime がその場で切り替えて覚える。
 */
export function notifyStep(state: State, input: Input): Step | null {
  if (input.kind !== 'action' || input.action.type !== 'notify.set') return null;
  return { state, effects: [{ kind: input.action.on ? 'notify.request' : 'notify.off' }] };
}
