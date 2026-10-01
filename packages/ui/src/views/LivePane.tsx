import type { ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { LivePaneProps } from '../presenters/live.ts';

/**
 * 実行中のセッションの右ペイン。上の段ほど横目で読む情報で、目次（children）だけがスクロールする。
 * 左のターミナルに映らないもの（何のためか、サブエージェント 1 本ずつの様子）を出す。
 */
export function LivePane({ sessionId, pane, lead, children }: { sessionId: string; pane: LivePaneProps; lead?: ReactNode; children: ReactNode }) {
  const emit = useEmit();
  return (
    <div className="live">
      <div className="live-top">
        <div className="live-pane-head">{lead}<span className="faint">いま</span></div>
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
                <span className="live-lane-time mono">{l.elapsed}</span>
                <span className="live-lane-line">{l.quoted ? `「${l.line}」` : l.line}</span>
              </button>
            ))}
            {pane.doneFolded > 0 && <span className="live-chip">済 {pane.doneFolded}</span>}
          </section>
        )}
      </div>
      <div className="live-toc">{children}</div>
    </div>
  );
}
