import { formatRoute } from '@agent-hangar/shared';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { RUN_KIND_LABEL } from '../presenters/format.ts';
import type { SessionAction, SessionActionId, SessionProps } from '../presenters/session.ts';
import { LivePane } from './LivePane.tsx';
import { PageHeading } from './PageHeading.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { ToggleChip } from './primitives/Chip.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { motionEase, motionMs, motionValue } from './primitives/motion.ts';
import { motionOn } from './primitives/motionKit.ts';
import { Listbox } from './primitives/Listbox.tsx';
import { MenuButton, type MenuItem } from './primitives/MenuButton.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { RollingText } from './primitives/RollingText.tsx';
import { PANE_SHAPE, playPaneMotion } from './primitives/paneMotion.ts';
import { usePresence } from './primitives/usePresence.ts';
import { SplitPane } from './SplitPane.tsx';
import { TabStrip } from './TabStrip.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { TodoList } from './TodoList.tsx';
import { Transcript } from './Transcript.tsx';
import { TurnIndex } from './TurnIndex.tsx';

const TRUST_HINT = 'Claude の起動を待っています。信頼確認のダイアログが出ていればターミナルで答えてください。';
const ENDED_HINT = 'Claude は終了しました。シェルタブは残っています。';

const ACTION_ICON: Record<SessionActionId, IconName> = {
  openEditor: 'openEditor', resume: 'resume', resumeHere: 'resumeHere', fork: 'fork', openTerminal: 'openTerminal',
  attach: 'shell', adopt: 'resumeHere', regenerate: 'rebuild', promote: 'promote', stop: 'stop',
};

/**
 * セッション画面（設計は docs/superpowers/specs/2026-10-01-ux-refresh-2-design.md の「1 セッション画面の組み直し」、試作は session-layout-v2.html）。
 * 上から、見出しの段（点、名前、要約の 1 文、主の操作、「…」）、線の下の 1 行（B1）、そして残りの高さを全部使う本体を置く。
 * 本体は、ターミナルが出るときはタブの列とターミナルと右の欄（実行中は live-explainer の欄）、出ないときは本文と右欄（要約、TODO、変更したファイル）である。
 */
