import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { PaneId } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import { paneDrag } from './paneDrag.ts';

/** 押してからこの距離（px）を越えて動いたらドラッグに入る。サイドバーの行（DRAG_SLOP）と同じ。 */
const DRAG_SLOP = 4;
/** 見出しの中で、ドラッグの掴み先にしない部品（ボタン、ステータスの札、⋯、ⓘ、主の操作）。 */
const NO_GRAB = 'button, a, input, select, textarea, [data-slot], [data-pane-toc], [data-pane-unzoom], [data-pane-remove]';

/**
 * ペインの見出しをつかんで動かし、別のペインの上へ落とす（pane.move）。
 * ポインタのイベントを窓で受ける（HTML5 の DnD は使わない）。Esc で何も出さずにやめる。
 * 自分のペインの上は落とせない（paneDrag の hit が blocked）ので、離しても pane.move を出さない。
 * 返す onPointerDown を、見出しの外枠（data-pane-header の要素）に付ける。
 */
export function usePaneHeaderDrag(pane: PaneId, name: string): { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void } {
  const emit = useEmit();
  const latest = useRef({ emit, pane, name });
  latest.current = { emit, pane, name };
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => { stop.current?.(); }, []);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || e.ctrlKey || e.isPrimary === false || stop.current) return;
    if ((e.target as Element).closest(NO_GRAB)) return;
    const id = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    const source = () => ({ kind: 'pane' as const, pane: latest.current.pane, name: latest.current.name });
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      stop.current = null;
      if (active) paneDrag.cancel();
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_SLOP) return;
        active = true;
      }
      paneDrag.move(source(), ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const hit = active ? paneDrag.finish() : null;
      active = false;
      end();
      if (hit && hit.target) latest.current.emit({ type: 'pane.move', pane: latest.current.pane, target: hit.target, side: hit.side });
    };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === id) end(); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // ダイアログや画面の Esc へは届かせない（取り消したのと同じ打鍵で、別のものを閉じないため）。
      if (active) { ev.preventDefault(); ev.stopImmediatePropagation(); }
      end();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    stop.current = end;
  };
  return { onPointerDown };
}
