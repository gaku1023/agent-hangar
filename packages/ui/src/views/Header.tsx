import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import { isComposing } from './ime.ts';
import type { ShellProps, SyncProps, UsageProps } from '../presenters/shell.ts';
import { Icon } from './primitives/Icon.tsx';
import { UsageGauge } from './primitives/UsageGauge.tsx';
import { SyncStatus } from './SyncStatus.tsx';

export function Header(props: { crumbs: ShellProps['crumbs']; searchText: string; indexLabel: string | null; usage: UsageProps; sync: SyncProps }) {
  const emit = useEmit();
  return (
    <header className="header" data-tauri-drag-region="">
      {/* 狭いときは前の段を畳み、今いる名前だけを残す（base.css のコンテナクエリ）。長い名前は省略するので、全文は title で読む。 */}
      <div className="crumbs">
        {props.crumbs.map((c, i) => (
          <span key={i} className={i === props.crumbs.length - 1 ? 'crumb crumb-last' : 'crumb crumb-prev'}>{i > 0 && <span className="faint crumb-sep"> / </span>}{c.route ? <a href={formatRoute(c.route)} title={c.label} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: c.route! }); }}>{c.label}</a> : <b title={c.label}>{c.label}</b>}</span>
        ))}
      </div>
      <input id="global-search" className="input search-box" type="search" role="searchbox" placeholder="セッションを検索（/）" defaultValue={props.searchText}
        onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.query', text: (e.target as HTMLInputElement).value }); }} />
      <kbd className="search-kbd" aria-hidden="true">⌘K</kbd>
      {/* 狭いときは検索欄の代わりに出る。押すとパレットを開く。 */}
      <button className="btn search-icon" aria-label="セッションを検索" title="セッションを検索（⌘K）" onClick={() => emit({ type: 'palette.open' })}><Icon name="search" /></button>
      <span className="spacer" data-tauri-drag-region="" />
      <SyncStatus {...props.sync} />
      {/* 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。 */}
      <span className="gauges">
        <UsageGauge label="5 時間の使用率" short="5h" percent={props.usage.fiveHour} />
        <UsageGauge label="7 日の使用率" short="7d" percent={props.usage.sevenDay} />
        {props.usage.updatedLabel && <span className="faint gauge-updated">最終更新 {props.usage.updatedLabel}</span>}
      </span>
      {/* 狭いときは「＋」だけになる。名前は aria-label に残す。 */}
      <button className="btn btn-primary new-session" aria-label="新規セッション" onClick={() => emit({ type: 'session.new.open' })}><Icon name="add" /><span className="btn-label">新規セッション</span></button>
      {props.indexLabel && <span className="progress">{props.indexLabel}</span>}
    </header>
  );
}
