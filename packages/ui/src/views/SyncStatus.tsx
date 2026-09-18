import { useEmit } from '../intent/chain.tsx';
import type { SyncProps } from '../presenters/shell.ts';

/**
 * ヘッダーの同期の一行。
 * props だけで描き、状態を持たない。文言はすべて presenter が組み立てている。
 * 同期を設定していない端末では presenter が visible を false にするので、丸ごと描かない。
 */
export function SyncStatus(props: SyncProps) {
  const emit = useEmit();
  if (!props.visible) return null;
  return (
    <span className="sync" data-state={props.state}>
      <span className={props.state === 'error' ? 'mono sync-error' : 'mono faint'}>{props.label}</span>
      {/* 0 件のときに「未送信 0」と出すと、止まっているように見える。溜まっているときだけ出す。 */}
      {props.pending > 0 && <span className="faint">未送信 {props.pending}</span>}
      <button className="btn btn-sm" onClick={() => emit({ type: 'sync.now' })}>今すぐ同期</button>
      <button className="btn btn-sm" onClick={() => emit({ type: 'sync.pause', paused: !props.paused })}>{props.paused ? '同期を再開' : '一時停止'}</button>
    </span>
  );
}
