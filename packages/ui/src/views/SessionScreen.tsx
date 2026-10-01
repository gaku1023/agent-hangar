import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import { RUN_KIND_LABEL } from '../presenters/format.ts';
import type { SessionProps } from '../presenters/session.ts';
import type { TerminalStatus } from '../runtime/terminals.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { LivePane } from './LivePane.tsx';
import { PageHeading } from './PageHeading.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { ToggleChip } from './primitives/Chip.tsx';
import { Icon } from './primitives/Icon.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { SplitPane } from './SplitPane.tsx';
import { TabStrip } from './TabStrip.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { Transcript } from './Transcript.tsx';
import { TurnIndex } from './TurnIndex.tsx';

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
      {/* 上段は頁の見出しの行を兼ねる。一覧の行や Home の札から開くと、その行がここへ広がる（runtime/present.ts が data-morph-hero を探す）。 */}
      <PageHeading title={props.name} parent={props.parent} lead={<StatusDot status={props.live} />} titleClassName="session-name" rowClassName="session-hero" hero={id}>
        {props.summary?.oneLiner ? <span className="session-oneliner" title={props.summary.oneLiner}>{props.summary.oneLiner}</span> : <span className="spacer" />}
        {props.fromScratch && <span className="faint">再開しても作業ディレクトリはスクラッチのままです</span>}
        {props.canPromote && <button className="btn" onClick={() => emit({ type: 'session.promote.open', id })}><Icon name="promote" /><span className="btn-label">プロジェクトに昇格</span></button>}
        {run?.alive && <button className="btn" onClick={() => emit({ type: 'session.openTerminalApp', runId: run.id, tabId: props.selectedTab ?? undefined })}><Icon name="openTerminal" /><span className="btn-label">ターミナルで開く</span></button>}
        {/* 停止は取り消せないので危険色にする。作業中か、シェルタブを巻き込むときは Mediator が先に確認を出す。 */}
        {run?.alive && <button className="btn btn-danger" onClick={() => emit({ type: 'session.kill', runId: run.id, working: props.live === 'busy' || props.live === 'waiting', shellTabs: props.tabs.filter((t) => t.kind === 'shell').length })}><Icon name="stop" /><span className="btn-label">停止</span></button>}
        <button className="btn" disabled={!props.canResume} onClick={() => emit({ type: 'session.resume', id })}><Icon name="resume" /><span className="btn-label">再開</span></button>
        <button className="btn" disabled={!props.canFork} onClick={() => emit({ type: 'session.fork', id })}><Icon name="fork" /><span className="btn-label">フォーク</span></button>
        {/* 本文が他端末にあるときと、相手の heartbeat が途絶えたとき（Ruling 14）の逃げ道。
            出す条件は canResumeHere 単独にする。lock の有無で枝分かれさせると、途絶えた側が行き止まりになる。 */}
        {props.canResumeHere && <button className="btn" onClick={() => emit({ type: 'session.resumeHere', id })}><Icon name="resumeHere" /><span className="btn-label">この PC で再開</span></button>}
        {/* hangar の外で動いているあいだは本文しか見せられない。引き取りは外のターミナルの claude を終わらせるので、押すと確認に回る。 */}
        {props.outsideOpen === 'adopt' && <button className="btn" onClick={() => emit({ type: 'session.adopt', id })}><Icon name="resumeHere" /><span className="btn-label">hangar で引き取る</span></button>}
        {props.outsideOpen === 'attach' && <button className="btn" onClick={() => emit({ type: 'session.attach', id })}><Icon name="shell" /><span className="btn-label">hangar でつなぐ</span></button>}
        <button className="btn" onClick={() => emit({ type: 'session.openEditor', sessionId: id })}><Icon name="openEditor" /><span className="btn-label">VS Code で開く</span></button>
      </PageHeading>
      {/* チップの列。状態と経過、プロジェクト、モデルと effort、コンテキスト使用率、推定コスト、変更数、1 行メモ、PR、ロック。 */}
      <div className="chips">
        {props.liveLabel && <span className="chip">{props.liveLabel}</span>}
        {props.projectName && <a className="chip" href="#" onClick={(e) => { e.preventDefault(); if (props.projectId) emit({ type: 'project.open', id: props.projectId }); }}>{props.projectName}</a>}
        {props.model && <span className="chip mono">{props.model}{props.effort ? ` · ${props.effort}` : ''}</span>}
        {/* コンテキストの使用率と推定コストは statusline の追記からしか届かない。
            追記を入れていなければずっと null なので、空の棒ではなく「未取得」と書く。
            0% と見分けが付かない見せ方にしない。ヘッダーの使用量ゲージと言い方を揃える。 */}
        {props.contextPercent === null
          ? <span className="chip faint">コンテキスト 未取得</span>
          : (
            <span className="chip gauge-wrap" title="コンテキストの使用率">
              <span className="faint">コンテキスト</span>
              <span className="gauge-bar" role="meter" aria-label="コンテキストの使用率" aria-valuenow={props.contextPercent} aria-valuemin={0} aria-valuemax={100}>
                <span className="gauge-fill" data-high={props.contextPercent >= 80 ? 'true' : undefined} style={{ width: `${Math.max(0, Math.min(100, props.contextPercent))}%` }} />
              </span>
            </span>
          )}
        {props.cost ? <span className="chip mono">{props.cost}</span> : <span className="chip faint">コスト 未取得</span>}
        {props.contextPercent === null && !props.cost && <a className="hint-link" href={formatRoute({ name: 'settings' })} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: { name: 'settings' } }); }}>statusline を入れると出ます</a>}
        {props.filesChanged > 0 && <span className="chip">変更 {props.filesChanged}</span>}
        {props.memo && <span className="chip chip-memo">メモ：{props.memo}</span>}
        {props.prUrl && <a className="chip" href={props.prUrl} target="_blank" rel="noreferrer">PR</a>}
        {/* ロックの文言は presenter が lock.label に組み立てている（「<端末名> で実行中」「<端末名> が応答がありません」）。
            View は色だけを変え、最終確認の時刻を下の注記に添えてどれだけ途絶えているかを見せる。 */}
        {props.lock && <span className={`chip ${props.lock.stale ? 'warn' : 'lock'}`}>{props.lock.label}</span>}
        {props.gone && <span className="chip">要約のみ</span>}
      </div>
      {/* 細かな事実。判断の手がかりだが、チップほど目立たせない。 */}
      <div className="session-facts mono faint">
        <span>{props.cwd}</span><span>{props.turns} ターン</span><span>{props.tokens} トークン</span>
        <span>開始 {props.started}</span><span>最終 {props.lastActivity}</span>
        {run && <span>{RUN_KIND_LABEL[run.kind]} {run.started}</span>}
        {props.lock && <span>最終確認 {props.lock.heartbeat}</span>}
        {props.remoteOnly && <span>本文は他の PC にあります</span>}
        {!props.hasTranscript && !props.gone && <span>本文がありません</span>}
      </div>
    </>
  );

  // 本文が消えた会話では、要約の上に一行で理由を言う。既定の保持期間のままなら、その場で延ばす手を添える。
  const goneNote = props.gone && (
    <div className="gone-note" role="note">
      {props.gone.note}
      {props.gone.canExtend && <> <button type="button" className="btn-link" onClick={() => emit({ type: 'retention.edit', days: props.gone!.extendTo, from: 'session' })}>保持期間を延ばす…</button></>}
    </div>
  );

  // 要約がまだ無いときも帯は出す。作り直しはそのときこそ押したいからである。
  const summary = (
    <div className="list" style={{ padding: '8px 12px', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        {props.summary
          ? <><b>{props.summary.title}</b><span className="faint">{props.summary.stateLabel}</span></>
          : <span className="faint">{props.gone ? '要約もありません' : '要約はまだありません'}</span>}
        {props.summaryPending && <span className="faint">要約を作成しています</span>}
        {props.summaryError && <span className="faint" title={props.summaryError}>要約を作成できませんでした</span>}
        <span className="spacer" />
        {/* 本文が無いと作り直しは必ず失敗するので、消えた会話では出さない。 */}
        {!props.gone && <button className="btn" onClick={() => emit({ type: 'summary.regenerate', sessionId: id })}>要約を作り直す</button>}
        {props.summary && <button className="btn" onClick={() => emit({ type: 'summary.toggle', sessionId: id })}>{props.summaryOpen ? '閉じる' : '詳細'}</button>}
      </div>
      {props.summary && props.summaryOpen && (
        <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
          <div>{props.summary.body}</div>
          {props.summary.nextSteps.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>{props.summary.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {/* 何がこの要約を書いたのかは、作り直すかどうかの判断に要る。
              要約器の種類は source_id、モデル名は source_model にあるので、presenter で 1 つの札にまとめて受け取る。
              土台の要約には要約器が無いので、そのときは札ごと出さない。 */}
          <div className="faint" data-testid="summary-source" style={{ marginTop: 8 }}>出所 <span>{props.summary.sourceLabel}</span>{props.summary.summarizerLabel && <>、<span className="mono">{props.summary.summarizerLabel}</span></>}、{props.summary.basedOnTurns} ターン時点、{props.summary.generatedAt} 生成</div>
        </div>
      )}
    </div>
  );

  // サブエージェントは、主線と 3 つまでなら帯に並べ、それより多ければ一覧にする。帯が横にあふれないようにするため。
  const agentOptions = [{ value: '', label: '主線' }, ...props.subagents.map((a) => ({ value: a, label: a }))];
  const selectAgent = (v: string) => emit({ type: 'transcript.selectAgent', sessionId: id, agentId: v || null });
  const toggles = (
    <div className="transcript-toggles">
      <ToggleChip label="思考を表示" text="思考" icon="thinking" pressed={props.showThinking} onChange={(show) => emit({ type: 'transcript.showThinking', sessionId: id, show })} />
      <ToggleChip label="生の記録を表示" text="生の記録" icon="rawLog" pressed={props.showRaw} onChange={(show) => emit({ type: 'transcript.showRaw', sessionId: id, show })} />
      {props.subagents.length > 0 && <span className="transcript-toggles-sep" aria-hidden="true" />}
      {props.subagents.length > 0 && (props.subagents.length <= 3
        ? <Segmented label="サブエージェント" value={props.agentId ?? ''} options={agentOptions.map((o) => (o.value ? { ...o, lead: <Icon name="agent" /> } : o))} onChange={selectAgent} />
        : <Listbox label="サブエージェント" value={props.agentId ?? ''} options={agentOptions.map((o) => (o.value ? { ...o, label: `サブエージェント ${o.value}`, icon: 'agent' as const } : o))} onChange={selectAgent} faceClassName="listbox-face listbox-pill" minWidth={260} />)}
      <span className="spacer" /><span className="faint mono">{props.loaded} / {props.total}</span>
    </div>
  );

  const transcript = <Transcript sessionId={id} items={props.items} hasMore={props.hasMore} loading={props.loading} follow={props.follow} live={props.live !== null} remaining={Math.max(props.total - props.loaded, 0)} find={props.find} jump={props.jump} hasNewer={props.hasNewer} />;

  const artifacts = props.artifacts.length > 0 && <section className="session-artifacts"><ArtifactCards projectId={null} artifacts={props.artifacts} canAdd={false} /></section>;

  const paneToggle = <button className="tr-toggle" aria-label={props.transcriptOpen ? '右の欄を閉じる' : '右の欄を開く'} onClick={() => emit({ type: 'transcript.toggle' })}><Icon name={props.transcriptOpen ? 'paneClose' : 'paneOpen'} /></button>;

  // 本文が消えた会話は、会話の欄もターンの目次も持たない。残っている要約と成果物だけを見せる。
  if (props.gone) return <div className="screen session-screen">{header}{goneNote}{summary}{artifacts}</div>;

  if (run && props.selectedTab) {
    // 案内は Claude のタブにだけ出す。分割で 2 つ並ぶときも、シェルの側には出さない。
    const pane = (tabId: string) => {
      const agentTab = tabId === run.id;
      const hint = agentTab && props.trustHint ? TRUST_HINT : agentTab && !run.alive ? ENDED_HINT : null;
      return <TerminalPane key={tabId} tabId={tabId} status={props.terminalStatus} hint={hint} live={props.live} />;
    };
    // 分割は .split の左の列の中でさらに 2 列に割る。高さは外側の .split から 100% で伝わる。
    const terminals = props.split ? <SplitPane left={pane(props.split.left)} right={pane(props.split.right)} /> : pane(props.selectedTab);
    return (
      <div className="screen session-screen screen-fill">
        {/* 成果物は、右ペインの「いま」があればそこへ移す。上に並べると、その分だけ端末が縮む。 */}
        {header}{summary}{props.livePane && props.transcriptOpen ? null : artifacts}
        <TabStrip sessionId={id} tabs={props.tabs} canAdd={run.alive} canSplit={props.canSplit} split={props.split !== null} />
        {/* 右欄は会話の全文ではなくターンの目次にする。全文は左のターミナルと重なるので、押したターンだけを開き、左もそこへ跳ばす。 */}
        <div className="split" style={{ gridTemplateColumns: props.transcriptOpen ? 'minmax(0, 1fr) minmax(240px, 26%)' : 'minmax(0, 1fr) 28px' }}>
          {terminals}
          <aside className="tr-pane" data-collapsed={props.transcriptOpen ? undefined : 'true'}>
            {props.transcriptOpen
              ? (() => {
                const toc = <TurnIndex sessionId={id} runId={run.alive ? run.id : null} rows={props.turnRows} complete={props.turnsComplete} openItems={props.openTurnItems} turnJump={props.turnJump} hasMore={props.hasMore} loading={props.loading} remaining={Math.max(props.total - props.loaded, 0)} agentId={props.agentId} lead={props.livePane ? undefined : paneToggle} />;
                // 実行中は右ペインの上に「いま」を出し、目次は一番下に残す。終わった run では今までどおり目次だけ。
                return props.livePane ? <LivePane sessionId={id} pane={props.livePane} lead={paneToggle} split={props.livePaneSplit} artifacts={props.artifacts}>{toc}</LivePane> : toc;
              })()
              : paneToggle}
          </aside>
        </div>
      </div>
    );
  }
  return <div className="screen session-screen screen-fill">{header}{summary}{artifacts}<section className="tr-sheet">{toggles}{transcript}</section></div>;
}
