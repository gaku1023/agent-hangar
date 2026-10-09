import type { Input, State, Step } from './types.ts';

/**
 * sync 領域：前面化の合図、参加トークン、設定の下見と取り込み。
 * 同期の状態と未送信の数は Store だけが持つ（Store の sync）。ここでは写しを持たない。
 * 今すぐ同期と一時停止は、応答を Store に当てるだけなので表で引く（runtime/intentTable.ts）。
 */
export function syncStep(state: State, input: Input): Step | null {
  // 窓が前面に戻った瞬間に取りに行く。寝ている間は同期を止めているので、ここが復帰の合図になる。
  if (input.kind === 'runtime' && input.event.type === 'window.focus') return { state, effects: [{ kind: 'api.syncFocus' }] };
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'sync.joinToken.show': return { state, effects: [{ kind: 'api.joinToken' }] };
    case 'sync.config.preview': return { state: { ...state, overlay: { kind: 'configPreview' } }, effects: [{ kind: 'api.configPreview' }] };
    case 'sync.config.apply': return { state: { ...state, overlay: { kind: 'none' } }, effects: [{ kind: 'api.configPull' }] };
    default: return null;
  }
}
