import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { SyncProps } from '../presenters/shell.ts';
import { foldAt } from './headerFold.ts';

/**
 * ヘッダーの同期の一行。
 * props だけで描き、状態を持たない。状態の文は presenter が組み立てている。
 * 同期を設定していない端末では presenter が visible を false にするので、丸ごと描かない。
 * 狭いヘッダでは、操作、件数、文の順に畳む（headerFold.ts）。
 * Cloudflare の上限で退いている間（reason が quota）と、一時停止中に版で止まっている間は、操作は「今すぐ同期」だけを出す。
 */
const SETTINGS = { name: 'settings' } as const;

export function SyncStatus(props: SyncProps) {
  const emit = useEmit();
  if (!props.visible) return null;
  const pendingText = `未送信 ${props.pending}`;
  const sweepText = `未送信の本文 ${props.sweepPending}`;
  const skippedText = `送れなかった本文 ${props.skipped}`;
  const counts = [props.pending > 0 ? pendingText : null, props.sweepPending > 0 ? sweepText : null, props.skipped > 0 ? skippedText : null].filter((t) => t !== null);
  return (
    <span className="sync" data-state={props.state} data-reason={props.reason ?? undefined} data-once={props.once ? '' : undefined}>
      {/* 状態の点はリンクの中に置く。狭いヘッダで文を畳んでも点は残り、押せば設定を開く。
          設定にも「今すぐ同期」があるので、畳んだ操作への道にもなる。
          文は幅が足りないと省略記号に切り詰まり、件数は畳むので、全文と件数は title から読めるようにする。 */}
      <a className={props.once ? 'mono sync-label faint' : props.state === 'error' || props.reason === 'quota' ? 'mono sync-label sync-error' : 'mono sync-label faint'} href={formatRoute(SETTINGS)} title={`${[props.label, ...counts].join('、')}（押すと同期の設定を開く）`} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: SETTINGS }); }}>
        <span className="sync-dot" aria-hidden="true" />
        <span className="sync-label-text" data-fold-at={foldAt('sync-label')}>{props.label}</span>
      </a>
      {/* 0 件のときに「未送信 0」と出すと、止まっているように見える。溜まっているときだけ出す。 */}
      {props.pending > 0 && <span className="faint sync-count" data-fold-at={foldAt('sync-counts')}>{pendingText}</span>}
      {/* 本文は 60 秒に 20 件ずつしか流れないので、残りが見えないと止まっているのか進んでいるのか分からない。 */}
      {props.sweepPending > 0 && <span className="faint sync-count" data-fold-at={foldAt('sync-counts')}>{sweepText}</span>}
      {/* 送れなかった本文は放っておけば 30 分ごとに送り直すが、そのあいだ気付く手立てがここしか無い。
          誤りなので、狭いヘッダでも畳まない。 */}
      {props.skipped > 0 && <span className="sync-error sync-skipped">{skippedText}</span>}
      {/* 一時停止の間は、押した 1 回だけ同期して停止に戻る。名前は変えず、添え書きで伝える。
          その 1 回が進んでいるあいだは押せない姿にして、効いていることを見せる。 */}
      <button className="btn btn-sm sync-action" data-fold-at={foldAt('sync-actions')} disabled={props.once} title={props.paused && !props.once ? '一時停止のまま、1 回だけ同期する' : undefined} onClick={() => emit({ type: 'sync.now' })}>{props.once ? '同期中…' : '今すぐ同期'}</button>
      {/* 上限で退いている間は、利用者は止めていないので切り替えを出さず、今すぐ同期だけにする（試作の Q4 の案 B）。
          一時停止中に版で止まっている間も出さない。再開しても、この PC の hangar を更新するまで同期できないからである。 */}
      {props.reason !== 'quota' && !(props.paused && props.state === 'error') && <button className="btn btn-sm sync-action" data-fold-at={foldAt('sync-actions')} onClick={() => emit({ type: 'sync.pause', paused: !props.paused })}>{props.paused ? '同期を再開' : '同期を一時停止'}</button>}
    </span>
  );
}
