import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type SegmentedOption = { value: string; label: string; lead?: ReactNode };

/**
 * 切り替えの帯。選んだ項目の下に白い玉を置き、選び直すと玉が滑る。
 * 最初の配置で玉が端から滑ってこないよう、1 フレーム置いてから動きを有効にする（data-ready）。
 */
export function Segmented(props: { label: string; value: string; options: SegmentedOption[]; onChange: (value: string) => void; size?: 'sm' | 'xs' }) {
  const box = useRef<HTMLSpanElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  const checked = props.options.findIndex((o) => o.value === props.value);

  useLayoutEffect(() => {
    const placeThumb = () => {
      const t = thumb.current;
      const b = box.current?.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!t) return;
      t.style.left = b ? `${b.offsetLeft}px` : '0px';
      t.style.width = b ? `${b.offsetWidth}px` : '0px';
    };
    placeThumb();
    // 書体が読み込まれると文字の幅が変わるので、帯の大きさの変化にも付いていく。
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(placeThumb);
    if (box.current) ro?.observe(box.current);
    return () => ro?.disconnect();
  }, [props.value, props.options]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const pick = (value: string) => { if (value !== props.value) props.onChange(value); };

  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = props.options.length;
    const next = (Math.max(checked, 0) + step + n) % n;
    pick(props.options[next]!.value);
    box.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <span ref={box} className={`seg seg-${props.size ?? 'sm'}`} role="radiogroup" aria-label={props.label} data-ready={ready ? 'true' : undefined} onKeyDown={onKey}>
      <span ref={thumb} className="seg-thumb" aria-hidden="true" />
      {props.options.map((o, i) => (
        <button key={o.value} type="button" role="radio" aria-checked={i === checked} tabIndex={i === Math.max(checked, 0) ? 0 : -1} onClick={() => pick(o.value)}>
          {o.lead && <span className="seg-lead" aria-hidden="true">{o.lead}</span>}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </span>
  );
}
