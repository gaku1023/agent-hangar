import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useBackgroundEmit, useEmit } from '../action/chain.tsx';
import type { SessionAction, SessionActionId, SessionProps } from '../presenters/session.ts';
import { LeadCard } from './LeadCard.tsx';
import { NowCard } from './NowCard.tsx';
import { PageHeading } from './PageHeading.tsx';
import { SessionBadges } from './SessionBadges.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { ToggleChip } from './primitives/Chip.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { ariaKeyShortcuts, keyLabel, shortcutHint } from '../keys.ts';
import { Listbox } from './primitives/Listbox.tsx';
import { MenuButton, type MenuItem } from './primitives/MenuButton.tsx';
import { PANE_SHAPE, playPaneMotion } from './primitives/paneMotion.ts';
import { InfoPopover, type PopoverRow } from './primitives/Popover.tsx';
import { GitUnsafeNote } from './GitUnsafeNote.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { usePresence } from './primitives/usePresence.ts';
import { SplitPane } from './SplitPane.tsx';
import { TabStrip } from './TabStrip.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { TocPane, TocToggle } from './TocPane.tsx';
import { Transcript } from './Transcript.tsx';
import { TurnIndex } from './TurnIndex.tsx';
import { useNarrow } from './useNarrow.ts';

const ACTION_ICON: Record<SessionActionId, IconName> = {
  openEditor: 'openEditor', resume: 'resume', resumeHere: 'resumeHere', fork: 'fork', openTerminal: 'openTerminal',
  attach: 'shell', adopt: 'resumeHere', regenerate: 'rebuild', promote: 'promote', stop: 'stop',
};

/**
 * セッション画面（設計は docs/superpowers/specs/2026-10-09-stage4-screens-design.md の 2.3、試作は 2026-10-09-session-screen/options.html の C）。
 * 上から、見出しの段（点、名前、ロックの札、要約の 1 文、主の操作、「…」、(i)）、実行中ならタブの列、そして残りの高さを全部使う本体を置く。
 * 本体は左に主役（実行中はターミナル、終わった後は冒頭の 1 枚つきのトランスクリプト）、右に 240px の列を置く。
 * 実行中は、右の列の上に現在の札（NowCard）、その下に目次を積む。終わった後は目次だけである。
 * 右の列は札も目次もひとまとめに、⌘J と列の右上のボタンで畳める。畳むと列が 0px になり、本文（ターミナル）が右端まで広がる。
 * 畳むボタンは、タブの列のある画面では右の列の頭の行（タブの列と同じ高さ、2026-10-12 の試作の A）の右端に、タブの列の無い画面では目次の見出しの行の右端に置く。
 * 畳むと、同じ右上の場所に、タブの列（終わった後は切り替えの行）の「目次 N」の札が出る。開閉はセッションごとに覚える（sessionView.transcriptOpen）。
 * 窓が狭いとき（useNarrow）は、右の列を持たず、札を押すと札と目次が上に重なって開く（上乗せの頭の行が札の場所を覆う）。
 */
