import { useEmit } from '../intent/chain.tsx';
import type { SessionProps } from '../presenters/session.ts';
import { StatusDot } from './primitives/StatusDot.tsx';
import { Transcript } from './Transcript.tsx';

export function SessionScreen(props: SessionProps) {
  const emit = useEmit();
  if (props.notFound) return <div className="screen"><div className="empty">セッションが見つかりません</div></div>;
  const id = props.id;
  return (
    <div className="screen">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <StatusDot status={props.live} />
        <h1 className="h1" style={{ margin: 0 }}>{props.name}</h1>
        {props.projectName && <a href="#" onClick={(e) => { e.preventDefault(); if (props.projectId) emit({ type: 'project.open', id: props.projectId }); }}>{props.projectName}</a>}
        <span className="spacer" />
        <button className="btn" disabled={!props.hasTranscript} onClick={() => emit({ type: 'session.resume', id })}>再開</button>
        <button className="btn" disabled={!props.hasTranscript} onClick={() => emit({ type: 'session.fork', id })}>フォーク</button>
        <button className="btn" onClick={() => emit({ type: 'session.openEditor', sessionId: id })}>VS Code で開く</button>
      </div>
      <div className="mono faint" style={{ display: 'flex', gap: 16, margin: '4px 0 8px', flexWrap: 'wrap' }}>
        <span>{props.cwd}</span><span>{props.model}{props.effort ? ` · ${props.effort}` : ''}</span><span>{props.turns} ターン</span><span>{props.tokens} tokens</span>
        {props.prUrl && <a href={props.prUrl} target="_blank" rel="noreferrer">PR</a>}
        <span>開始 {props.started}</span><span>最終 {props.lastActivity}</span>
        {!props.hasTranscript && <span>本文がありません</span>}
      </div>
      {props.summary && (
        <div className="list" style={{ padding: '8px 12px', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
            <b>{props.summary.title}</b><span className="muted">{props.summary.oneLiner}</span><span className="faint">{props.summary.stateLabel}</span>
            <span className="spacer" /><button className="btn" onClick={() => emit({ type: 'summary.toggle', sessionId: id })}>{props.summaryOpen ? '閉じる' : '詳細'}</button>
          </div>
          {props.summaryOpen && (
            <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
              <div>{props.summary.body}</div>
              {props.summary.nextSteps.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>{props.summary.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>}
              <div className="faint" style={{ marginTop: 8 }}>出所 <span>{props.summary.sourceLabel}</span>、{props.summary.basedOnTurns} ターン時点</div>
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 4 }}>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" aria-label="思考を表示" checked={props.showThinking} onChange={(e) => emit({ type: 'transcript.showThinking', sessionId: id, show: e.target.checked })} />思考を表示</label>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" aria-label="生の記録を表示" checked={props.showRaw} onChange={(e) => emit({ type: 'transcript.showRaw', sessionId: id, show: e.target.checked })} />生の記録</label>
        {props.subagents.length > 0 && (
          <select className="select" aria-label="サブエージェント" value={props.agentId ?? ''} onChange={(e) => emit({ type: 'transcript.selectAgent', sessionId: id, agentId: e.target.value || null })}>
            <option value="">主線</option>{props.subagents.map((a) => <option key={a} value={a}>サブエージェント {a}</option>)}
          </select>
        )}
        <span className="spacer" /><span className="faint mono">{props.loaded} / {props.total}</span>
      </div>
      <Transcript sessionId={id} items={props.items} hasMore={props.hasMore} loading={props.loading} follow={props.follow} live={props.live !== null} remaining={Math.max(props.total - props.loaded, 0)} />
    </div>
  );
}
