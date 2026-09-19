import type { SyncStatusDto } from '@agent-hangar/shared';
import type { Input, State, Step, SyncState } from './types.ts';

/** サーバの同期状態を、UI が描く形に写す。 */
export function toSyncState(s: SyncStatusDto): SyncState {
  switch (s.state) {
    case 'off': return { kind: 'off' };
    case 'pushing': return { kind: 'pushing' };
    case 'pulling': return { kind: 'pulling' };
    case 'paused': return { kind: 'paused' };
    case 'error': return { kind: 'error', message: s.error ?? '同期に失敗しました' };
    case 'idle': return { kind: 'idle', lastAt: s.lastPullAt ?? s.lastPushAt };
  }
}

/** sync 領域：同期の状態表示と、今すぐ同期、一時停止、設定の取り込み。 */
export function syncStep(state: State, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'sync.status') {
    const status = input.event.status;
    return { state: { ...state, sync: toSyncState(status), pending: status.pending }, effects: [] };
  }
  // 窓が前面に戻った瞬間に取りに行く。寝ている間は同期を止めているので、ここが復帰の合図になる。
  if (input.kind === 'runtime' && input.event.type === 'window.focus') return { state, effects: [{ kind: 'api.syncFocus' }] };
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'sync.now': return { state, effects: [{ kind: 'api.syncNow' }] };
    case 'sync.pause': return { state, effects: [{ kind: 'api.syncPause', paused: i.paused }] };
    case 'sync.joinToken.show': return { state, effects: [{ kind: 'api.joinToken' }] };
    case 'sync.config.preview': return { state: { ...state, overlay: { kind: 'configPreview' } }, effects: [{ kind: 'api.configPreview' }] };
    case 'sync.config.apply': return { state: { ...state, overlay: { kind: 'none' } }, effects: [{ kind: 'api.configPull' }] };
    default: return null;
  }
}
