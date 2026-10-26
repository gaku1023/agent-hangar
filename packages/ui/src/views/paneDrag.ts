import { useSyncExternalStore } from 'react';
import type { PaneDropSide, PaneId } from '@agent-hangar/shared';
import { motionOn } from './primitives/motionKit.ts';

/**
 * 画面の分割のドラッグ（サイドバーの行と、ペインの見出し）が共有する状態と、ドロップ先の判定。
 * HTML5 の DnD は使わない（Tauri が横取りするため）。ポインタのイベントを持つ側（Sidebar の RowList、PaneHeader）が、
 * 動くたびに paneDrag.move を呼び、離したら paneDrag.finish で落とし先を受け取って pane.open か pane.move を出す。
 * 予告の枠とドラッグの札は PaneDropOverlay が 1 つずつだけ描き、位置と大きさは style で替える（T5 の動きがここへ transition を足す）。
 */

/** 辺までの距離（rect の幅・高さで正規化）の最小がこの値未満なら、その辺。 */
export const DROP_EDGE = 0.28;

export type Box = { left: number; top: number; width: number; height: number };

/** rect のどこに point があるか。辺に近ければその辺、ほかは center。 */
export function dropZone(rect: Box, point: { x: number; y: number }): PaneDropSide {
  if (rect.width <= 0 || rect.height <= 0) return 'center';
  const fx = (point.x - rect.left) / rect.width;
  const fy = (point.y - rect.top) / rect.height;
  const near: Array<[Exclude<PaneDropSide, 'center'>, number]> = [['left', fx], ['right', 1 - fx], ['up', fy], ['down', 1 - fy]];
  let best = near[0]!;
  for (const n of near) if (n[1] < best[1]) best = n;
  return best[1] < DROP_EDGE ? best[0] : 'center';
}

/** 辺に落としたとき、新しいペインが入る半分の矩形。中央は rect そのまま。 */
export function previewRect(rect: Box, side: PaneDropSide): Box {
  const { left, top, width, height } = rect;
  if (side === 'left') return { left, top, width: width / 2, height };
  if (side === 'right') return { left: left + width / 2, top, width: width / 2, height };
  if (side === 'up') return { left, top, width, height: height / 2 };
  if (side === 'down') return { left, top: top + height / 2, width, height: height / 2 };
  return rect;
}

/** 落とし先。target が null のときは操作中のペイン（ペインが 1 つのときの本体全体）。blocked は落とせない（自分の上）。 */
export type DropHit = { target: PaneId | null; side: PaneDropSide; rect: Box; blocked: boolean };

export type DragSource =
  | { kind: 'session'; sessionId: string; name: string; live?: 'busy' | 'idle' | 'waiting' | null }
  | { kind: 'pane'; pane: PaneId; name: string };

const inside = (r: Box, x: number, y: number): boolean => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };

/**
 * ポインタの位置から落とし先を決める。
 * 分割の本体があればその中のペイン、無ければセッション画面（ペイン 1 つ）の矩形を 1 つのペインとして見る。
 * セッション画面でない所の上、ペインの外（境目など）は null で、予告を出さず、落としても何もしない。
 */
export function hitTest(x: number, y: number, source: DragSource, root: ParentNode = document): DropHit | null {
  const ws = root.querySelector('[data-pane-workspace]');
  let target: PaneId | null;
  let rect: Box;
  if (ws) {
    const cell = Array.from(ws.querySelectorAll<HTMLElement>('[data-pane]')).find((el) => inside(boxOf(el), x, y));
    if (!cell) return null;
    target = cell.dataset.pane ?? null;
    rect = boxOf(cell);
  } else {
    const screen = root.querySelector('.session-screen:not([data-variant])');
    if (!screen) return null;
    target = null;
    rect = boxOf(screen);
    if (!inside(rect, x, y)) return null;
  }
  if (source.kind === 'pane' && source.pane === target) return { target, side: 'center', rect, blocked: true };
  const side = dropZone(rect, { x, y });
  return { target, side, rect: previewRect(rect, side), blocked: false };
}

export type DragState = { source: DragSource; x: number; y: number; hit: DropHit | null };
/**
 * 終わったドラッグの札の行き先（T5 の動き）。落としたなら入る場所（ok）、やめたなら元の行か見出し（to が null なら元の場所で薄れる）。
 * 動きを減らす設定では作らず、札はすぐ消える。札の動きが終わったら paneDrag.landed() で消す。
 */
export type DragEnd = { source: DragSource; x: number; y: number; ok: boolean; to: Box | null };

let state: DragState | null = null;
let ending: DragEnd | null = null;
const listeners = new Set<() => void>();
const publish = (next: DragState | null, end: DragEnd | null = ending) => { state = next; ending = end; for (const l of listeners) l(); };

/** やめたときに戻る先。サイドバーの行か、ペインの見出し。 */
function originOf(source: DragSource): Box | null {
  const sel = source.kind === 'session' ? `.side-live-row[data-id="${CSS.escape(source.sessionId)}"]` : `[data-pane-header="${CSS.escape(source.pane)}"]`;
  const el = document.querySelector(sel);
  return el ? boxOf(el) : null;
}

/** 終わりを記録して、状態を空にする。札の動きがあるときだけ ending を残す。 */
function end(ok: boolean, hit: DropHit | null): void {
  const prev = state;
  if (!prev || !motionOn(document.documentElement)) { publish(null, null); return; }
  publish(null, { source: prev.source, x: prev.x, y: prev.y, ok, to: ok && hit ? hit.rect : originOf(prev.source) });
}

export const paneDrag = {
  get: (): DragState | null => state,
  landing: (): DragEnd | null => ending,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  /** ポインタが動いた。落とし先を測り直して状態を替える。新しいドラッグが始まったら、前の札の動きは捨てる。 */
  move(source: DragSource, x: number, y: number): DropHit | null {
    const hit = hitTest(x, y, source);
    publish({ source, x, y, hit }, null);
    return hit;
  },
  /** やめる（Esc、取り消し、サイドバーへ戻った）。札は元の行へ戻る。 */
  cancel() { if (state) end(false, null); },
  /** 離した。いまの落とし先を返して状態を空にする。落とせないとき（null、blocked）は null。札は入る場所へ吸い込まれる（落とせないときは戻る）。 */
  finish(): DropHit | null {
    const hit = state?.hit ?? null;
    const ok = !!hit && !hit.blocked;
    end(ok, hit);
    return ok ? hit : null;
  },
  /** 札の動きが終わった。 */
  landed() { if (ending) publish(state, null); },
};

export const usePaneDrag = (): DragState | null => useSyncExternalStore(paneDrag.subscribe, paneDrag.get, paneDrag.get);

export const usePaneDragEnd = (): DragEnd | null => useSyncExternalStore(paneDrag.subscribe, paneDrag.landing, paneDrag.landing);
