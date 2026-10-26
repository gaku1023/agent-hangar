import { useLayoutEffect, useRef } from 'react';
import { paneLeaves, type PaneNode, type PanesState } from '../mediator/panes.ts';
import { growIn, motionOn } from './primitives/motionKit.ts';
import { motionMs } from './primitives/motion.ts';
import { collapseHead, flipFrom, flyName, holdLayout, leavePane, nameSnap, paneEnter, retitle, riseParts, settleTop, type NameSnap, type Rect } from './primitives/splitMotion.ts';

/**
 * 画面の分割の、構造が替わるときの動き（1 つ ⇄ 分割、並びと最大化の入れ替え）。
 * 1 つのときは SessionScreen、2 つ以上は PaneWorkspace と、別の木が描かれるので、前の姿は替わる描画の前（render の最中、DOM がまだ前のまま）に測り、
 * 描いたあと（layout effect）に今の姿と突き合わせて動かす。
 * 比率だけの変化（境目のドラッグ）は、鍵に入れないので動かさない。
 */

/** 動きの判断に使う、画面の形。count 0 はセッション画面でないこと。 */
export type Frame = {
  count: number;
  /** 形の鍵。比率は入れない。 */
  key: string;
  /** 1 つのときのセッション（ペインが 1 つ以下のとき）。 */
  single: string | null;
  leafIds: string[];
  zoom: string | null;
};

const shapeOf = (n: PaneNode): string => (n.kind === 'pane' ? `${n.id}:${n.sessionId ?? ''}` : `${n.dir}(${shapeOf(n.a)},${shapeOf(n.b)})`);

/** 状態から Frame を作る。screen はセッション画面か、そのセッションの id。 */
export function frameOf(onSession: boolean, sessionId: string | null, panes: PanesState): Frame {
  if (!onSession) return { count: 0, key: '0', single: null, leafIds: [], zoom: null };
  const leaves = paneLeaves(panes.root);
  const zoom = panes.zoom && leaves.some((l) => l.id === panes.zoom) ? panes.zoom : null;
  if (leaves.length < 2) return { count: 1, key: `1:${sessionId ?? ''}`, single: sessionId, leafIds: leaves.map((l) => l.id), zoom: null };
  return { count: leaves.length, key: `${panes.root ? shapeOf(panes.root) : ''}|${zoom ?? ''}`, single: null, leafIds: leaves.map((l) => l.id), zoom };
}

export type Transition = 'split' | 'unsplit' | 'retitle' | 'tree';

/** 前の形と今の形から、どの動きか。画面の行き来（セッション画面でない側）と、形が同じときは null。 */
export function classify(prev: Frame, next: Frame): Transition | null {
  if (prev.count === 0 || next.count === 0 || prev.key === next.key) return null;
  if (prev.count === 1 && next.count === 1) return prev.single !== next.single ? 'retitle' : null;
  if (prev.count === 1) return 'split';
  if (next.count === 1) return 'unsplit';
  return 'tree';
}

type PaneSnap = { el: HTMLElement; rect: Rect; session: string | null; title: NameSnap | null };
/** 替わる前の姿。 */
export type Snap = {
  frame: Frame;
  /** 1 つのときの大きな見出し（.page-head）。外れたあとも中身は残るので、畳むときに戻して使う。 */
  head: { el: HTMLElement; rect: Rect; title: NameSnap | null } | null;
  /** 1 つのときのセッション画面の矩形。 */
  screen: Rect | null;
  panes: Map<string, PaneSnap>;
};

const rectOf = (el: Element): Rect => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };

/** いまの DOM から前の姿を測る。 */
export function measure(frame: Frame, root: ParentNode = document): Snap {
  const panes = new Map<string, PaneSnap>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-pane-workspace] [data-pane]')) {
    const t = el.querySelector<HTMLElement>('.pane-head-title');
    panes.set(el.dataset.pane!, { el, rect: rectOf(el), session: el.dataset.session ?? null, title: t ? nameSnap(t) : null });
  }
  const screen = root.querySelector<HTMLElement>('.session-screen:not([data-variant])');
  const headEl = screen?.querySelector<HTMLElement>('.page-head') ?? null;
  const h1 = headEl?.querySelector<HTMLElement>('.page-title') ?? null;
  return { frame, head: headEl ? { el: headEl, rect: rectOf(headEl), title: h1 ? nameSnap(h1) : null } : null, screen: screen ? rectOf(screen) : null, panes };
}

