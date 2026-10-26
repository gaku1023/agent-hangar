import { useState, type PointerEvent } from 'react';
import { useEmit } from '../action/chain.tsx';
import { cornerEqualize, cornerResizes, dominantAxis, type PaneCorner, type PaneId, type PaneRect } from '../lib/paneCorners.ts';

import { beginLayoutMotion, endLayoutMotion } from './primitives/layoutMotion.ts';

/** 角に関わる境目の線を濃くする印（data-hot）を付け外しする。乗せたとき 'on'、つかんだとき 'grab'。 */
function markDividers(corner: PaneCorner, value: 'on' | 'grab' | null) {
  for (const id of [corner.node, ...corner.children.map((c) => c.id)]) {
    const el = document.querySelector<HTMLElement>(`[data-divider="${id}"]`);
    if (!el) continue;
    if (value) el.setAttribute('data-hot', value);
    else el.removeAttribute('data-hot');
  }
}

const nodeEl = (id: PaneId) => document.querySelector<HTMLElement>(`[data-node="${id}"]`);

/**
 * 角の取っ手。普段は何も出さず、乗ったときだけ丸がふくらむ（CSS）。
 * つかむと丸が濃くなり、交わる線を強める。ドラッグは交わる各節に pane.resize を出す（1 回の動きで 2〜3 個）。
 * ⇧ を押している間は、動きの大きい軸の節だけが動く。ダブルクリックは、関わる節だけを均等（0.5）にする。
 * ドラッグの間は親の節の要素に beginLayoutMotion を付け、離したら端末の寸法を合わせる。
 * 境目の中に置く。位置は CSS（data-edge は、親の境目に近い端が子の境目の終わりか始めか）。
 */
export function PaneCornerHandle(props: { corner: PaneCorner; ratios: Record<PaneId, number>; edge: 'start' | 'end'; clamp: (ratio: number, size: number) => number }) {
  const emit = useEmit();
  const [grab, setGrab] = useState(false);
  const { corner } = props;
  const ids = [corner.node, ...corner.children.map((c) => c.id)];
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const host = nodeEl(corner.node);
    const rects: Record<PaneId, PaneRect> = {};
    for (const id of ids) {
      const r = nodeEl(id)?.getBoundingClientRect();
      if (!r) return;
      rects[id] = { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    if (!host) return;
    const from = { x: e.clientX, y: e.clientY };
    setGrab(true);
    markDividers(corner, 'grab');
    beginLayoutMotion(host);
    const move = (ev: globalThis.PointerEvent) => {
      const at = { x: ev.clientX, y: ev.clientY };
      const lock = ev.shiftKey ? dominantAxis(from, at) : null;
      for (const r of cornerResizes(corner, rects, at, props.clamp, lock, props.ratios)) emit({ type: 'pane.resize', node: r.node, ratio: r.ratio });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setGrab(false);
      markDividers(corner, null);
      endLayoutMotion(host);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return (
    <div className="pane-corner" data-corner={corner.id} data-edge={props.edge} data-grab={grab ? 'true' : undefined} aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerEnter={() => { if (!grab) markDividers(corner, 'on'); }}
      onPointerLeave={() => { if (!grab) markDividers(corner, null); }}
      onDoubleClick={(e) => { e.stopPropagation(); for (const r of cornerEqualize(corner)) emit({ type: 'pane.resize', node: r.node, ratio: r.ratio }); }}>
      <span className="pane-corner-dot" />
    </div>
  );
}
