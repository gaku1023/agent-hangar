import type { Input, State, Step } from './types.ts';

/** 通知を受け取るかを残す localStorage の鍵。値は真偽値そのもの。無ければ環境ごとの既定に従う。 */
export const NOTIFY_KEY = 'notify.waiting';

/**
 * 通知の受け取りの切り替え。
 * 受け取るにするときは許可を求めるだけで、切り替えは許可の結果（notify.changed）を待つ。
 * ブラウザの許可ダイアログは利用者の操作の中でしか出せないので、この効果は押した操作のその場で走る。
 * 受け取らないにするときは、その場で切り替えて覚える。
 */
export function notifyStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime' && input.event.type === 'notify.changed') {
    const { available, on } = input.event;
    return { state: { ...state, notify: { available, on } }, effects: [] };
  }
  if (input.kind !== 'intent' || input.intent.type !== 'notify.set') return null;
  if (input.intent.on) return { state, effects: [{ kind: 'notify.request' }] };
  return { state: { ...state, notify: { ...state.notify, on: false } }, effects: [{ kind: 'storage.save', key: NOTIFY_KEY, value: false }] };
}
