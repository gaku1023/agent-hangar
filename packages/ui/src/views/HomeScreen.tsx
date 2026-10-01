import { formatRoute, type Route } from '@agent-hangar/shared';
import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { AttentionCard, ConfirmCard, HomeProps, RunningCard } from '../presenters/home.ts';
import type { OnboardingProps } from '../presenters/onboarding.ts';
import { Onboarding } from './Onboarding.tsx';
import { PageHeading } from './PageHeading.tsx';
import { SESSION_ROW_H, SessionRows } from './SessionRows.tsx';
import { Icon } from './primitives/Icon.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

/**
 * 要対応の札のボタン。
 * その場では答えさせない。端末の TUI を外から操ることになって壊れやすいため、端末を開いてフォーカスする。
 * 引き取りは外のターミナルの claude を終わらせるので、押すと確認に回る（mediator の session.adopt）。
 * 端末を開く手が無いセッションは、端末を約束せずに開くだけにする。
 */
function AnswerButton(props: { card: AttentionCard }) {
  const emit = useEmit();
  const a = props.card;
  switch (a.answer) {
    case 'terminal': return <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.open', id: a.id, focus: 'terminal' })}>ターミナルで答える</button>;
    case 'attach': return <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.attach', id: a.id })}>ターミナルで答える</button>;
    case 'adopt': return <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.adopt', id: a.id })}>hangar で引き取る</button>;
    default: return <button type="button" className="btn" onClick={() => emit({ type: 'session.open', id: a.id })}>開く</button>;
  }
}

/** Home で一度に見せる最近とプロジェクトの行の数。多いときは一覧の中でスクロールする。 */
export const HOME_VISIBLE_ROWS = 10;

/** 確かめるで最初に見せる件数。残りは「ほか N 件を表示」の 1 行にまとめる（試作 home-lists の E1）。 */
export const CONFIRM_VISIBLE = 3;

/**
 * Home（管制盤）。
 * 上から要対応、実行中、確かめる、最近とプロジェクトの順に置く。
 * 要対応と確かめると実行中は、該当が無ければ区画ごと省く。
 * 何も動いていないとき（idle）は、実行中の札の場所に 1 行の文と新しいセッションのボタンを置く（F1）。
 */
