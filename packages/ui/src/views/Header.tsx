import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import { isComposing } from './ime.ts';
import type { ShellProps } from '../presenters/shell.ts';

export function Header(props: { crumbs: ShellProps['crumbs']; searchText: string; connection: ShellProps['connection']; indexLabel: string | null }) {
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
      <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open' })}>新規セッション</button>
      {props.indexLabel && <span className="progress">{props.indexLabel}</span>}
      <span className="conn" data-state={props.connection}>{props.connection === 'connected' ? '接続中' : props.connection === 'connecting' ? '接続しています' : '再接続中'}</span>
    </header>
  );
}
