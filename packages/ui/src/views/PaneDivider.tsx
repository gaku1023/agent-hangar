import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { PaneSplit } from '../mediator/panes.ts';
import { PANE_RATIO_MAX, PANE_RATIO_MIN, clampRatio } from '../mediator/panes.ts';
import { beginLayoutMotion, endLayoutMotion } from './primitives/layoutMotion.ts';
import { useT } from './primitives/language.tsx';

/** 1 つのペインの最小の幅（高さ）。描画の側で守る（mediator の比率は 0.1〜0.9 まで）。 */
export const PANE_MIN_SIZE = 280;

/** 比率を、両側が最小の大きさを割らない範囲に収める。2 つ分の大きさに満たないときは、mediator の範囲だけで収める。 */
export function clampPaneRatio(ratio: number, size: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  if (!(size >= PANE_MIN_SIZE * 2)) return clampRatio(ratio);
  const min = PANE_MIN_SIZE / size;
  return Math.min(1 - min, Math.max(min, Math.min(PANE_RATIO_MAX, Math.max(PANE_RATIO_MIN, ratio))));
}

/**
 * 分割の節の境目。SplitPane の仕切りと同じ触り心地で、ドラッグ、ダブルクリックで均等、矢印キーで動かす。
 * ドラッグの間は節の要素（hostRef）に beginLayoutMotion を付け、端末の寸法合わせを止める。
 * 比率はここでは持たず、pane.resize を出して Mediator に任せる。
 */
export function PaneDivider(props: { node: PaneSplit; hostRef: RefObject<HTMLDivElement | null> }) {
  const emit = useEmit();
  const t = useT();
  const row = props.node.dir === 'row';
  const sizeOf = (rect: DOMRect) => (row ? rect.width : rect.height);
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const host = props.hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const size = sizeOf(rect);
    if (!(size > 0)) return;
    beginLayoutMotion(host);
    const move = (ev: globalThis.PointerEvent) => {
      const at = row ? ev.clientX - rect.left : ev.clientY - rect.top;
      emit({ type: 'pane.resize', node: props.node.id, ratio: clampPaneRatio(at / size, size) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      endLayoutMotion(host);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const less = row ? 'ArrowLeft' : 'ArrowUp';
    const more = row ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== less && e.key !== more) return;
    e.preventDefault();
    const host = props.hostRef.current;
    const size = host ? sizeOf(host.getBoundingClientRect()) : 0;
    emit({ type: 'pane.resize', node: props.node.id, ratio: clampPaneRatio(props.node.ratio + (e.key === less ? -0.02 : 0.02), size) });
  };
  const percent = Math.round(props.node.ratio * 100);
  return <div className="pane-divider" data-dir={props.node.dir} data-divider={props.node.id} role="separator" aria-label={t('pane.divider.name')} title={t('pane.divider.title')}
    aria-orientation={row ? 'vertical' : 'horizontal'} aria-valuenow={percent} aria-valuemin={10} aria-valuemax={90} aria-valuetext={t('pane.divider.valueText', { percent })}
    tabIndex={0} onPointerDown={onPointerDown} onDoubleClick={() => emit({ type: 'pane.equalize' })} onKeyDown={onKeyDown} />;
}