export function HomeScreen(props: HomeProps & { onboarding?: OnboardingProps | null }) {
  const emit = useEmit();
  // セッションが 1 つも無いときは、準備の確認リストだけを出す（初回の A1）。ふだんの区画は出さない。
  if (props.onboarding) return <Onboarding {...props.onboarding} />;
  return (
    <div className="screen home">
      <PageHeading title="ホーム" />
      {props.attention.length > 0 && (
        <section>
          <h2 className="home-label">要対応<span className="home-count">{props.attention.length}</span></h2>
          {props.attention.map((a) => (
            <div key={a.id} className="ask-card">
              <StatusDot status="waiting" />
              <div className="ask-body">
                <div className="ask-title"><b>{a.name}</b> <span className="faint">· {a.projectName ?? '未分類'} · {a.waited}待っている{a.answer === 'terminal' || a.answer === 'attach' ? '' : ' · 外のターミナルで動いています'}</span></div>
                <div className="ask-q">{a.question}</div>
              </div>
              <AnswerButton card={a} />
            </div>
          ))}
        </section>
      )}
      {props.running.length > 0 && (
        <section>
          <h2 className="home-label">実行中<span className="home-count">{props.running.length}</span></h2>
          <div className="live-grid">
            {props.running.map((r) => <LiveCard key={r.id} card={r} onOpen={() => emit({ type: 'session.open', id: r.id })} />)}
          </div>
        </section>
      )}
      {props.idle && (
        <section>
          <div className="idle-line">
            <Icon name="nothingRunning" />
            <span className="idle-text">いま動いているセッションはありません</span>
            <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.new.open' })}><Icon name="add" />新しいセッション</button>
            <button type="button" className="btn" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="scratch" />スクラッチで始める</button>
          </div>
        </section>
      )}
      {props.confirm.length > 0 && <ConfirmSection cards={props.confirm} />}
      <div className="home-two">
        <section>
          <SectionHead title="最近" all={{ route: { name: 'sessions' }, label: 'すべてのセッションを見る' }} />
          <SessionRows rows={props.recent} height={Math.min(props.recent.length, HOME_VISIBLE_ROWS) * SESSION_ROW_H} variant="recent" autoFocus />
        </section>
        <section>
          <SectionHead title="プロジェクト" all={{ route: { name: 'projects' }, label: 'すべてのプロジェクトを見る' }} />
          <div className="list pj-list" style={{ maxHeight: HOME_VISIBLE_ROWS * SESSION_ROW_H }}>
            {props.projects.length === 0
              ? <div className="empty">Active なプロジェクトはありません。設定でワークスペースを確かめてください。</div>
              : props.projects.map((p) => (
                <button key={p.id} type="button" className="pj-row" onClick={() => emit({ type: 'project.open', id: p.id })}>
                  <span className="pj-dot" data-status={p.status} />
                  <span className="pj-name">{p.name}</span>
                  <span className="pj-counts">{p.counts}</span>
                </button>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * 区画の見出しと、右端の「すべて見る →」（試作 home-lists の H1）。
 * リンクは見出しの外に置く。見出しの名前にリンクの語が混ざると、読み上げで区画の名前が崩れるためである。
 * 見える語は短く「すべて見る」にし、読み上げの名前で行き先を言う。
 */
function SectionHead(props: { title: string; all: { route: Route; label: string } }) {
  const emit = useEmit();
  const { route, label } = props.all;
  return (
    <div className="home-head">
      <h2 className="home-label">{props.title}</h2>
      <a className="home-more" href={formatRoute(route)} aria-label={label} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: route }); }}>すべて見る<Icon name="seeAll" /></a>
    </div>
  );
}

/**
 * 確かめるの区画（試作 home-lists の E1）。
 * 最初の CONFIRM_VISIBLE 件だけを出し、残りは「ほか N 件を表示」の 1 行にまとめ、押すとその場で開く。
 * 開いているかどうかは画面の中だけの見え方なので、Mediator には置かない。
 */
function ConfirmSection(props: { cards: ConfirmCard[] }) {
  const emit = useEmit();
  const [open, setOpen] = useState(false);
  const rest = Math.max(0, props.cards.length - CONFIRM_VISIBLE);
  const shown = open ? props.cards : props.cards.slice(0, CONFIRM_VISIBLE);
  return (
    <section>
      <h2 className="home-label">確かめる<span className="home-count">{props.cards.length}</span></h2>
      {shown.map((c) => (
        <div key={c.id} className="ask-card confirm-card">
          <span className="cand-mark" aria-hidden="true" />
          <div className="ask-body">
            <div className="ask-title">
              <button type="button" className="confirm-open" onClick={() => emit({ type: 'project.open', id: c.projectId })}><b>{c.text}</b></button>
              {' '}<span className="faint">· {c.projectName} · {c.sessionName} · {c.ago}</span>
            </div>
            <div className="ask-q">{c.note}</div>
          </div>
          <button type="button" className="btn btn-primary" aria-label={`${c.text}（${c.projectName}）を確定`} onClick={() => emit({ type: 'todo.confirm', id: c.id })}>確定</button>
          <button type="button" className="btn" aria-label={`${c.text}（${c.projectName}）を却下`} onClick={() => emit({ type: 'todo.reject', id: c.id })}>却下</button>
        </div>
      ))}
      {rest > 0 && (
        <button type="button" className="more-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="more-chevron" data-open={open ? 'true' : undefined}><Icon name="chevronDown" /></span>
          ほか {rest} 件を{open ? '隠す' : '表示'}
        </button>
      )}
    </section>
  );
}

/** 実行中の札。いま何をしているかを墨の地の 1 行で見せ、コンテキストの使用率をゲージで出す。 */
function LiveCard(props: { card: RunningCard; onOpen: () => void }) {
  const c = props.card;
  const width = Math.max(0, Math.min(100, c.contextPercent ?? 0));
  return (
    <div className="live-card" role="button" tabIndex={0} data-morph-id={c.id} onClick={props.onOpen} onKeyDown={(e) => { if (e.key === 'Enter') props.onOpen(); }}>
      <div className="live-head"><StatusDot status={c.live} /><span className="live-name">{c.name}</span><span className="live-elapsed mono">{c.elapsed}</span></div>
      <div className="live-meta">{c.meta}</div>
      <div className="live-act mono">{c.activity ? <><i>{c.activity.tool}</i>{c.activity.summary !== '' && <> {c.activity.summary}</>}</> : <span className="live-note">{c.note}</span>}</div>
      <div className="live-ctx">
        コンテキスト
        <span className="gauge-bar" role="meter" aria-label="コンテキストの使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.contextPercent ?? undefined}>
          <span className="gauge-fill" data-high={c.contextPercent !== null && c.contextPercent >= 80 ? 'true' : undefined} style={{ width: `${width}%` }} />
        </span>
        {c.contextLabel}
      </div>
    </div>
  );
}
