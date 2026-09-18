import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import { isComposing } from './ime.ts';
import type { ShellProps, UsageProps } from '../presenters/shell.ts';
import { Icon } from './primitives/Icon.tsx';
import { UsageGauge } from './primitives/UsageGauge.tsx';

export function Header(props: { crumbs: ShellProps['crumbs']; searchText: string; connection: ShellProps['connection']; indexLabel: string | null; usage: UsageProps }) {
  const emit = useEmit();
  return (
    <header className="header">
      <div className="crumbs">
        {props.crumbs.map((c, i) => (
          <span key={i}>{i > 0 && <span className="faint"> / </span>}{c.route ? <a href={formatRoute(c.route)} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: c.route! }); }}>{c.label}</a> : <b>{c.label}</b>}</span>
        ))}
      </div>
      <input id="global-search" className="input search-box" type="search" role="searchbox" placeholder="セッションを検索（/）" defaultValue={props.searchText}
        onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) emit({ type: 'search.query', text: (e.target as HTMLInputElement).value }); }} />
      <span className="spacer" />
      {/* 使用率は Claude が動いている間だけ届くので、最終更新を添えて古さを見せる。 */}
      <span className="gauges">
        <UsageGauge label="5 時間の使用率" percent={props.usage.fiveHour} />
        <UsageGauge label="7 日の使用率" percent={props.usage.sevenDay} />
        {props.usage.updatedLabel && <span className="faint gauge-updated">最終更新 {props.usage.updatedLabel}</span>}
      </span>
      <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open' })}><Icon name="add" />新規セッション</button>
      {props.indexLabel && <span className="progress">{props.indexLabel}</span>}
      <span className="conn" data-state={props.connection}>{props.connection === 'connected' ? '接続中' : props.connection === 'connecting' ? '接続しています' : '再接続中'}</span>
    </header>
  );
}