export function SessionScreen(props: SessionProps) {
  const emit = useEmit();
  const t = useT();
  const reasonId = useId();
  // 目次の開閉。狭い窓では列にせず、札から開く上乗せ（drawer）にする。はじめは閉じている。
  // フックなので、下の早い return より前に置く。
  const narrow = useNarrow();
  const [drawer, setDrawer] = useState(false);
  // 開いているセッションの git を取ってもらい（git の表示）、(i) の「このセッションの変更」のために差分の一覧も読む。
  // 作業ツリーの件数が替わったら、一覧も読み直す。
  const gitCount = props.git?.chip?.count ?? null;
  const bg = useBackgroundEmit();
  useEffect(() => {
    bg({ type: 'git.watch', key: 'session', sessionIds: [props.id] });
    return () => bg({ type: 'git.watch', key: 'session', sessionIds: [] });
  }, [bg, props.id]);
  const hasGit = props.git != null;
  useEffect(() => { if (hasGit) bg({ type: 'git.changes.load', sessionId: props.id }); }, [bg, props.id, gitCount, hasGit]);
  const tocOpen = narrow ? drawer : props.transcriptOpen;
  // 現在の札は生きた run があるときだけ。札は目次と同じ右の列に入っていて、列ごと畳まれる。
  const hasCard = props.strip !== null && props.run?.alive === true;
  // ⌘J（transcript.toggle）は、狭い窓では上乗せの開閉にする。セッションが替わった描画は切り替えなので、開閉とは見なさない。
  const seen = useRef({ id: props.id, open: props.transcriptOpen });
  useEffect(() => {
    const was = seen.current;
    seen.current = { id: props.id, open: props.transcriptOpen };
    if (was.id !== props.id) { setDrawer(false); return; }
    if (was.open !== props.transcriptOpen && narrow) setDrawer((d) => !d);
  }, [props.id, props.transcriptOpen, narrow]);
  // 右の列の開閉。閉じる動きが終わるまで中身を描き続け、開いたら滑らせて広げる。
  // 開閉はセッションごとに覚えているので、別のセッションへ替えると開閉も替わることがある。それは切り替えなので動かさず、すぐその形にする。
  // 最後に描き終えたセッションを覚えておき、替わった描画では開く動きも閉じる動きも出さない。
  const boxRef = useRef<HTMLDivElement>(null);
  const paneSession = useRef(props.id);
  const pane = usePresence<HTMLElement>(tocOpen, (inner) => (!narrow && paneSession.current === props.id && boxRef.current ? playPaneMotion(boxRef.current, PANE_SHAPE.toc.open, inner, false) : null));
  const paneFirst = useRef(true);
  useLayoutEffect(() => {
    if (paneFirst.current) { paneFirst.current = false; return; }
    if (paneSession.current !== props.id) return;
    if (!narrow && tocOpen && boxRef.current) void playPaneMotion(boxRef.current, PANE_SHAPE.toc.closed, pane.ref.current, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocOpen]);
  // 上の 2 つ（usePresence の中のものも含む）が今の描画を見終えてから、描き終えたセッションを書き換える。
  useLayoutEffect(() => { paneSession.current = props.id; });
  if (props.notFound) return <div className="screen"><div className="empty">{t('session.error.notFound')}</div></div>;
  // run は知っているのに、そのセッションの情報がまだ届いていない状態。
  if (props.loadingSession) return <div className="screen"><div className="empty">{t('session.screen.loading')}</div></div>;
  const id = props.id;
  const run = props.run;

  const act = (a: SessionActionId) => {
    switch (a) {
      case 'openEditor': emit({ type: 'session.openEditor', sessionId: id }); return;
      case 'resume': emit({ type: 'session.resume', id }); return;
      // 確認の 1 枚（前の PC とこの PC）を出してから写す。確認に出すものは Mediator が取りに行く。
      case 'resumeHere': emit({ type: 'session.resumeHere.open', id }); return;
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
      case 'stop': if (run) emit({ type: 'session.kill', runId: run.id, working: props.live === 'busy' || props.live === 'waiting', aside: props.aside, shellTabs: props.tabs.filter((t) => t.kind === 'shell').length }); return;
    }
  };
  const item = (a: SessionAction): MenuItem => ({ key: a.id, label: a.label, icon: ACTION_ICON[a.id], note: a.note, disabled: a.disabled, danger: a.danger, onSelect: () => act(a.id) });
  const primary = props.actions.primary;
  // 行の操作（差分の一覧など）はダイアログを開くので、先に (i) の面を閉じる（ダイアログの上に面を残さない）。
  const detailRows = (api: { close: () => void }): PopoverRow[] => props.details.map((d) => ({
    name: d.name,
    value: (
      <>
        {d.dot && <span className="st-dot" style={{ color: d.dot }} aria-hidden="true" />}{d.value}
        {d.note && <span className="faint detail-note"> {d.note}</span>}
        {d.link && <> <button type="button" className="btn-link" onClick={() => { api.close(); emit(d.link!.send); }}>{d.link.label}</button></>}
      </>
    ),
    mono: d.mono,
  }));

  // この PC にプロジェクトのフォルダが無いほかの PC の会話。「この PC で再開」を押せない理由を見出しの下に常に出し、同じ行に場所の指定を置く（試作の 1a）。
  const noRoot = props.noRoot ?? null;
  const noRootLine = noRoot ? (
    <div className="session-reason" role="note">
      <Icon name="info" /><span>{noRoot.reason}</span>
      <button type="button" className="btn-link" onClick={() => emit({ type: 'project.resolve.open', id: noRoot.projectId })}>{t('session.action.setLocation')}</button>
    </div>
  ) : null;
  const header = (
    // 見出しの行。
    // 一覧の行や Home の札から開くと、その行がここへ広がる（runtime/present.ts が data-morph-hero を探す）。
    // 名前は見出しにだけ出し、要約の題は出さない（C1）。
    // 名前の横に、他の PC で実行中の札（操作できない理由なので隠さない）。右端の (i) に、毎回は見ない属性を入れる。
    // 操作は状態に合う 1 つだけを主にし、残りは「…」に入れる（A1）。
    <PageHeading title={props.name} parent={props.parent} lead={<StatusDot status={props.live} aside={props.aside} reason={props.reason ?? null} />} titleClassName="session-name" rowClassName="session-hero" hero={id} below={noRootLine}>
      <SessionBadges badges={props.badges} />
      {props.oneLiner ? <span key={props.oneLiner} className="session-oneliner" title={props.oneLiner}>{props.oneLiner}</span> : <span className="spacer" />}
      {/* 押せない主の操作は、乗せても読み上げでも理由が分かるように、disabled ではなく aria-disabled にする。 */}
      <button type="button" className="btn btn-primary" aria-disabled={primary.disabled ? 'true' : undefined} title={primary.disabled ?? primary.note ?? undefined}
        aria-describedby={primary.disabled ? reasonId : undefined} onClick={() => { if (!primary.disabled) act(primary.id); }}>
        <Icon name={ACTION_ICON[primary.id]} /><span className="btn-label">{primary.label}</span>
      </button>
      {primary.disabled && <span id={reasonId} className="sr-only">{primary.disabled}</span>}
      <MenuButton label={t('session.screen.moreActions')} items={props.actions.menu.map(item)} />
      <InfoPopover rows={detailRows} width={360}>{props.gitFix ? <GitUnsafeNote command={props.gitFix} /> : null}</InfoPopover>
    </PageHeading>
  );

  // 目次の数。見出しと同じ数（props.turnCount）で、届くまでは数を添えない。
  const tocCount = props.turnCount ? `${props.turnCount.n}${props.turnCount.plus ? '+' : ''}` : null;
  const toggleToc = () => (narrow ? setDrawer((d) => !d) : emit({ type: 'transcript.toggle' }));
  // タブの列があるか（生きた run か、終わった run のタブを見ている）。あれば本体の 1 行目に入れ、右の列はその行から始める。
  const withStrip = Boolean(run && props.selectedTab);
  // 閉じている間は、タブの列（終わった後は切り替えの行）の右端に「目次 N」の札を置く。開いている間は、同じ右上の TocToggle を使う。
  // 現在の札も中に畳まれているので、札のある間はその状態の点を添える。
  const opener = (
    <button type="button" className="btn btn-sm tab-pane-open" aria-expanded="false" aria-keyshortcuts={ariaKeyShortcuts('transcript.toggle')} title={t('session.toc.shortcut', { keys: shortcutHint(t, 'transcript.toggle', '⌘J') })} onClick={toggleToc}>
      {hasCard && props.strip && <span className="live-dot" data-tone={props.strip.tone} aria-hidden="true" />}
      <Icon name="paneOpen" /><span>{tocCount === null ? t('session.toc.label') : t('session.toc.opener', { n: tocCount })}</span>{!narrow && <kbd className="mono">{keyLabel('⌘J')}</kbd>}
    </button>
  );
  // 右の列（畳める器）。実行中は上に現在の札、下に目次（TurnIndex）。終わった後は目次だけを、同じ場所に置く。
  // タブの列のある画面では、列の上端にタブの列と同じ高さの頭の行を置き、右端に畳むボタンを置く（札にも目次にも属さない）。
  const toggle = <TocToggle open onToggle={toggleToc} />;
  const toc = (
    <div className="toc-slot" data-collapsed={tocOpen ? undefined : 'true'} data-leaving={pane.leaving ? 'true' : undefined} data-drawer={narrow ? 'true' : undefined}>
      {pane.mounted && (
        <div ref={(el) => { pane.ref.current = el; }} className="toc-slot-inner">
          {withStrip && <div className="toc-slot-head">{!narrow && <kbd className="mono">{keyLabel('⌘J')}</kbd>}{toggle}</div>}
          {/* 現在の札はタブにもターミナルにもくっつけず、右の列の上に置く（中身はセッションのもので、タブを替えても変わらない）。 */}
          {hasCard && props.strip && <NowCard sessionId={id} {...props.strip} overlap={props.overlap ?? null} git={props.git} />}
          <TocPane>
            <TurnIndex sessionId={id} runId={run?.alive ? run.id : null} rows={props.turnRows} complete={props.turnsComplete} openItems={props.openTurnItems} turnJump={props.turnJump} hasMore={props.hasMore} loading={props.loadingOlder} count={props.turnCount} pending={props.turnsPending} agentId={props.agentId} trail={withStrip ? undefined : toggle} />
          </TocPane>
        </div>
      )}
    </div>
  );
  const bodyStyle = narrow ? undefined : { gridTemplateColumns: tocOpen ? PANE_SHAPE.toc.open.cols : PANE_SHAPE.toc.closed.cols, columnGap: tocOpen ? undefined : PANE_SHAPE.toc.closed.gap };

  // 本文が消えた会話は、会話の欄も目次も持たない。
  // 残っている冒頭の 1 枚（要約、ノートなど）だけを見せる。
  if (props.gone) {
    return (
      <div className="screen session-screen">
        {header}
        <div className="session-body" data-gone="true">
          <div className="gone-note" role="note">
            {props.gone.note}
            {props.gone.canExtend && <> <button type="button" className="btn-link" onClick={() => emit({ type: 'retention.edit', days: props.gone!.extendTo, from: 'session' })}>{t('session.screen.extendRetention')}</button></>}
          </div>
          {props.lead && <LeadCard sessionId={id} {...props.lead} git={props.git} />}
        </div>
      </div>
    );
  }

  if (run && props.selectedTab) {
    // 案内と transcript の帯は Claude のタブにだけ出す。
    // 分割で 2 つ並ぶときも、シェルの側には出さない。
    const terminal = (tabId: string) => {
      const agentTab = tabId === run.id;
      const hint = agentTab && props.trustHint ? t('session.screen.trustHint') : agentTab && !run.alive ? t('session.screen.endedHint') : null;
      const transcript = agentTab && run.alive && props.transcriptBand ? { when: props.transcriptBand.when, onLatest: () => emit({ type: 'turn.latest', sessionId: id, runId: run.id }) } : null;
      return <TerminalPane key={tabId} tabId={tabId} hint={hint} live={props.live} aside={props.aside} reason={props.reason ?? null} agent={agentTab} transcript={transcript} />;
    };
    // 分割は .c-main の中でさらに 2 列に割る。高さは .c-main から 100% で伝わる。
    const terminals = props.split ? <SplitPane left={terminal(props.split.left)} right={terminal(props.split.right)} /> : terminal(props.selectedTab);
    return (
      <div className="screen session-screen">
        {header}
        {/* 右は会話の全文ではなくターンの目次にする。
            全文は左のターミナルと重なるので、押したターンだけを開き、左もそこへ跳ばす。
            .c-body は縦の flex で窓の残りの高さを全部受け取る（session.css）。
            タブの列は本体の 1 行目に入れ、右の列はその行から下端までを占める。列の頭の畳むボタンと、畳んだ後の「目次 N」が同じ右上に来る。 */}
        <div ref={boxRef} className="c-body" data-strip="true" data-folded={tocOpen ? undefined : 'true'} data-narrow={narrow ? 'true' : undefined} style={bodyStyle}>
          <TabStrip sessionId={id} tabs={props.tabs} canAdd={run.alive} canSplit={props.canSplit} split={props.split !== null} trailing={tocOpen ? null : opener} />
          <div className="c-main">{terminals}</div>
          {toc}
        </div>
      </div>
    );
  }

  // サブエージェントは、メイン会話と 3 つまでなら帯に並べ、それより多ければ一覧にする。
  // 帯が横にあふれないようにするため。
  const agentOptions = [{ value: '', label: t('session.screen.mainConversation') }, ...props.subagents.map((a) => ({ value: a, label: a }))];
  const selectAgent = (v: string) => emit({ type: 'transcript.selectAgent', sessionId: id, agentId: v || null });
  const toggles = (
    <div className="transcript-toggles">
      <ToggleChip label={t('session.screen.thinkingLabel')} text={t('session.screen.thinkingText')} icon="thinking" pressed={props.showThinking} onChange={(show) => emit({ type: 'transcript.showThinking', sessionId: id, show })} />
      <ToggleChip label={t('session.transcript.rawToggleLabel')} text={t('session.transcript.rawToggle')} icon="rawLog" pressed={props.showRaw} onChange={(show) => emit({ type: 'transcript.showRaw', sessionId: id, show })} />
      {props.subagents.length > 0 && <span className="transcript-toggles-sep" aria-hidden="true" />}
      {props.subagents.length > 0 && (props.subagents.length <= 3
        ? <Segmented label={t('session.screen.subagents')} value={props.agentId ?? ''} options={agentOptions.map((o) => (o.value ? { ...o, lead: <Icon name="agent" /> } : o))} onChange={selectAgent} />
        : <Listbox label={t('session.screen.subagents')} value={props.agentId ?? ''} options={agentOptions.map((o) => (o.value ? { ...o, label: t('session.toc.subagent', { id: o.value }), icon: 'agent' as const } : o))} onChange={selectAgent} faceClassName="listbox-face listbox-pill" minWidth={260} />)}
      <span className="spacer" /><span className="faint mono">{props.loaded} / {props.total}</span>
      {/* 目次は閉じている間だけ、ここに「目次 N」の札を置く（⌘J でも開閉できる）。 */}
      {props.hasTranscript && !tocOpen && opener}
    </div>
  );
  // 冒頭の 1 枚は、トランスクリプトの先頭（スクロールの内側）に置く。
  const head: ReactNode = props.lead ? <LeadCard sessionId={id} {...props.lead} git={props.git} /> : null;
  const transcript = <Transcript sessionId={id} items={props.items} hasMore={props.hasMore} loading={props.loading} follow={props.follow} live={props.live !== null} remaining={Math.max(props.total - props.loaded, 0)} jump={props.jump} hasNewer={props.hasNewer} head={head} />;

  // 終わった画面。
  // 本文の右に、実行中と同じ目次を置く。要約、変更したファイル、アーティファクト、PR、ノートは本文の先頭の 1 枚にある。
  return (
    <div className="screen session-screen">
      {header}
      <div ref={boxRef} className="c-body" data-narrow={narrow ? 'true' : undefined} data-toc={props.hasTranscript ? undefined : 'none'} style={props.hasTranscript ? bodyStyle : undefined}>
        <div className="c-main"><section className="tr-sheet">{toggles}{transcript}</section></div>
        {props.hasTranscript && toc}
      </div>
    </div>
  );
}
