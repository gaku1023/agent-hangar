import { useEmit } from '../intent/chain.tsx';
import type { HomeProps, RunningCard } from '../presenters/home.ts';
import { SESSION_ROW_H, SessionRows } from './SessionRows.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

/** Home で一度に見せる最近とプロジェクトの行の数。多いときは一覧の中でスクロールする。 */
export const HOME_VISIBLE_ROWS = 10;

/**
 * Home（管制盤）。
 * 上から要対応、実行中、最近とプロジェクトの順に置く。
 * 要対応と実行中は、該当が無ければ区画ごと省く。
 */
export function HomeScreen(props: HomeProps) {
  const emit = useEmit();
  return (
    <div className="screen home">
      {props.attention.length > 0 && (
        <section>
          <h2 className="home-label">要対応<span className="home-count">{props.attention.length}</span></h2>
          {props.attention.map((a) => (
            <div key={a.id} className="ask-card">
              <StatusDot status="waiting" />
              <div className="ask-body">
                <div className="ask-title"><b>{a.name}</b> <span className="faint">· {a.projectName ?? '未分類'} · {a.waited}待っている{a.canAnswer ? '' : ' · 別のターミナルで動いています'}</span></div>
                <div className="ask-q">{a.question}</div>
              </div>
              {/* その場では答えさせない。端末の TUI を外から操ることになって壊れやすいため、端末を開いてフォーカスする。 */}
              {/* hangar の run が無いセッションは端末を開けないので、端末を約束せずに開くだけにする。 */}
              {a.canAnswer
                ? <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.open', id: a.id, focus: 'terminal' })}>ターミナルで答える</button>
                : <button type="button" className="btn" onClick={() => emit({ type: 'session.open', id: a.id })}>開く</button>}
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
      <div className="home-two">
        <section>
          <h2 className="home-label">最近</h2>
          <SessionRows rows={props.recent} height={Math.min(props.recent.length, HOME_VISIBLE_ROWS) * SESSION_ROW_H} variant="recent" />
        </section>
        <section>
          <h2 className="home-label">プロジェクト</h2>
          <div className="list pj-list" style={{ maxHeight: HOME_VISIBLE_ROWS * SESSION_ROW_H }}>
            {props.projects.length === 0
              ? <div className="empty">active なプロジェクトはありません。Settings でワークスペースを確かめてください。</div>
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

/** 実行中の札。いま何をしているかを墨の地の 1 行で見せ、文脈の使用率をゲージで出す。 */
function LiveCard(props: { card: RunningCard; onOpen: () => void }) {
  const c = props.card;
  const width = Math.max(0, Math.min(100, c.contextPercent ?? 0));
  return (
    <div className="live-card" role="button" tabIndex={0} onClick={props.onOpen} onKeyDown={(e) => { if (e.key === 'Enter') props.onOpen(); }}>
      <div className="live-head"><StatusDot status={c.live} /><span className="live-name">{c.name}</span><span className="live-elapsed mono">{c.elapsed}</span></div>
      <div className="live-meta">{c.meta}</div>
      <div className="live-act mono">{c.activity ? <><i>{c.activity.tool}</i>{c.activity.summary !== '' && <> {c.activity.summary}</>}</> : <span className="live-note">{c.note}</span>}</div>
      <div className="live-ctx">
        文脈
        <span className="gauge-bar" role="meter" aria-label="文脈の使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.contextPercent ?? undefined}>
          <span className="gauge-fill" data-high={c.contextPercent !== null && c.contextPercent >= 80 ? 'true' : undefined} style={{ width: `${width}%` }} />
        </span>
        {c.contextLabel}
      </div>
    </div>
  );
}