export function SessionScreen(props: SessionProps) {
  const emit = useEmit();
  const reasonId = useId();
  // 右の欄の開閉（設計書 ②）。閉じる動きが終わるまで中身を描き続け、開いたら滑らせて広げる。
  // フックなので、下の早い return より前に置く。
  const splitRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const running = Boolean(props.run && props.selectedTab);
  const shape = running ? PANE_SHAPE.split : PANE_SHAPE.rail;
  const boxRef = running ? splitRef : railRef;
  const pane = usePresence<HTMLElement>(props.transcriptOpen, (inner) => (boxRef.current ? playPaneMotion(boxRef.current, shape.open, inner, false) : null));
  const paneFirst = useRef(true);
  useLayoutEffect(() => {
    if (paneFirst.current) { paneFirst.current = false; return; }
    if (props.transcriptOpen && boxRef.current) void playPaneMotion(boxRef.current, shape.closed, pane.ref.current, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.transcriptOpen]);
  // 「いま」の出入り（設計書 ⑩）。消えるときは、ランプの色が替わるのを待ってから、見出し、上の段、境目を薄れさせ、終わったら外す。
  // 消える間は最後の livePane を描き続ける。
  // 画面はセッションごとに作り直されないので、最後に「いま」を出したセッションを覚え、別のセッションへ替えたときは薄れさせずにすぐ外す。
  const lastLive = useRef(props.livePane);
  const liveSession = useRef(props.id);
  if (props.livePane) { lastLive.current = props.livePane; liveSession.current = props.id; }
  const live = usePresence<HTMLDivElement>(props.livePane !== null, (el) => {
    if (liveSession.current !== props.id || !motionOn(el)) return null;
    const parts = el.querySelectorAll<HTMLElement>(':scope > .live-pane-head, :scope > .live-top, :scope > .live-divider');
    const blur = `blur(${motionValue('--blur-in', el)})`;
    const anims = [...parts].map((p) => p.animate([{ opacity: 1 }, { opacity: 0, filter: blur }], { duration: motionMs('--dur-exit', el), delay: motionMs('--dur', el), easing: motionEase('--ease-in', el), fill: 'forwards' }));
    return Promise.all(anims.map((a) => a.finished)).catch(() => undefined);
  });
  if (props.notFound) return <div className="screen"><div className="empty">セッションが見つかりません</div></div>;
  // run は知っているのに、そのセッションの情報がまだ届いていない状態。
  if (props.loadingSession) return <div className="screen"><div className="empty">セッションを読み込んでいます</div></div>;
  const id = props.id;
  const run = props.run;

  const act = (a: SessionActionId) => {
    switch (a) {
      case 'openEditor': emit({ type: 'session.openEditor', sessionId: id }); return;
      case 'resume': emit({ type: 'session.resume', id }); return;
      case 'resumeHere': emit({ type: 'session.resumeHere', id }); return;
      case 'fork': emit({ type: 'session.fork', id }); return;
      case 'openTerminal': if (run) emit({ type: 'session.openTerminalApp', runId: run.id, tabId: props.selectedTab ?? undefined }); return;
      // hangar の外で動いているあいだは本文しか見せられない。
      // 引き取りは外のターミナルの claude を終わらせるので、Mediator が確認に回す。
      case 'attach': emit({ type: 'session.attach', id }); return;
      case 'adopt': emit({ type: 'session.adopt', id }); return;
      case 'regenerate': emit({ type: 'summary.regenerate', sessionId: id }); return;
      case 'promote': emit({ type: 'session.promote.open', id }); return;
      // 停止は取り消せない。
      // 作業中か、シェルタブを巻き込むときは Mediator が先に確認を出す。
      case 'stop': if (run) emit({ type: 'session.kill', runId: run.id, working: props.live === 'busy' || props.live === 'waiting', shellTabs: props.tabs.filter((t) => t.kind === 'shell').length }); return;
    }
  };
  const item = (a: SessionAction): MenuItem => ({ key: a.id, label: a.label, icon: ACTION_ICON[a.id], note: a.note, disabled: a.disabled, danger: a.danger, onSelect: () => act(a.id) });
  const primary = props.actions.primary;

  const header = (
    <>
      {/* 見出しの行。
          一覧の行や Home の札から開くと、その行がここへ広がる（runtime/present.ts が data-morph-hero を探す）。
          名前は見出しにだけ出し、要約の題は出さない（C1）。
          操作は状態に合う 1 つだけを主にし、残りは「…」に入れる（A1）。 */}
      <PageHeading title={props.name} parent={props.parent} lead={<StatusDot status={props.live} />} titleClassName="session-name" rowClassName="session-hero" hero={id}>
        {props.summary?.oneLiner ? <span key={props.summary.oneLiner} className="session-oneliner" title={props.summary.oneLiner}>{props.summary.oneLiner}</span> : <span className="spacer" />}
        {/* 押せない主の操作は、乗せても読み上げでも理由が分かるように、disabled ではなく aria-disabled にする。 */}
        <button type="button" className="btn btn-primary" aria-disabled={primary.disabled ? 'true' : undefined} title={primary.disabled ?? primary.note ?? undefined}
          aria-describedby={primary.disabled ? reasonId : undefined} onClick={() => { if (!primary.disabled) act(primary.id); }}>
          <Icon name={ACTION_ICON[primary.id]} /><span className="btn-label">{primary.label}</span>
        </button>
        {primary.disabled && <span id={reasonId} className="sr-only">{primary.disabled}</span>}
        <MenuButton label="ほかの操作" items={props.actions.menu.map(item)} />
      </PageHeading>
      <InfoLine {...props} />
    </>
  );

  const paneToggle = <button className="tr-toggle" aria-label={props.transcriptOpen ? '右の欄を閉じる' : '右の欄を開く'} title="右の欄の開閉（⌘J）" onClick={() => emit({ type: 'transcript.toggle' })}><Icon name={props.transcriptOpen ? 'paneClose' : 'paneOpen'} /></button>;
  // 閉じている間は、タブの帯の右端に開くボタンを置く（設計書 ②）。開いている間は欄の見出しの行の paneToggle を使う。
  const paneOpen = <button type="button" className="btn btn-sm tab-pane-open" aria-label="右の欄を開く" title="右の欄の開閉（⌘J）" onClick={() => emit({ type: 'transcript.toggle' })}><Icon name="paneOpen" /><span>{props.livePane ? 'いま' : 'ターン'}</span><kbd className="mono">⌘J</kbd></button>;

  // 本文が消えた会話は、会話の欄もターンの目次も持たない。
  // 残っている要約と TODO だけを見せる。
  if (props.gone) {
    return (
      <div className="screen session-screen">
        {header}
        <div className="session-body" data-gone="true">
          <div className="gone-note" role="note">
            {props.gone.note}
            {props.gone.canExtend && <> <button type="button" className="btn-link" onClick={() => emit({ type: 'retention.edit', days: props.gone!.extendTo, from: 'session' })}>保持期間を延ばす…</button></>}
          </div>
          <SummaryPanel {...props} />
          <TodoPanel {...props} />
        </div>
      </div>
    );
  }

  if (run && props.selectedTab) {
    // 案内と transcript の帯は Claude のタブにだけ出す。
    // 分割で 2 つ並ぶときも、シェルの側には出さない。
    const terminal = (tabId: string) => {
      const agentTab = tabId === run.id;
      const hint = agentTab && props.trustHint ? TRUST_HINT : agentTab && !run.alive ? ENDED_HINT : null;
      const transcript = agentTab && run.alive && props.transcriptBand ? { when: props.transcriptBand.when, onLatest: () => emit({ type: 'turn.latest', sessionId: id, runId: run.id }) } : null;
      return <TerminalPane key={tabId} tabId={tabId} hint={hint} live={props.live} agent={agentTab} transcript={transcript} />;
    };
    // 分割は .split の左の列の中でさらに 2 列に割る。高さは外側の .split から 100% で伝わる。
    // 出る間は最後の livePane を描く。
    const livePane = live.mounted ? (props.livePane ?? (liveSession.current === id ? lastLive.current : null)) : null;
    const terminals = props.split ? <SplitPane left={terminal(props.split.left)} right={terminal(props.split.right)} /> : terminal(props.selectedTab);
    return (
      <div className="screen session-screen">
        {header}
        <TabStrip sessionId={id} tabs={props.tabs} canAdd={run.alive} canSplit={props.canSplit} split={props.split !== null} trailing={props.transcriptOpen ? null : paneOpen} />
        {/* 右欄は会話の全文ではなくターンの目次にする。
            全文は左のターミナルと重なるので、押したターンだけを開き、左もそこへ跳ばす。
            .split は縦の flex で窓の残りの高さを全部受け取る（session.css）。 */}
        <div ref={splitRef} className="split" style={{ gridTemplateColumns: props.transcriptOpen ? PANE_SHAPE.split.open.cols : PANE_SHAPE.split.closed.cols, columnGap: props.transcriptOpen ? undefined : PANE_SHAPE.split.closed.gap }}>
          {terminals}
          <aside className="tr-pane" data-collapsed={props.transcriptOpen ? undefined : 'true'} data-leaving={pane.leaving ? 'true' : undefined}>
            {pane.mounted && (
              <div ref={(el) => { pane.ref.current = el; }} className="tr-pane-inner">
                {/* 実行中は右ペインの上に「いま」を出し、目次は一番下に残す。終わった run では目次だけ。
                    目次は「いま」の有無にかかわらず LivePane の中の同じ位置に置き、作り直さない（スクロールの位置を保つ）。
                    前のセッションの「いま」は、別のセッションへ替えた描画では描かない。 */}
                <LivePane ref={live.ref} sessionId={id} pane={livePane} leaving={live.leaving} lead={paneToggle} split={props.livePaneSplit} artifacts={props.artifacts}>
                  <TurnIndex sessionId={id} runId={run.alive ? run.id : null} rows={props.turnRows} complete={props.turnsComplete} openItems={props.openTurnItems} turnJump={props.turnJump} hasMore={props.hasMore} loading={props.loading} pending={props.turnsPending} remaining={Math.max(props.total - props.loaded, 0)} agentId={props.agentId} lead={livePane ? undefined : paneToggle} />
                </LivePane>
              </div>
            )}
          </aside>
        </div>
      </div>
    );
  }

  // サブエージェントは、主線と 3 つまでなら帯に並べ、それより多ければ一覧にする。
  // 帯が横にあふれないようにするため。
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
      {/* 右の欄の開閉（⌘J）は、本文の面の右上のボタンでも行える。 */}
      {paneToggle}
    </div>
  );
  const transcript = <Transcript sessionId={id} items={props.items} hasMore={props.hasMore} loading={props.loading} follow={props.follow} live={props.live !== null} remaining={Math.max(props.total - props.loaded, 0)} find={props.find} jump={props.jump} hasNewer={props.hasNewer} />;

  // 終わった画面（E1）。
  // 本文の右に、要約、TODO、変更したファイルを上から積む。
  // 実行中の右は live-explainer の欄なので、ここだけに置く。
  return (
    <div className="screen session-screen">
      {header}
      <div ref={railRef} className="session-body" data-rail={props.transcriptOpen ? 'open' : 'closed'}>
        <section className="tr-sheet">{toggles}{transcript}</section>
        {pane.mounted && (
          <div className="session-rail-slot">
            <aside ref={(el) => { pane.ref.current = el; }} className="session-rail" aria-label="このセッションのまとめ">
              <SummaryPanel {...props} />
              <TodoPanel {...props} />
              <FilesPanel {...props} />
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 見出しの線の下の 24px の 1 行（B1）。
 * 状態と経過、モデル、コンテキスト、コスト、変更、ターン、開始、アーティファクト、作業ディレクトリを区切りで並べる。
 * 折り返さず、狭いときは作業ディレクトリから省く。
 */
function InfoLine(props: SessionProps) {
  const emit = useEmit();
  const run = props.run;
  const runFact = run ? `${RUN_KIND_LABEL[run.kind]} ${run.started}` : undefined;
  // ロックの文言は presenter が lock.label に組み立てている（「<PC 名> で実行中」「<PC 名> から応答がありません」）。
  // View は色だけを変える。
  const state: ReactNode = props.lock
    ? <span className="session-info-state" data-s="remote"><span className={props.lock.stale ? 'warn' : 'lock'}>{props.lock.label}</span> <span className="faint">最終確認 {props.lock.heartbeat}</span></span>
    : props.liveLabel
      ? <span className="session-info-state" data-s={props.live ?? undefined} title={runFact}>{props.liveLabel}</span>
      : props.remoteOnly
        ? <span className="session-info-state" data-s="remote">本文は他の PC にあります</span>
        : <span className="session-info-state" title={runFact}>終了 · {props.lastActivity}</span>;
  return (
    <div className="session-info">
      {state}
      {props.model && <span className="mono">{props.model}{props.effort ? ` · ${props.effort}` : ''}</span>}
      {/* コンテキストの使用率と推定コストは statusline の追記からしか届かない。
          追記を入れていなければずっと null なので、空の棒ではなく「未取得」と書く。0% と見分けが付かない見せ方にしない。 */}
      {props.contextPercent === null
        ? <span className="faint">コンテキスト 未取得</span>
        : (
          <span title="コンテキストの使用率">コンテキスト <span className="gauge-bar" role="meter" aria-label="コンテキストの使用率" aria-valuenow={props.contextPercent} aria-valuemin={0} aria-valuemax={100}>
            <span className="gauge-fill" data-high={props.contextPercent >= 80 ? 'true' : undefined} style={{ width: `${Math.max(0, Math.min(100, props.contextPercent))}%` }} />
          </span>{props.contextPercent}%</span>
        )}
      {props.cost ? <span className="mono"><RollingText key={`${props.id}:cost`} text={props.cost} /></span> : <span className="faint">コスト 未取得</span>}
      {props.contextPercent === null && !props.cost && <a className="hint-link" href={formatRoute({ name: 'settings' })} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: { name: 'settings' } }); }}>statusline を入れると出ます</a>}
      {props.filesChanged > 0 && <span>変更 <RollingText key={`${props.id}:files`} text={String(props.filesChanged)} /></span>}
      <span><RollingText key={`${props.id}:turns`} text={String(props.turns)} /> ターン · <RollingText key={`${props.id}:tokens`} text={props.tokens} /> トークン</span>
      <span>開始 {props.started}</span>
      {props.prUrl && <a href={props.prUrl} target="_blank" rel="noreferrer">PR</a>}
      {props.memo && <span className="session-info-memo" title={props.memo}>メモ：{props.memo}</span>}
      {props.fromScratch && <span title="再開しても作業ディレクトリはスクラッチのままです">スクラッチ</span>}
      {props.gone && <span>要約のみ</span>}
      {!props.hasTranscript && !props.gone && <span>本文がありません</span>}
      {/* 実行中で右の欄の「いま」が開いている間は、成果物はそこに並ぶので、この行には出さない。 */}
      {props.artifacts.length > 0 && !(props.livePane && props.transcriptOpen) && (
        <span>
          <MenuButton label="アーティファクト" faceClassName="session-info-link" minWidth={260} align="start"
            face={<><Icon name="artifacts" />アーティファクト {props.artifacts.length}<Icon name="chevronDown" /></>}
            items={props.artifacts.map((a) => ({ key: a.id, label: a.title, note: `最終公開 ${a.lastPublished}`, onSelect: () => emit({ type: 'artifact.open', id: a.id }) }))} />
        </span>
      )}
      <span className="session-info-cwd mono" title={props.cwd}>{props.cwd}</span>
    </div>
  );
}

