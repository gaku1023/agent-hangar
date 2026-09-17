import { useEmit } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { RelativeTime } from './primitives/RelativeTime.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { VirtualList } from './primitives/VirtualList.tsx';

const cols = (showProject: boolean) => `16px minmax(160px, 1.2fr) minmax(200px, 2fr) ${showProject ? '120px ' : ''}72px 110px 48px 32px 80px`;

export function SessionRows(props: { rows: SessionRowProps[]; height: number | string; showProject: boolean; showSnippets?: boolean }) {
  const emit = useEmit();
  if (props.rows.length === 0) return <div className="list"><div className="empty">セッションはまだありません</div></div>;
  const style = { gridTemplateColumns: cols(props.showProject) };
  const head = (
    <div className="row row-head" style={style} role="row">
      <span /><span>名前</span><span>要約</span>{props.showProject && <span>プロジェクト</span>}<span>状態</span><span>モデル</span><span className="cell-right">変更</span><span>PR</span><span className="cell-right">最終活動</span>
    </div>
  );
  const rowHeight = (r: SessionRowProps) => 28 + (props.showSnippets ? (r.snippets?.length ?? 0) * 20 : 0);
  return (
    <VirtualList items={props.rows} rowHeight={28} height={props.height} keyOf={(r) => r.id} head={head} render={(r) => (
      <div style={{ height: rowHeight(r) }}>
        <div className="row" style={style} role="row" tabIndex={0} onClick={() => emit({ type: 'session.open', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'session.open', id: r.id }); }}>
          <StatusDot status={r.live} />
          <span className="cell">{r.name}</span>
          <span className="cell muted">{r.oneLiner}</span>
          {props.showProject && <span className="cell muted">{r.projectName ?? '未分類'}</span>}
          <span className="cell muted">{r.stateLabel}</span>
          <span className="cell mono">{r.model}{r.effort ? ` · ${r.effort}` : ''}</span>
          <span className="cell mono cell-right">{r.filesChanged || ''}</span>
          <span className="cell">{r.prUrl ? <a href={r.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR</a> : ''}</span>
          <span className="cell cell-right"><RelativeTime label={r.when} abs={r.whenAbs} /></span>
        </div>
        {props.showSnippets && r.snippets?.map((s) => <div key={s.seq} className="mono faint" style={{ height: 20, padding: '0 12px 0 40px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{s.text}</div>)}
      </div>
    )} />
  );
}
