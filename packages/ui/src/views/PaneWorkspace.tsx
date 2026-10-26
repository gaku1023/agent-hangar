import { useEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import { findLeaf, type PaneLeaf, type PaneNode, type PaneSplit } from '../mediator/panes.ts';
import type { PanesProps } from '../presenters/panes.ts';
import { PaneDivider } from './PaneDivider.tsx';
import { EmptyPaneHeader, type PaneView } from './PaneHeader.tsx';
import { PanePicker } from './PanePicker.tsx';
import { SessionScreen } from './SessionScreen.tsx';
import { useT } from './primitives/language.tsx';

/** この幅（ペインの内側）より狭いと一言とプロジェクト名と主の操作の文字を消す。 */
export const PANE_TIGHT_WIDTH = 620;
/** この幅より狭いと、さらにステータスの札の文字を消し、主の操作と ⓘ を ⋯ の中へ移す。 */
export const PANE_TINY_WIDTH = 420;
/** 光らせる長さ。 */
const FLASH_MS = 700;

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
  // 光らせる合図（flash.n が変わったとき）。動きは T5 で作り替える。いまは枠を一瞬強調するだけ。
  const [flashing, setFlashing] = useState(false);
  const flashN = p.flash && p.flash.pane === leaf.id ? p.flash.n : null;
  useEffect(() => {
    if (flashN === null) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashN]);
  const view: PaneView = { id: leaf.id, toc: leaf.toc, tight, tiny, zoomed: p.zoom === leaf.id };
  const screen = p.screens[leaf.id];
  return (
    <div ref={ref} data-pane={leaf.id} data-session={leaf.sessionId ?? undefined} data-focused={focused ? 'true' : undefined} data-flash={flashing ? 'true' : undefined}
      data-toc={leaf.toc ? 'true' : undefined} data-empty={leaf.sessionId === null ? 'true' : undefined}
      className={['pane', tight ? 'tight' : '', tiny ? 'tiny' : '', flashing ? 'flash' : ''].filter(Boolean).join(' ')}
      onPointerDownCapture={() => { if (!focused) emit({ type: 'pane.focus', pane: leaf.id }); }}>
      {screen ? <SessionScreen {...screen} variant="pane" pane={view} /> : <><EmptyPaneHeader pane={view} /><PanePicker pane={leaf.id} rows={p.picker} /></>}
    </div>
  );
}

/** 木の節 1 つ。子の大きさは flex-grow に比率を入れ、間に境目を置く。 */
function SplitView(props: { node: PaneSplit; p: PanesProps }) {
  const ref = useRef<HTMLDivElement>(null);
  const { node } = props;
  return (
    <div ref={ref} className="pane-node" data-node={node.id} data-dir={node.dir}>
      <div className="pane-slot" style={{ flexGrow: node.ratio }}><NodeView node={node.a} p={props.p} /></div>
      <PaneDivider node={node} hostRef={ref} />
      <div className="pane-slot" style={{ flexGrow: 1 - node.ratio }}><NodeView node={node.b} p={props.p} /></div>
    </div>
  );
}

function NodeView(props: { node: PaneNode; p: PanesProps }) {
  return props.node.kind === 'pane' ? <PaneCell leaf={props.node} p={props.p} /> : <SplitView node={props.node} p={props.p} />;
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
