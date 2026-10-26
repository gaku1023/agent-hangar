import { useEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import { findLeaf, type PaneLeaf, type PaneNode, type PaneSplit } from '../mediator/panes.ts';
import type { PanesProps } from '../presenters/panes.ts';
import { cornerCarriedBy, cornersAt, type PaneCorner } from '../lib/paneCorners.ts';
import { PaneDivider } from './PaneDivider.tsx';
import { EmptyPaneHeader, type PaneView } from './PaneHeader.tsx';
import { PanePicker } from './PanePicker.tsx';
import { SessionScreen } from './SessionScreen.tsx';
import { useT } from './primitives/language.tsx';
import { flashPane } from './primitives/splitMotion.ts';

/** この幅（ペインの内側）より狭いと一言とプロジェクト名と主の操作の文字を消す。 */
export const PANE_TIGHT_WIDTH = 620;
/** この幅より狭いと、さらにステータスの札の文字を消し、主の操作と ⓘ を ⋯ の中へ移す。 */
export const PANE_TINY_WIDTH = 420;

/**
 * ペインごとの幅。ResizeObserver で測り、tight（620px 未満）と tiny（420px 未満）を返す。
 * 測るまでは広いものとして描く。
 */
function usePaneWidth(ref: React.RefObject<HTMLElement | null>): { tight: boolean; tiny: boolean } {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width;
      if (typeof w === 'number') setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return { tight: width !== null && width < PANE_TIGHT_WIDTH, tiny: width !== null && width < PANE_TINY_WIDTH };
}

/**
 * ペイン 1 つ。セッションの入ったペインは SessionScreen（variant="pane"）、空のペインは PanePicker を出す。
 * 押す（pointerdown、子の操作より先）と pane.focus を出し、操作中を移す。
 * data-pane は T3 のドロップ先の判定、T4 の隣への移動、T5 の動きがペインの外枠を探すつなぎ目である。
 */
function PaneCell(props: { leaf: PaneLeaf; p: PanesProps }) {
  const emit = useEmit();
  const ref = useRef<HTMLDivElement>(null);
  const { tight, tiny } = usePaneWidth(ref);
  const { leaf, p } = props;
  const focused = p.focus === leaf.id;
  // 光らせる合図（flash.n が変わったとき）。枠が一瞬濃くなって薄れる（flashPane）。最初の描画では光らせない。
  const flashN = p.flash && p.flash.pane === leaf.id ? p.flash.n : null;
  const flashed = useRef<number | null>(flashN);
  useEffect(() => {
    if (flashN === null || flashN === flashed.current) { flashed.current = flashN; return; }
    flashed.current = flashN;
    if (ref.current) flashPane(ref.current);
  }, [flashN]);
  const view: PaneView = { id: leaf.id, toc: leaf.toc, tight, tiny, zoomed: p.zoom === leaf.id };
  const screen = p.screens[leaf.id];
  return (
    <div ref={ref} data-pane={leaf.id} data-session={leaf.sessionId ?? undefined} data-focused={focused ? 'true' : undefined}
      data-toc={leaf.toc ? 'true' : undefined} data-empty={leaf.sessionId === null ? 'true' : undefined}
      className={['pane', tight ? 'tight' : '', tiny ? 'tiny' : ''].filter(Boolean).join(' ')}
      onPointerDownCapture={() => { if (!focused) emit({ type: 'pane.focus', pane: leaf.id }); }}>
      {screen ? <SessionScreen {...screen} variant="pane" pane={view} /> : <><EmptyPaneHeader pane={view} /><PanePicker pane={leaf.id} rows={p.picker} /></>}
    </div>
  );
}

/** 木の節 1 つ。子の大きさは flex-grow に比率を入れ、間に境目を置く。 */
function SplitView(props: { node: PaneSplit; p: PanesProps; corner?: { corner: PaneCorner; ratios: Record<string, number>; edge: 'start' | 'end' } }) {
  const ref = useRef<HTMLDivElement>(null);
  const { node } = props;
  return (
    <div ref={ref} className="pane-node" data-node={node.id} data-dir={node.dir}>
      <div className="pane-slot" style={{ flexGrow: node.ratio }}><NodeView node={node.a} p={props.p} parent={node} /></div>
      <PaneDivider node={node} hostRef={ref} corner={props.corner} />
      <div className="pane-slot" style={{ flexGrow: 1 - node.ratio }}><NodeView node={node.b} p={props.p} parent={node} /></div>
    </div>
  );
}

/** 親の節 parent の子として node を描くとき、その境目に出す角の取っ手（角は木から求める）。 */
function cornerOf(parent: PaneSplit, node: PaneSplit): { corner: PaneCorner; ratios: Record<string, number>; edge: 'start' | 'end' } | undefined {
  const corner = cornerCarriedBy(cornersAt(parent), parent.id, node.id);
  if (!corner) return undefined;
  const ratios: Record<string, number> = { [parent.id]: parent.ratio };
  for (const c of corner.children) {
    const child = c.side === 'a' ? parent.a : parent.b;
    if (child.kind === 'split') ratios[c.id] = child.ratio;
  }
  // 親の境目に近い端は、a 側の子なら子の境目の終わり、b 側なら始め。
  return { corner, ratios, edge: corner.children[0]!.side === 'a' ? 'end' : 'start' };
}

function NodeView(props: { node: PaneNode; p: PanesProps; parent?: PaneSplit }) {
  const { node, parent } = props;
  return node.kind === 'pane' ? <PaneCell leaf={node} p={props.p} /> : <SplitView node={node} p={props.p} corner={parent ? cornerOf(parent, node) : undefined} />;
}

/**
 * 画面の分割の本体（ペインが 2 つ以上のとき）。
 * 木を入れ子の flex で描く。最大化中はそのペインだけを本体いっぱいに出す。
 * data-pane-workspace は T3 のドロップ先の判定が本体の矩形を測るつなぎ目で、予告の枠もこの中に置く。
 */
export function PaneWorkspace(props: { panes: PanesProps }) {
  const t = useT();
  const p = props.panes;
  const zoomed = p.zoom ? findLeaf(p.root, p.zoom) : undefined;
  return (
    <div className="pane-workspace" data-pane-workspace="true" data-zoom={zoomed ? 'true' : undefined} role="group" aria-label={t('pane.workspace.label')}>
      {zoomed ? <PaneCell key={zoomed.id} leaf={zoomed} p={p} /> : <NodeView node={p.root} p={p} />}
    </div>
  );
}