/**
 * 要約の欄。
 * 見立てと何ターン時点か、作り直すボタン、本文、次にやること、出所を出す。
 * 要約の題は見出しの名前と重なるので出さない（C1）。
 */
function SummaryPanel(props: SessionProps) {
  const emit = useEmit();
  const s = props.summary;
  return (
    <section className="rail-panel">
      <h2 className="rail-h">
        <span>要約</span>
        {s && <span className="rail-n">{s.stateLabel} · {s.basedOnTurns} ターン時点</span>}
        {/* 本文が無いと作り直しは必ず失敗するので、消えた会話では出さない。 */}
        {!props.gone && <button type="button" className="btn btn-sm btn-ghost rail-act" aria-label="要約を作り直す" onClick={() => emit({ type: 'summary.regenerate', sessionId: props.id })}><Icon name="rebuild" />作り直す</button>}
      </h2>
      {props.summaryPending && <div className="rail-note">要約を作成しています</div>}
      {props.summaryError && <div className="rail-note" title={props.summaryError}>要約を作成できませんでした</div>}
      {s
        ? (
          <>
            <p className="sum-body">{s.body}</p>
            {s.nextSteps.length > 0 && <><div className="rail-sub">次にやること</div><ul className="sum-next">{s.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
            {/* 何がこの要約を書いたのかは、作り直すかどうかの判断に要る。
               土台の要約には要約器が無いので、そのときは要約器の札を出さない。 */}
            <div className="sum-src" data-testid="summary-source">出所 <span>{s.sourceLabel}</span>{s.summarizerLabel && <>、<span className="mono">{s.summarizerLabel}</span></>}、{s.generatedAt} 生成</div>
          </>
        )
        : <div className="faint">{props.gone ? '要約もありません' : '要約はまだありません'}</div>}
    </section>
  );
}

/**
 * TODO の欄。
 * そのセッションのプロジェクトの TODO を、プロジェクト画面と同じ並びで出す。
 * 足す欄はプロジェクト画面に任せる。
 */
function TodoPanel(props: SessionProps) {
  if (!props.projectId) return null;
  return (
    <section className="rail-panel">
      <h2 className="rail-h"><span>TODO</span><span className="rail-n">{props.todos.length}</span></h2>
      <TodoList projectId={props.projectId} todos={props.todos} canAdd={false} />
    </section>
  );
}

/**
 * 変更したファイルの欄。
 * 押すと VS Code で開く。
 * サーバはそのセッションが変えたファイルかを確かめてから開く。
 */
function FilesPanel(props: SessionProps) {
  const emit = useEmit();
  if (props.changedFiles.length === 0 && props.changedMore === 0) return null;
  return (
    <section className="rail-panel">
      <h2 className="rail-h"><span>変更したファイル</span><span className="rail-n">{props.changedFiles.length + props.changedMore}</span></h2>
      <ul className="changed-files">
        {props.changedFiles.map((f) => (
          <li key={f.path}>
            <button type="button" className="changed-file" title={`${f.path} を VS Code で開く`} onClick={() => emit({ type: 'session.openFile', sessionId: props.id, path: f.path })}>
              <Icon name={f.created ? 'fileNew' : 'fileEdited'} />
              <span className="changed-path mono"><span className="faint">{f.dir}</span>{f.base}</span>
              {f.created && <span className="changed-new">新規</span>}
              <span className="changed-add mono">+{f.added}</span>
              {f.removed > 0 && <span className="changed-del mono">−{f.removed}</span>}
            </button>
          </li>
        ))}
      </ul>
      {props.changedNote && <div className="rail-note">{props.changedNote}</div>}
    </section>
  );
}
