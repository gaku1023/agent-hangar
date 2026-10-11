import { type KeyboardEvent, type ReactNode } from 'react';
import { useThumb } from './useThumb.ts';

export type SegmentedOption = { value: string; label: string; lead?: ReactNode };

/**
 * 切り替えの帯。選んだ項目の下に白い玉を置き、選び直すと玉が滑る。
 * 最初の配置で玉が端から滑ってこないよう、1 フレーム置いてから動きを有効にする（data-ready）。玉の置き方は useThumb が持つ。
 */
export function Segmented(props: { label: string; value: string; options: SegmentedOption[]; onChange: (value: string) => void; size?: 'sm' | 'xs' }) {
  const { box, thumb, ready } = useThumb<HTMLSpanElement>('[aria-checked="true"]', [props.value, props.options]);
  const checked = props.options.findIndex((o) => o.value === props.value);

  const pick = (value: string) => { if (value !== props.value) props.onChange(value); };

  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    // ⌘← は戻る、などの大域のキー。選び直しに奪わない。
    if (e.altKey || e.metaKey || e.ctrlKey) return;
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
