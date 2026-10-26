import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export type SliderStop<V> = { value: V; label: string; tick: string };

/**
 * 目盛りで止まるスライダー。値は親が持ち、目盛りの下に短い名前を並べる。
 * 引いている間は手元の位置だけを動かし、離したときに 1 度だけ onChange を呼ぶ（設定の保存を刻みごとに送らないため）。
 * 矢印キー、Home、End でも動かせ、キーではその場で onChange を呼ぶ。
 * つまみと塗りは目盛りへ吸い付くように動き（--dur-fast）、引いている間は追従させるために動きを切る。
 */
export function StepSlider<V>(props: { label: string; stops: SliderStop<V>[]; value: V; onChange: (next: V) => void; disabled?: boolean }) {
  const n = props.stops.length - 1;
  const at = Math.max(0, props.stops.findIndex((s) => s.value === props.value));
  const [drag, setDrag] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const i = drag ?? at;
  // 外から値が変わったら、引いている途中の位置は捨てる。
  useEffect(() => setDrag(null), [at]);

  const indexAt = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(n, Math.round(((x - r.left) / r.width) * n)));
  };
  const commit = (j: number) => { if (j !== at) props.onChange(props.stops[j]!.value); };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (props.disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(indexAt(e.clientX));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => { if (drag !== null) setDrag(indexAt(e.clientX)); };
  const onUp = () => { if (drag === null) return; commit(drag); setDrag(null); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const j = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? at + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n : null;
    if (j === null) return;
    e.preventDefault();
    commit(Math.max(0, Math.min(n, j)));
  };
  const pct = (j: number) => `${(j / n) * 100}%`;

  return (
    <div className="step-slider" data-drag={drag !== null || undefined} data-disabled={props.disabled || undefined}>
      <div className="step-slider-track" ref={track} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        <div className="step-slider-fill" style={{ width: pct(i) }} />
        {props.stops.slice(1, -1).map((s, j) => <i key={j} className="step-slider-mark" style={{ left: pct(j + 1) }} />)}
        <div className="step-slider-knob" style={{ left: pct(i) }} role="slider" tabIndex={props.disabled ? -1 : 0} aria-label={props.label}
          aria-valuemin={0} aria-valuemax={n} aria-valuenow={i} aria-valuetext={props.stops[i]!.label} aria-disabled={props.disabled || undefined} onKeyDown={onKey} />
      </div>
      <div className="step-slider-ticks" aria-hidden>
        {props.stops.map((s, j) => <span key={j} data-on={j === i || undefined} data-edge={j === 0 ? 'start' : j === n ? 'end' : undefined} style={{ left: pct(j) }}>{s.tick}</span>)}
      </div>
    </div>
  );
}
