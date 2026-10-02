import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { clampLivePaneSplit, LIVE_PANE_SPLIT_DEFAULT } from '../mediator/sidebar.ts';
import type { LivePaneProps, StepRowProps } from '../presenters/live.ts';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { Icon } from './primitives/Icon.tsx';
import { motionEase, motionMs, motionValue } from './primitives/motion.ts';
import { motionOn, popMark, riseIn } from './primitives/motionKit.ts';
import { useMotionList } from './primitives/useMotionList.ts';

/** 離したとき、どちらかの端の下限までこれより近ければ、その端へ畳む（設計書 ④）。 */
const SNAP_PX = 24;

/** 離したときの比率。上の段か目次が下限まで SNAP_PX 以内なら、0 か 1 に畳む。高さが測れなければそのまま。 */
export function snapSplit(ratio: number, m: { height: number; topMin: number; tocMin: number }, snapPx = SNAP_PX): number {
  if (m.height <= 0) return ratio;
  const top = ratio * m.height;
  if (top - m.topMin < snapPx) return 0;
  if (m.height - top - m.tocMin < snapPx) return 1;
  return ratio;
}

/** 比率は 1% 単位で持つ。保存する値と読み上げの数をそろえる。 */
const round = (r: number) => Math.round(clampLivePaneSplit(r) * 100) / 100;

/**
 * 意図の箱（設計書 ⑤、案 A「入れ替え」）。
 * 文が替わったら、古い文は箱の中に重ねて上へ抜けながら薄れ、新しい文は --dur-exit の半分だけ遅れて入る。箱の高さは古い高さから滑る。
 * 最初の描画と、動かない環境では何もしない。
 */