const paneEl = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-pane-workspace] [data-pane="${CSS.escape(id)}"]`);

/** 1 つ → 分割。 */
function split(pre: Snap, next: Frame, root: ParentNode): void {
  const ws = root.querySelector<HTMLElement>('[data-pane-workspace]');
  if (!ws) return;
  const origin = pre.frame.single;
  const anims = [];
  // 大きな見出しは、外れたあとの中身を元の位置へ戻して高さ 0 へ畳む。本体は同じ拍で上へ寄る。
  if (pre.head) {
    const title = pre.head.el.querySelector<HTMLElement>('.page-title');
    if (title) title.style.visibility = 'hidden';
    void collapseHead(pre.head.el, pre.head.rect);
    anims.push(settleTop(ws, pre.head.rect.height));
  }
  for (const id of next.leafIds) {
    const el = paneEl(root, id);
    if (!el) continue;
    if (el.dataset.session === origin && origin) {
      // 元のセッションのペイン。見出しが高さ 0 から伸び、部品が上からずれて出て、名前の札が降りてくる。
      const head = el.querySelector<HTMLElement>('.pane-head');
      if (head) {
        anims.push(growIn(head));
        riseParts([...head.querySelectorAll('.pane-head-ctl, .pane-head-sep, .pane-head-btn')], { dy: -4, first: 3 });
        if (pre.head?.title) flyName(pre.head.title, head.querySelector<HTMLElement>('.pane-head-title'));
      }
      // 本体は、大きな画面だった幅から今の幅へ。
      if (pre.screen) { const now = rectOf(el); flipFrom(el, { left: pre.screen.left, top: now.top, width: pre.screen.width, height: now.height }, now); }
    } else {
      paneEnter(el);
    }
  }
  holdLayout(ws, anims);
}

/** 分割 → 1 つ。 */
function unsplit(pre: Snap, next: Frame, root: ParentNode): void {
  const screen = root.querySelector<HTMLElement>('.session-screen:not([data-variant])');
  // 薄れて縮むのは閉じるペインだけ。残るペインは、描き直された大きな見出しへ名前の札だけを飛ばす。
  // 残るペインは、操作中のセッション（画面の id）ではなく、木に残った葉で決める。
  const survivor = pre.panes.get(next.leafIds[0] ?? '') ?? [...pre.panes.values()].find((p) => p.session === next.single);
  for (const [, p] of pre.panes) if (p !== survivor) void leavePane(p.el, p.rect);
  if (!screen) return;
  const head = screen.querySelector<HTMLElement>('.page-head');
  const h1 = head?.querySelector<HTMLElement>('.page-title') ?? null;
  const anims = [];
  if (head) anims.push(growIn(head));
  if (survivor?.title && h1) flyName(survivor.title, h1);
  if (h1) riseParts([...(h1.parentElement?.children ?? [])].filter((c) => c !== h1 && c.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_PRECEDING), { first: 3 });
  holdLayout(screen, anims);
}

/** 1 つのまま中身が替わった。名前と操作を下から出し直す。 */
function swapContent(root: ParentNode): void {
  const h1 = root.querySelector<HTMLElement>('.session-screen:not([data-variant]) .page-head .page-title');
  if (!h1) return;
  retitle(h1);
  riseParts([...(h1.parentElement?.children ?? [])].filter((c) => c !== h1 && c.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_PRECEDING), { first: 1 });
}

/** 分割のまま、並びが替わった（入れ替え、最大化と解除、空のペインへ入れる、閉じる、新しい分割）。 */
function tree(pre: Snap, next: Frame, root: ParentNode): void {
  const zoomChanged = pre.frame.zoom !== next.zoom;
  for (const id of next.leafIds) {
    const el = paneEl(root, id);
    if (!el) continue;
    const was = pre.panes.get(id);
    if (!was) { paneEnter(el, zoomChanged ? { delay: motionMs('--stagger', el) * 4, light: true } : {}); continue; }
    if (was.session !== (el.dataset.session ?? null)) { paneEnter(el); continue; }
    flipFrom(el, was.rect, rectOf(el));
  }
  // 閉じたペイン。最大化で隠れただけのものは、木にまだあるので外れたとは数えない。
  for (const [id, p] of pre.panes) if (!next.leafIds.includes(id)) void leavePane(p.el, p.rect);
}

/** 前の姿と今の DOM から動かす。 */
export function play(kind: Transition, pre: Snap, next: Frame, root: ParentNode = document): void {
  switch (kind) {
    case 'split': return split(pre, next, root);
    case 'unsplit': return unsplit(pre, next, root);
    case 'retitle': return swapContent(root);
    case 'tree': return tree(pre, next, root);
  }
}

/**
 * Root が毎回の描画で呼ぶ。形（frame.key）が替わる描画の前に前の姿を測り、描いたあとに動かす。
 * 動きを減らす設定では、測りも動かしもしない。
 */
export function useSplitMotion(frame: Frame): void {
  const committed = useRef<Frame | null>(null);
  const pending = useRef<Snap | null>(null);
  const prev = committed.current;
  if (prev && prev.key !== frame.key && pending.current?.frame !== prev && motionOn(document.documentElement)) pending.current = measure(prev);
  useLayoutEffect(() => {
    const was = committed.current;
    committed.current = frame;
    const pre = pending.current;
    pending.current = null;
    if (!was || !pre || pre.frame !== was) return;
    const kind = classify(was, frame);
    if (kind) play(kind, pre, frame);
  });
}
