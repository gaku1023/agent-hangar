import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { SyncProps } from '../presenters/shell.ts';
import { foldAt } from './headerFold.ts';

/**
 * ヘッダーの同期の一行。
 * 状態を示すだけで、操作は持たない。今すぐ同期、一時停止、参加トークンは設定の同期の群にある。
 * 状態の点と語（リンク）と件数を並べ、語を押すと設定の同期の群へ移る。
 * props だけで描き、状態を持たない。語と件数の文は presenter が組み立てている。
 * 状態がまだ届いていない間は presenter が visible を false にするので、丸ごと描かない。
 * 同期を使っていない端末は「同期オフ」と言う。点は灰色で、押せば始め方のある群へ行ける。
 * 狭いヘッダでは、件数、文の順に畳む（headerFold.ts）。
 */
const SYNC_SETTINGS = { name: 'settings', at: 'sync' } as const;

export function SyncStatus(props: SyncProps) {
  const emit = useEmit();
  if (!props.visible) return null;
  // 1 回だけ同期している最中は、止まった理由より動いていることを先に見せる。
  const error = !props.once && (props.state === 'error' || props.reason === 'quota');
  return (
    <span className="sync" data-state={props.state} data-reason={props.reason ?? undefined} data-once={props.once ? '' : undefined}>
      {/* 状態の点はリンクの中に置く。狭いヘッダで文を畳んでも点は残り、押せば設定の同期の群を開く。
          文は幅が足りないと省略記号に切り詰まり、件数は畳むので、全文と件数は title から読めるようにする。 */}
      <a className={error ? 'mono sync-label sync-error' : 'mono sync-label faint'} href={formatRoute(SYNC_SETTINGS)} title={props.title} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: SYNC_SETTINGS }); }}>
        <span className="sync-dot" aria-hidden="true" />
        <span className="sync-label-text" data-fold-at={foldAt('sync-label')}>{props.label}</span>
      </a>
      {/* 0 件のときに「未送信の変更 0」と出すと、止まっているように見える。溜まっているときだけ出す。 */}
      {props.pending !== null && <span className="faint sync-count" data-fold-at={foldAt('sync-counts')}>{props.pending}</span>}
      {/* トランスクリプトは 60 秒に 20 件ずつしか流れないので、残りが見えないと止まっているのか進んでいるのか分からない。 */}
      {props.sweepPending !== null && <span className="faint sync-count" data-fold-at={foldAt('sync-counts')}>{props.sweepPending}</span>}
      {/* 送信に失敗したトランスクリプトは放っておけば 30 分ごとに送り直すが、そのあいだ気付く手立てがここしか無い。
          誤りなので、狭いヘッダでも畳まない。 */}
      {props.skipped !== null && <span className="sync-error sync-skipped">{props.skipped}</span>}
    </span>
  );
}
