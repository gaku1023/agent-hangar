import { useEmit } from '../intent/chain.tsx';
import type { SessionProps } from '../presenters/session.ts';
import type { TerminalStatus } from '../runtime/terminals.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { Icon } from './primitives/Icon.tsx';
import { SplitPane } from './SplitPane.tsx';
import { TabStrip } from './TabStrip.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { Transcript } from './Transcript.tsx';

const TRUST_HINT = 'Claude の起動を待っています。信頼確認のダイアログが出ていればターミナルで答えてください。';
const ENDED_HINT = 'Claude は終了しました。シェルタブは残っています。';

export function SessionScreen(props: SessionProps & { terminalStatus: TerminalStatus | null }) {
  const emit = useEmit();
  if (props.notFound) return <div className="screen"><div className="empty">セッションが見つかりません</div></div>;
  // run は知っているのに、そのセッションの情報がまだ届いていない状態。
  if (props.loadingSession) return <div className="screen"><div className="empty">セッションを読み込んでいます</div></div>;
  const id = props.id;
  const run = props.run;

  const header = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <StatusDot status={props.live} />
        <h1 className="h1" style={{ margin: 0 }}>{props.name}</h1>
        {props.projectName && <a href="#" onClick={(e) => { e.preventDefault(); if (props.projectId) emit({ type: 'project.open', id: props.projectId }); }}>{props.projectName}</a>}
        <span className="spacer" />
        {props.fromScratch && <span className="faint">再開すると cwd はスクラッチのままです</span>}
        {props.canPromote && <button className="btn" onClick={() => emit({ type: 'session.promote.open', id })}><Icon name="promote" />プロジェクトに昇格</button>}
        {run?.alive && <button className="btn" onClick={() => emit({ type: 'session.openTerminalApp', runId: run.id, tabId: props.selectedTab ?? undefined })}><Icon name="openTerminal" />ターミナルで開く</button>}
        {run?.alive && <button className="btn" onClick={() => emit({ type: 'session.kill', runId: run.id })}><Icon name="stop" />停止</button>}
        <button className="btn" disabled={!props.canResume} onClick={() => emit({ type: 'session.resume', id })}><Icon name="resume" />再開</button>
        <button className="btn" disabled={!props.canFork} onClick={() => emit({ type: 'session.fork', id })}><Icon name="fork" />フォーク</button>
        <button className="btn" onClick={() => emit({ type: 'session.openEditor', sessionId: id })}><Icon name="openEditor" />VS Code で開く</button>
      </div>
      <div className="mono faint" style={{ display: 'flex', gap: 16, margin: '4px 0 8px', flexWrap: 'wrap' }}>
        <span>{props.cwd}</span><span>{props.model}{props.effort ? ` · ${props.effort}` : ''}</span>
        {/* コンテキストの使用率は statusline から届く。80% を超えると色が変わる。 */}
        <span className="gauge-wrap" title="コンテキスト使用率">
          <span className="faint">コンテキスト</span>
          <span className="gauge-bar" role="meter" aria-label="コンテキスト使用率" aria-valuenow={props.contextPercent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <span className="gauge-fill" data-high={(props.contextPercent ?? 0) >= 80 ? 'true' : undefined} style={{ width: `${Math.max(0, Math.min(100, props.contextPercent ?? 0))}%` }} />
          </span>
        </span>
        {props.cost && <span className="mono muted">{props.cost}</span>}
        <span>{props.turns} ターン</span><span>{props.tokens} tokens</span>
        {props.prUrl && <a href={props.prUrl} target="_blank" rel="noreferrer">PR</a>}
        <span>開始 {props.started}</span><span>最終 {props.lastActivity}</span>
        {run && <span>run {run.kind} {run.started}</span>}
        {!props.hasTranscript && <span>本文がありません</span>}
      </div>
    </>
  );

  // 要約がまだ無いときも帯は出す。作り直しはそのときこそ押したいからである。
  const summary = (
    <div className="list" style={{ padding: '8px 12px', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        {props.summary
          ? <><b>{props.summary.title}</b><span className="muted">{props.summary.oneLiner}</span><span className="faint">{props.summary.stateLabel}</span></>
          : <span className="faint">要約はまだありません</span>}
        {props.summaryPending && <span className="faint">要約を作成しています</span>}
        {props.summaryError && <span className="faint" title={props.summaryError}>要約を作成できませんでした</span>}
        <span className="spacer" />
        <button className="btn" onClick={() => emit({ type: 'summary.regenerate', sessionId: id })}>要約を作り直す</button>
        {props.summary && <button className="btn" onClick={() => emit({ type: 'summary.toggle', sessionId: id })}>{props.summaryOpen ? '閉じる' : '詳細'}</button>}
      </div>
      {props.summary && props.summaryOpen && (
        <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
          <div>{props.summary.body}</div>
          {props.summary.nextSteps.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>{props.summary.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <div className="faint" style={{ marginTop: 8 }}>出所 <span>{props.summary.sourceLabel}</span>、{props.summary.basedOnTurns} ターン時点</div>
        </div>
      )}
    </div>
  );

  const toggles = (
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
  );

  const transcript = <Transcript sessionId={id} items={props.items} hasMore={props.hasMore} loading={props.loading} follow={props.follow} live={props.live !== null} remaining={Math.max(props.total - props.loaded, 0)} />;

  const artifacts = props.artifacts.length > 0 && <section className="session-artifacts"><ArtifactCards projectId={null} artifacts={props.artifacts} canAdd={false} /></section>;

  if (run && props.selectedTab) {
    // 案内は Claude のタブにだけ出す。分割で 2 つ並ぶときも、シェルの側には出さない。
    const pane = (tabId: string) => {
      const agentTab = tabId === run.id;
      const hint = agentTab && props.trustHint ? TRUST_HINT : agentTab && !run.alive ? ENDED_HINT : null;
      return <TerminalPane key={tabId} tabId={tabId} status={props.terminalStatus} hint={hint} />;
    };
    // 分割は .split の左の列の中でさらに 2 列に割る。高さは外側の .split から 100% で伝わる。
    const terminals = props.split ? <SplitPane left={pane(props.split.left)} right={pane(props.split.right)} /> : pane(props.selectedTab);
    return (
      <div className="screen">
        {header}{summary}{artifacts}
        <TabStrip sessionId={id} tabs={props.tabs} canAdd={run.alive} canSplit={props.canSplit} split={props.split !== null} />
        <div className="split" style={{ gridTemplateColumns: props.transcriptOpen ? 'minmax(0, 1fr) minmax(320px, 38%)' : 'minmax(0, 1fr) 28px' }}>
          {terminals}
          <aside className="tr-pane">
            <button className="tr-toggle" aria-label={props.transcriptOpen ? 'トランスクリプトを閉じる' : 'トランスクリプトを開く'} onClick={() => emit({ type: 'transcript.toggle' })}><Icon name={props.transcriptOpen ? 'paneClose' : 'paneOpen'} /></button>
            {props.transcriptOpen && <>{toggles}{transcript}</>}
          </aside>
        </div>
      </div>
    );
  }
  return <div className="screen">{header}{summary}{artifacts}{toggles}{transcript}</div>;
}
