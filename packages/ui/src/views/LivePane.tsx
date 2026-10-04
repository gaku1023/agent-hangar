import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { clampLivePaneSplit, LIVE_PANE_SPLIT_DEFAULT } from '../mediator/sidebar.ts';
import type { LivePaneProps } from '../presenters/live.ts';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { Icon } from './primitives/Icon.tsx';

/** 比率は 1% 単位で持つ。保存する値と読み上げの数をそろえる。 */
const round = (r: number) => Math.round(clampLivePaneSplit(r) * 100) / 100;

/**
 * 実行中のセッションの右ペイン。上の段ほど横目で読む情報で、目次（children）は下の段に置く。
 * 左のターミナルに映らないもの（何のためか、サブエージェント 1 本ずつの様子、成果物）を出す。
 * 上の段の高さは、境目の比率（split）を上限にし、あふれた分は上の段の中でスクロールする。中身が短ければ、残りは目次に回る。
 * ドラッグの途中は比率をここだけで持ち、離したときに 1 度だけ livePane.split を出す（毎フレーム状態機械を回さない）。
 */
export function LivePane({ sessionId, pane, lead, children, split = LIVE_PANE_SPLIT_DEFAULT, artifacts = [] }: { sessionId: string; pane: LivePaneProps; lead?: ReactNode; children: ReactNode; split?: number; artifacts?: ArtifactCardProps[] }) {
  const emit = useEmit();
  const liveRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  // 上の段が上限で切れていて、下に続きがあるか。あるときだけ下の端をぼかし、中でスクロールできることを見せる。
  const topRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => { const t = topRef.current; if (t) setMore(t.scrollHeight - t.scrollTop - t.clientHeight > 2); };
  useLayoutEffect(measure);
  useEffect(() => {
    const t = topRef.current;
    if (!t || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(t);
    return () => ro.disconnect();
  }, []);
  const ratio = dragging ?? split;
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const host = liveRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    let last = ratio;
    const move = (ev: globalThis.PointerEvent) => { last = round((ev.clientY - rect.top) / rect.height); setDragging(last); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDragging(null); emit({ type: 'livePane.split', ratio: last }); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    emit({ type: 'livePane.split', ratio: round(split + (e.key === 'ArrowUp' ? -0.02 : 0.02)) });
  };
  const percent = Math.round(ratio * 100);
  return (
    <div ref={liveRef} className="live" data-dragging={dragging !== null ? 'true' : undefined} style={{ '--live-split': String(ratio) } as CSSProperties}>
      {/* 見出し（右欄を畳むボタンを含む）は上の段のスクロールに入れず、いつも見えるところに置く。 */}
      <div className="live-pane-head">{lead}<span className="faint">いま</span></div>
      <div ref={topRef} className="live-top" data-more={more ? 'true' : undefined} onScroll={measure}>
        <div className="live-lamp" data-tone={pane.lamp.tone}>
          <span className="live-dot" data-tone={pane.lamp.tone} />
          <span className="live-lamp-head">{pane.lamp.head}</span>
          {pane.lamp.sub && <span className="live-lamp-sub">{pane.lamp.sub}</span>}
        </div>
        {pane.intent.kind === 'said'
          ? <div className="live-intent" data-stale={pane.intent.stale ? 'true' : undefined}>「{pane.intent.text}」<span className="live-intent-meta">{pane.intent.meta}</span></div>
          : <div className="live-intent-none">{pane.intent.text}</div>}
        {pane.steps.length > 0 && (
          <section className="live-sec">
            <div className="live-label">指揮役の手</div>
            {pane.steps.map((s, i) => (
              <div key={i} className="live-step" data-mark={s.mark}>
                <span className="live-step-ic">{s.mark === 'fail' ? '✕' : s.mark === 'now' ? <span className="live-dot" data-tone="busy" /> : '✓'}</span>
                <span className={s.mono ? 'live-step-text mono' : 'live-step-text'}>{s.text}</span>
                <span className="live-step-when mono">{s.when}</span>
              </div>
            ))}
          </section>
        )}
        {pane.lanes.length > 0 && (
          <section className="live-sec">
            <div className="live-label">サブエージェント</div>
            {pane.lanes.map((l) => (
              <button key={l.agentId} className="live-lane" data-tone={l.tone} disabled={!l.selectable} title={l.title}
                onClick={() => emit({ type: 'transcript.selectAgent', sessionId, agentId: l.agentId })}>
                <span className="live-dot" data-tone={l.tone} />
                <span className="live-lane-title">{l.title}</span>
                <span className="live-lane-time num">{l.elapsed}</span>
                <span className="live-lane-line">{l.quoted ? `「${l.line}」` : l.line}</span>
              </button>
            ))}
            {pane.doneFolded > 0 && <span className="live-chip">済 {pane.doneFolded}</span>}
          </section>
        )}
        {/* 成果物は作業中に何度も見るものではないので、上の段の終わりに題名だけの 1 行ずつ置く。押すと既定のブラウザで開く。 */}
        {artifacts.length > 0 && (
          <section className="live-sec">
            <div className="live-label">成果物</div>
            {artifacts.map((a) => (
              <div key={a.id} className="live-artifact">
                <button className="live-artifact-open" title={a.description ?? a.title} onClick={() => emit({ type: 'artifact.open', id: a.id })}>
                  <span className="live-artifact-icon" aria-hidden="true">{a.favicon}</span>
                  <span className="live-artifact-title">{a.title}</span>
                  <span className="live-artifact-when">{a.lastPublished}</span>
                </button>
                {a.canOpenEditor && <button className="btn btn-sm live-artifact-editor" aria-label={`${a.title} を VS Code で開く`} title="VS Code で開く" onClick={() => emit({ type: 'artifact.openEditor', id: a.id })}><Icon name="openEditor" /></button>}
              </div>
            ))}
          </section>
        )}
      </div>
      {/* 上の段と目次の境目。ドラッグか上下の矢印で動かし、ダブルクリックで半分に戻す。 */}
      <div className="live-divider" role="separator" aria-label="「いま」と目次の高さ" aria-orientation="horizontal"
        aria-valuenow={percent} aria-valuemin={20} aria-valuemax={80} aria-valuetext={`「いま」${percent}%`} tabIndex={0}
        onPointerDown={onPointerDown} onKeyDown={onKeyDown} onDoubleClick={() => emit({ type: 'livePane.split', ratio: LIVE_PANE_SPLIT_DEFAULT })} />
      <div className="live-toc">{children}</div>
    </div>
  );
}