function IntentBox({ text, meta, stale }: { text: string; meta: string; stale: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<{ text: string; meta: string; h: number } | null>(null);
  const [ghost, setGhost] = useState<{ text: string; meta: string } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const was = prev.current;
    prev.current = { text, meta, h: el.offsetHeight };
    if (!was || was.text === text || !motionOn(el)) return;
    setGhost({ text: was.text, meta: was.meta });
    el.animate([{ height: `${was.h}px` }, { height: `${el.offsetHeight}px` }], { duration: motionMs('--dur', el), easing: motionEase('--ease-out', el) });
    for (const c of el.querySelectorAll<HTMLElement>(':scope > .live-intent-now')) riseIn(c, motionMs('--dur-exit', el) / 2);
  }, [text]);
  // 控えは上へ抜けながら薄れ、終わったら外す。
  useLayoutEffect(() => {
    const g = ref.current?.querySelector<HTMLElement>('.live-intent-ghost');
    if (!g || typeof g.animate !== 'function') return;
    const a = g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(calc(${motionValue('--rise', g)} * -1))`, filter: `blur(${motionValue('--blur-in', g)})` }], { duration: motionMs('--dur-exit', g), easing: motionEase('--ease-in', g), fill: 'forwards' });
    let alive = true;
    a.finished.then(() => { if (alive) setGhost(null); }, () => {});
    return () => { alive = false; };
  }, [ghost]);
  return (
    <div ref={ref} className="live-intent" data-stale={stale ? 'true' : undefined}>
      <span className="live-intent-now">「{text}」<span className="live-intent-meta">{meta}</span></span>
      {ghost && <span className="live-intent-ghost" aria-hidden="true">「{ghost.text}」<span className="live-intent-meta">{ghost.meta}</span></span>}
    </div>
  );
}

/** 指揮役の手の 1 行。「いま」だった手が済むか失敗したら、印を 1 度だけ膨らませる。 */
function StepRow({ s, rowRef, leaving }: { s: StepRowProps; rowRef: (el: HTMLElement | null) => void; leaving: boolean }) {
  const ic = useRef<HTMLSpanElement>(null);
  const prev = useRef(s.mark);
  useLayoutEffect(() => {
    if (prev.current === 'now' && s.mark !== 'now' && ic.current) popMark(ic.current);
    prev.current = s.mark;
  }, [s.mark]);
  return (
    <div ref={rowRef} className="live-step" data-mark={s.mark} aria-hidden={leaving ? 'true' : undefined}>
      <span ref={ic} className="live-step-ic">{s.mark === 'fail' ? '✕' : s.mark === 'now' ? <span className="live-dot" data-tone="busy" /> : '✓'}</span>
      <span className={s.mono ? 'live-step-text mono' : 'live-step-text'}>{s.text}</span>
      <span className="live-step-when mono">{s.when}</span>
    </div>
  );
}

/**
 * 実行中のセッションの右ペイン。上の段ほど横目で読む情報で、目次（children）は下の段に置く。
 * 左のターミナルに映らないもの（何のためか、サブエージェント 1 本ずつの様子、成果物）を出す。
 * 上の段の高さは境目の比率（split）そのもので、中身が短ければ下に余白が残る。あふれた分は上の段の中でスクロールする。
 * どちらの端へも、見出しの 1 行を残す所まで引ける。
 * ドラッグの途中は比率をここだけで持ち、離したときに 1 度だけ livePane.split を出す（毎フレーム状態機械を回さない）。
 */
export function LivePane({ sessionId, pane, lead, children, split = LIVE_PANE_SPLIT_DEFAULT, artifacts = [] }: { sessionId: string; pane: LivePaneProps; lead?: ReactNode; children: ReactNode; split?: number; artifacts?: ArtifactCardProps[] }) {
  const emit = useEmit();
  // 手、レーン、成果物の出入り。セッションを替えたときは別のものなので動かさない（scope）。
  const steps = useMotionList(pane.steps, (s) => s.key, { enter: 'grow', scope: sessionId });
  const lanes = useMotionList(pane.lanes, (l) => l.agentId, { enter: 'grow', scope: sessionId });
  const arts = useMotionList(artifacts, (a) => a.id, { enter: 'grow', hit: true, scope: sessionId });
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
    const top = topRef.current;
    if (!host || !top) return;
    const rect = host.getBoundingClientRect();
    // 比率は上の段の上端から測る（上の段の高さが、ドラッグした所になる）。
    const topStart = top.getBoundingClientRect().top;
    let last = ratio;
    const move = (ev: globalThis.PointerEvent) => { last = round((ev.clientY - topStart) / rect.height); setDragging(last); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const toc = host.querySelector<HTMLElement>('.live-toc');
      const lamp = host.querySelector<HTMLElement>('.live-lamp');
      const tocMin = toc ? parseFloat(getComputedStyle(toc).minHeight) || 0 : 0;
      setDragging(null);
      emit({ type: 'livePane.split', ratio: snapSplit(last, { height: rect.height, topMin: lamp?.offsetHeight ?? 0, tocMin }) });
    };
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
          ? <IntentBox key={sessionId} text={pane.intent.text} meta={pane.intent.meta} stale={pane.intent.stale} />
          : <div className="live-intent-none">{pane.intent.text}</div>}
        {steps.list.length > 0 && (
          <section className="live-sec">
            <div className="live-label">指揮役の手</div>
            {steps.list.map(({ item, key, leaving }) => <StepRow key={key} s={item} rowRef={steps.ref(key)} leaving={leaving} />)}
          </section>
        )}
        {lanes.list.length > 0 && (
          <section className="live-sec">
            <div className="live-label">サブエージェント</div>
            {lanes.list.map(({ item: l, key, leaving }) => (
              <button key={key} ref={lanes.ref(key)} className="live-lane" data-tone={l.tone} disabled={!l.selectable || leaving} aria-hidden={leaving ? 'true' : undefined} title={l.title}
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
        {/* 成果物は作業中に何度も見るものではないので、上の段の終わりに題名だけの 1 行ずつ置く。押すと既定のブラウザで開く。 */}
        {arts.list.length > 0 && (
          <section className="live-sec">
            <div className="live-label">成果物</div>
            {arts.list.map(({ item: a, key, leaving }) => (
              <div key={key} ref={arts.ref(key)} className="live-artifact" aria-hidden={leaving ? 'true' : undefined}>
                <button className="live-artifact-open" disabled={leaving} title={a.description ?? a.title} onClick={() => emit({ type: 'artifact.open', id: a.id })}>
                  <span className="live-artifact-icon" aria-hidden="true">{a.favicon}</span>
                  <span className="live-artifact-title">{a.title}</span>
                  <span className="live-artifact-when">{a.lastPublished}</span>
                </button>
                {a.canOpenEditor && <button className="btn btn-sm live-artifact-editor" disabled={leaving} aria-label={`${a.title} を VS Code で開く`} title="VS Code で開く" onClick={() => emit({ type: 'artifact.openEditor', id: a.id })}><Icon name="openEditor" /></button>}
              </div>
            ))}
          </section>
        )}
      </div>
      {/* 上の段と目次の境目。ドラッグか上下の矢印で動かし、ダブルクリックで半分に戻す。 */}
      <div className="live-divider" role="separator" aria-label="「いま」と目次の高さ" aria-orientation="horizontal"
        aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`「いま」${percent}%`} tabIndex={0}
        onPointerDown={onPointerDown} onKeyDown={onKeyDown} onDoubleClick={() => emit({ type: 'livePane.split', ratio: LIVE_PANE_SPLIT_DEFAULT })} />
      <div className="live-toc">{children}</div>
    </div>
  );
}
