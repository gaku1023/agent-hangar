import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { SyncProps } from '../presenters/shell.ts';

/**
 * ヘッダーの同期の一行。
 * props だけで描き、状態を持たない。文言はすべて presenter が組み立てている。
 * 同期を設定していない端末では presenter が visible を false にするので、丸ごと描かない。
 */
const SETTINGS = { name: 'settings' } as const;

export function SyncStatus(props: SyncProps) {
  const emit = useEmit();
  if (!props.visible) return null;
  return (
    <span className="sync" data-state={props.state}>
      {/* 状態の点は、狭いヘッダで文と操作を畳んでも残る。 */}
      <span className="sync-dot" aria-hidden="true" />
      {/* 幅が足りないと省略記号に切り詰まるので、全文は title から読めるようにする。
          押すと設定を開く。狭いヘッダでは「今すぐ同期」と「同期を一時停止」を畳むので、そこへの道になる。 */}
      <a className={props.state === 'error' ? 'mono sync-label sync-error' : 'mono sync-label faint'} href={formatRoute(SETTINGS)} title={`${props.label}（押すと同期の設定を開く）`} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: SETTINGS }); }}>{props.label}</a>
      {/* 0 件のときに「未送信 0」と出すと、止まっているように見える。溜まっているときだけ出す。 */}
      {props.pending > 0 && <span className="faint sync-count">未送信 {props.pending}</span>}
      {/* 本文は 60 秒に 20 件ずつしか流れないので、残りが見えないと止まっているのか進んでいるのか分からない。 */}
      {props.sweepPending > 0 && <span className="faint sync-count">未送信の本文 {props.sweepPending}</span>}
      {/* 送れなかった本文は放っておけば 30 分ごとに送り直すが、そのあいだ気付く手立てがここしか無い。 */}
      {props.skipped > 0 && <span className="sync-error">送れなかった本文 {props.skipped}</span>}
      <button className="btn btn-sm sync-action" onClick={() => emit({ type: 'sync.now' })}>今すぐ同期</button>
      <button className="btn btn-sm sync-action" onClick={() => emit({ type: 'sync.pause', paused: !props.paused })}>{props.paused ? '同期を再開' : '同期を一時停止'}</button>
    </span>
  );
}
