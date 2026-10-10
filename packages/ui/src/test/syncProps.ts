import type { SyncProps } from '../presenters/shell.ts';

/** ヘッダーの同期の一行の props。試験が要る所だけ上書きする。既定は「同期 1 分前」で、件数は無い。 */
export function syncFixture(over: Partial<SyncProps> = {}): SyncProps {
  const label = over.label ?? '同期 1 分前';
  const counts = [over.pending, over.sweepPending, over.skipped].filter((c): c is string => typeof c === 'string');
  return { visible: true, state: 'idle', label, title: `${[label, ...counts].join('、')}（押すと同期の設定を開く）`, pending: null, sweepPending: null, skipped: null, reason: null, once: false, ...over };
}
