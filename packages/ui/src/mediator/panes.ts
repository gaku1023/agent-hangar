import type { PaneDropSide, PaneId, UiAction } from '@agent-hangar/shared';
import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import { canMoveBehind, closeTransient } from './screen.ts';
import type { Effect, Input, State, Step } from './types.ts';

/**
 * 画面の分割（別のセッションを並べる）の木。
 * 葉がペイン（セッション 1 つか空）、節が分け目（向きと比率）の二分木である。
 * ここは純関数だけを置く。描画の側は State.panes を読み、入力（UiAction の pane.*）を出す。
 *
 * 画面との関係：state.screen が session のとき、screen.id は操作中のペインの sessionId と同じにする。
 * 画面（URL のハッシュ）が正なので、セッションへ移ったあとの木の追従は followScreen が 1 か所で受ける。
 */

export type PaneLeaf = { kind: 'pane'; id: PaneId; sessionId: string | null; toc: boolean };
export type PaneSplit = { kind: 'split'; id: PaneId; dir: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode };
export type PaneNode = PaneLeaf | PaneSplit;

export type PanesState = {
  root: PaneNode | null;
  /** 操作中のペインの id。木が null のときは null。 */
  focus: PaneId | null;
  /** 最大化しているペインの id。保存しない。 */
  zoom: PaneId | null;
  /** 「もう開いている」ペインを光らせる一時状態。n は立てるたびに増え、同じペインをもう一度光らせるときの合図になる。保存しない。 */
  flash: { pane: PaneId; n: number } | null;
};

export const emptyPanes = (): PanesState => ({ root: null, focus: null, zoom: null, flash: null });

/** 木と操作中を残す localStorage の鍵。値は { root, focus }。 */
export const PANES_KEY = 'panes.layout';

export const PANE_RATIO_MIN = 0.1;
export const PANE_RATIO_MAX = 0.9;
export const clampRatio = (r: number): number => Math.min(PANE_RATIO_MAX, Math.max(PANE_RATIO_MIN, r));

/** 葉を左から右、上から下の並び（木の順）で返す。サイドバーの番号の札もこの順で数える。 */
export function paneLeaves(root: PaneNode | null): PaneLeaf[] {
  if (!root) return [];
  return root.kind === 'pane' ? [root] : [...paneLeaves(root.a), ...paneLeaves(root.b)];
}

export function findLeaf(root: PaneNode | null, id: PaneId | null): PaneLeaf | undefined {
  return id === null ? undefined : paneLeaves(root).find((l) => l.id === id);
}

/** そのセッションを入れているペイン。 */
export const leafOfSession = (root: PaneNode | null, sessionId: string): PaneLeaf | undefined => paneLeaves(root).find((l) => l.sessionId === sessionId);

function mapNode(node: PaneNode, id: PaneId, f: (n: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return f(node);
  if (node.kind === 'pane') return node;
  const a = mapNode(node.a, id, f);
  const b = mapNode(node.b, id, f);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** 葉か節を外し、親の節をたたむ。兄弟が親の位置に入る。外したあとの木と、兄弟（無ければ null）を返す。 */
function removeNode(root: PaneNode, id: PaneId): { root: PaneNode | null; sibling: PaneNode | null } {
  if (root.id === id) return { root: null, sibling: null };
  if (root.kind === 'pane') return { root, sibling: null };
  if (root.a.id === id) return { root: root.b, sibling: root.b };
  if (root.b.id === id) return { root: root.a, sibling: root.a };
  const a = removeNode(root.a, id);
  if (a.root !== root.a) return { root: { ...root, a: a.root! }, sibling: a.sibling };
  const b = removeNode(root.b, id);
  if (b.root !== root.b) return { root: { ...root, b: b.root! }, sibling: b.sibling };
  return { root, sibling: null };
}

/** 新しい id の番号の始まり。いまある p<n>、n<n> の最大より大きい。 */
function nextSeq(root: PaneNode | null): number {
  let max = 0;
  const walk = (n: PaneNode | null) => {
    if (!n) return;
    const m = /^[pn](\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
    if (n.kind === 'split') { walk(n.a); walk(n.b); }
  };
  walk(root);
  return max + 1;
}

const dirOf = (side: Exclude<PaneDropSide, 'center'>): 'row' | 'col' => (side === 'left' || side === 'right' ? 'row' : 'col');
const newFirst = (side: Exclude<PaneDropSide, 'center'>): boolean => side === 'left' || side === 'up';

/** target の葉を、target と leaf を並べた節に替える。 */
function splitAt(root: PaneNode, target: PaneId, leaf: PaneLeaf, side: Exclude<PaneDropSide, 'center'>, splitId: PaneId): PaneNode {
  return mapNode(root, target, (t) => ({ kind: 'split', id: splitId, dir: dirOf(side), ratio: 0.5, a: newFirst(side) ? leaf : t, b: newFirst(side) ? t : leaf }));
}

// ---- 保存と読み込み ----

const MAX_DEPTH = 64;

function parseNode(v: unknown, seen: Set<string>, depth: number): PaneNode | undefined {
  if (depth > MAX_DEPTH || !v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id === '' || seen.has(o.id)) return undefined;
  seen.add(o.id);
  if (o.kind === 'pane') {
    if (o.sessionId !== null && (typeof o.sessionId !== 'string' || o.sessionId === '')) return undefined;
    return { kind: 'pane', id: o.id, sessionId: o.sessionId as string | null, toc: o.toc === true };
  }
  if (o.kind === 'split') {
    if ((o.dir !== 'row' && o.dir !== 'col') || typeof o.ratio !== 'number' || !Number.isFinite(o.ratio)) return undefined;
    const a = parseNode(o.a, seen, depth + 1);
    const b = a && parseNode(o.b, seen, depth + 1);
    return a && b ? { kind: 'split', id: o.id, dir: o.dir, ratio: clampRatio(o.ratio), a, b } : undefined;
  }
  return undefined;
}

/**
 * 保存した { root, focus } を読み戻す形に整える。
 * 壊れた形（葉でも節でもない、id の重なり、向きや比率が違う）は木ごと捨てて空にする。
 * 同じセッションを入れたペインが重なっていたら、後ろのペインを外す（同じセッションを 2 か所には出さない）。
 * 操作中が木に無ければ、最初のペインにする。
 */
export function cleanPaneLayout(v: unknown): { root: PaneNode | null; focus: PaneId | null } {
  const empty = { root: null, focus: null };
  if (!v || typeof v !== 'object') return empty;
  const raw = v as { root?: unknown; focus?: unknown };
  let root = parseNode(raw.root, new Set(), 0) ?? null;
  if (!root) return empty;
  const seen = new Set<string>();
  for (const l of paneLeaves(root)) {
    if (l.sessionId === null) continue;
    if (seen.has(l.sessionId)) root = removeNode(root, l.id).root!;
    else seen.add(l.sessionId);
  }
  const leaves = paneLeaves(root);
  const focus = typeof raw.focus === 'string' && leaves.some((l) => l.id === raw.focus) ? raw.focus : leaves[0]!.id;
  return { root, focus };
}

// ---- 画面との関係 ----

/**
 * セッションへ移った（画面が session になった、または別のセッションに替わった）あとで、木を画面に合わせる。
 * 木にあればそのペインを操作中にし、無ければ操作中のペインの中身を替え、木が無ければペイン 1 つを作る。
 * 画面が変わっていないときは何もしない（空のペインを操作中にしただけで、中身を奪わない）。
 */
export function followScreen(prev: State['screen'], state: State): State {
  const screen = state.screen;
  if (screen.name !== 'session') return state;
  if (prev.name === 'session' && prev.id === screen.id) return state;
  const id = screen.id;
  const { root, focus, zoom } = state.panes;
  if (!root) {
    const leaf: PaneLeaf = { kind: 'pane', id: 'p1', sessionId: id, toc: false };
    return { ...state, panes: { ...state.panes, root: leaf, focus: leaf.id, zoom: null } };
  }
  const here = leafOfSession(root, id);
  if (here) {
    if (focus === here.id) return state;
    return { ...state, panes: { ...state.panes, focus: here.id, zoom: zoom === here.id ? zoom : null } };
  }
  const target = findLeaf(root, focus) ?? paneLeaves(root)[0]!;
  return { ...state, panes: { ...state.panes, root: mapNode(root, target.id, (n) => ({ ...(n as PaneLeaf), sessionId: id })), focus: target.id } };
}

/** 消された（Store から行が消えた）セッションのペインを外す。Store がまだ読み込まれていないときは何もしない。 */
export function prunePanes(state: State, store: Store): State {
  if (!store.bootstrapped) return state;
  let { root, focus, zoom, flash } = state.panes;
  const gone = paneLeaves(root).filter((l) => l.sessionId !== null && !(l.sessionId in store.sessions));
  if (gone.length === 0) return state;
  for (const l of gone) {
    const r = removeNode(root!, l.id);
    root = r.root;
    if (focus === l.id) focus = r.sibling ? paneLeaves(r.sibling)[0]!.id : null;
    if (zoom === l.id) zoom = null;
    if (flash?.pane === l.id) flash = null;
    if (!root) { focus = null; zoom = null; flash = null; break; }
  }
  if (root && !findLeaf(root, focus)) focus = paneLeaves(root)[0]!.id;
  return { ...state, panes: { root, focus, zoom, flash } };
}

/** 木か操作中が変わったときだけ、保存の Effect を 1 つ足す。最大化と光らせるのは保存しない。 */
export function savePanes(prev: State, state: State, effects: Effect[]): Effect[] {
  if (prev.panes.root === state.panes.root && prev.panes.focus === state.panes.focus) return effects;
  return [...effects, { kind: 'storage.save', key: PANES_KEY, value: { root: state.panes.root, focus: state.panes.focus } }];
}

/**
 * 端末をつないでおくセッション。
 * セッション画面にいる間は、木にある全部のペインのセッションである（最大化で隠れたペインも含める）。
 * セッション画面の外では何もつながない。
 */
export function paneSessions(state: State): string[] {
  if (state.screen.name !== 'session') return [];
  const ids = paneLeaves(state.panes.root).map((l) => l.sessionId).filter((s): s is string => s !== null);
  // 木が画面に追いつく前（followScreen の前）でも、開いている画面のセッションは含める。
  return ids.includes(state.screen.id) ? ids : [...ids, state.screen.id];
}

/** そのセッションの端末をつないでおくか。 */
export const paneShows = (state: State, sessionId: string): boolean => paneSessions(state).includes(sessionId);

/**
 * 並べたペインの端末の接続を、木と画面に合わせる。
 * 画面（screen.ts）は操作中のセッションだけをつなぎ、離れたセッションを切る。
 * 並べたペインでは、操作中でないペインも接続を保たないと、データが届かず描画が止まり、寸法が tmux へ届かず右端が欠け、ホイールが tmux へ届かずスクロールできない。
 * そこで、まだ見えているセッションを切る Effect を落とし、見えなくなったセッションを切り、新しく見えたセッションをつなぐ。
 * 分割していないときは、画面が出す Effect と同じになるので何も足さない。
 */
export function paneTerminals(prev: State, state: State, effects: Effect[]): Effect[] {
  const before = paneSessions(prev);
  const after = paneSessions(state);
  const kept = effects.filter((e) => !(e.kind === 'terminal.disconnectSession' && after.includes(e.sessionId)));
  const off = new Set(kept.flatMap((e) => (e.kind === 'terminal.disconnectSession' ? [e.sessionId] : [])));
  const on = new Set(kept.flatMap((e) => (e.kind === 'terminal.connect' ? [e.sessionId] : [])));
  const extra: Effect[] = [
    ...before.filter((s) => !after.includes(s) && !off.has(s)).map((s): Effect => ({ kind: 'terminal.disconnectSession', sessionId: s })),
    ...after.filter((s) => !before.includes(s) && !on.has(s)).map((s): Effect => ({ kind: 'terminal.connect', sessionId: s, tabId: null })),
  ];
  return kept.length === effects.length && extra.length === 0 ? effects : [...kept, ...extra];
}

// ---- 入力 ----

type PaneAction = Extract<UiAction, { type: `pane.${string}` }>;

const withPanes = (state: State, panes: Partial<PanesState>): State => ({ ...state, panes: { ...state.panes, ...panes } });

/** 操作中のペインのセッションへ画面を合わせる。いま session 画面で、別のセッションのときだけ。履歴は置き換える。 */
function alignScreen(state: State): Effect[] {
  const s = findLeaf(state.panes.root, state.panes.focus)?.sessionId;
  if (!s || state.screen.name !== 'session' || state.screen.id === s) return [];
  return [{ kind: 'navigate', route: { name: 'session', id: s }, replace: true }];
}

/** セッションの画面へ移る（履歴を積む）。すでにそのセッションの画面なら何もしない。 */
function goSession(state: State, sessionId: string | null): Effect[] {
  if (!sessionId || (state.screen.name === 'session' && state.screen.id === sessionId)) return [];
  return [{ kind: 'navigate', route: { name: 'session', id: sessionId } }];
}

/** 操作中を移すと、別のペインを最大化したままにはしない。 */
const focused = (state: State, pane: PaneId): State => withPanes(state, { focus: pane, zoom: state.panes.zoom === pane ? pane : null });

function flashed(state: State, pane: PaneId): State {
  return withPanes(state, { flash: { pane, n: (state.panes.flash?.n ?? 0) + 1 } });
}

/** 木にあるセッションを開く。新しく開かず、そのペインを操作中にして光らせ、知らせを出す。 */
function reveal(state: State, store: Store, leaf: PaneLeaf): Step {
  const next = flashed(focused(state, leaf.id), leaf.id);
  const toast: Effect = { kind: 'toast', level: 'info', message: translatorOf(store)('mediator.pane.alreadyOpen') };
  return { state: next, effects: [...goSession(next, leaf.sessionId), toast] };
}

function openSession(state: State, store: Store, sessionId: string, target: PaneId | null, side: PaneDropSide): Step {
  const { root, focus } = state.panes;
  const there = leafOfSession(root, sessionId);
  if (there) return reveal(state, store, there);
  if (!root) {
    const leaf: PaneLeaf = { kind: 'pane', id: 'p1', sessionId, toc: false };
    const next = withPanes(state, { root: leaf, focus: leaf.id, zoom: null });
    return { state: next, effects: goSession(next, sessionId) };
  }
  const t = findLeaf(root, target ?? focus) ?? paneLeaves(root)[0]!;
  if (side === 'center') {
    const next = focused(withPanes(state, { root: mapNode(root, t.id, (n) => ({ ...(n as PaneLeaf), sessionId })) }), t.id);
    return { state: next, effects: goSession(next, sessionId) };
  }
  const n = nextSeq(root);
  const leaf: PaneLeaf = { kind: 'pane', id: `p${n}`, sessionId, toc: false };
  const next = focused(withPanes(state, { root: splitAt(root, t.id, leaf, side, `n${n + 1}`) }), leaf.id);
  return { state: next, effects: goSession(next, sessionId) };
}

/** 操作中のペインを移して、画面を合わせる（履歴は置き換え）。 */
function refocus(state: State, pane: PaneId): Step {
  if (!findLeaf(state.panes.root, pane)) return { state, effects: [] };
  const next = focused(state, pane);
  return { state: next, effects: alignScreen(next) };
}

function removePane(state: State, store: Store, pane: PaneId): Step {
  const { root, focus, zoom, flash } = state.panes;
  if (!root || !findLeaf(root, pane)) return { state, effects: [] };
  if (root.id === pane) return { state, effects: [{ kind: 'toast', level: 'info', message: translatorOf(store)('mediator.pane.lastPane') }] };
  const r = removeNode(root, pane);
  const nextFocus = focus === pane ? paneLeaves(r.sibling)[0]!.id : focus;
  const next = withPanes(state, { root: r.root, focus: nextFocus, zoom: zoom === pane ? null : zoom, flash: flash?.pane === pane ? null : flash });
  return { state: next, effects: focus === pane ? alignScreen(next) : [] };
}

function movePane(state: State, pane: PaneId, target: PaneId, side: PaneDropSide): Step {
  const { root } = state.panes;
  const a = findLeaf(root, pane);
  const b = findLeaf(root, target);
  if (!root || !a || !b || pane === target) return { state, effects: [] };
  let moved: PaneNode;
  if (side === 'center') {
    // 位置を入れ替える。葉ごと動くので、id とセッションの組は変わらない。
    moved = mapNode(mapNode(root, pane, () => ({ ...b, id: '\u0000' })), target, () => a);
    moved = mapNode(moved, '\u0000', () => b);
  } else {
    const n = nextSeq(root);
    moved = splitAt(removeNode(root, pane).root!, target, a, side, `n${n}`);
  }
  const next = focused(withPanes(state, { root: moved }), pane);
  return { state: next, effects: alignScreen(next) };
}

function setRatio(root: PaneNode, f: (s: PaneSplit) => number): PaneNode {
  if (root.kind === 'pane') return root;
  const a = setRatio(root.a, f);
  const b = setRatio(root.b, f);
  const ratio = f(root);
  return a === root.a && b === root.b && ratio === root.ratio ? root : { ...root, ratio, a, b };
}

/** 分割の入力（pane.*）。木と操作中を変え、画面を合わせる。保存は整え（transition.ts の settled）が 1 か所で足す。 */
export function paneStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind !== 'action' || !input.action.type.startsWith('pane.')) return null;
  const i = input.action as PaneAction;
  const { root, focus } = state.panes;
  // 次に光らせる以外の入力では、前の光らせるのを下げる。
  const quiet = state.panes.flash && i.type !== 'pane.open' && i.type !== 'pane.fill' ? withPanes(state, { flash: null }) : state;
  const behind = canMoveBehind(state);
  // 画面を移す入力は、確認や入力のあるダイアログの裏では何もしない。パレットなどは閉じてから移る。
  const moving = (s: State) => ({ ...s, overlay: closeTransient(s) });
  // 開く入力は、光らせなかったなら前の光らせるのを下げる（光らせたときは flash が新しい値に替わっている）。
  const settle = (r: Step): Step => (r.state.panes.flash === state.panes.flash && state.panes.flash ? { ...r, state: withPanes(r.state, { flash: null }) } : r);
  switch (i.type) {
    case 'pane.open': return behind ? mapStep(settle(openSession(quiet, store, i.sessionId, i.target, i.side)), moving) : { state, effects: [] };
    case 'pane.fill': {
      if (!behind) return { state, effects: [] };
      const there = leafOfSession(root, i.sessionId);
      if (there) return mapStep(reveal(quiet, store, there), moving);
      if (!findLeaf(root, i.pane)) return { state, effects: [] };
      const next = focused(withPanes(quiet, { root: mapNode(root!, i.pane, (n) => ({ ...(n as PaneLeaf), sessionId: i.sessionId })) }), i.pane);
      return mapStep(settle({ state: next, effects: goSession(next, i.sessionId) }), moving);
    }
    case 'pane.openEmpty': {
      const t = findLeaf(root, focus);
      if (!root || !t) return { state, effects: [] };
      const n = nextSeq(root);
      const leaf: PaneLeaf = { kind: 'pane', id: `p${n}`, sessionId: null, toc: false };
      return { state: focused(withPanes(quiet, { root: splitAt(root, t.id, leaf, i.side, `n${n + 1}`) }), leaf.id), effects: [] };
    }
    case 'pane.remove': return removePane(quiet, store, i.pane);
    case 'pane.removeOthers': {
      const keep = findLeaf(root, i.pane);
      if (!keep || root === keep) return { state, effects: [] };
      const next = withPanes(quiet, { root: keep, focus: keep.id, zoom: null });
      return { state: next, effects: alignScreen(next) };
    }
    case 'pane.move': return movePane(quiet, i.pane, i.target, i.side);
    case 'pane.resize': {
      if (!root || !Number.isFinite(i.ratio)) return { state, effects: [] };
      const ratio = clampRatio(i.ratio);
      return { state: withPanes(quiet, { root: mapNode(root, i.node, (n) => (n.kind === 'split' ? { ...n, ratio } : n)) }), effects: [] };
    }
    case 'pane.equalize': return root ? { state: withPanes(quiet, { root: setRatio(root, () => 0.5) }), effects: [] } : { state, effects: [] };
    case 'pane.focus': return behind ? mapStep(refocus(quiet, i.pane), moving) : { state, effects: [] };
    case 'pane.zoom': {
      if (!findLeaf(root, i.pane)) return { state, effects: [] };
      const off = state.panes.zoom === i.pane;
      const next = withPanes(quiet, { zoom: off ? null : i.pane, focus: i.pane });
      return { state: next, effects: alignScreen(next) };
    }
    case 'pane.toc': {
      const leaf = findLeaf(root, i.pane);
      if (!root || !leaf || paneLeaves(root).length < 2) return { state, effects: [] };
      return { state: withPanes(quiet, { root: mapNode(root, i.pane, (n) => ({ ...(n as PaneLeaf), toc: !(n as PaneLeaf).toc })) }), effects: [] };
    }
  }
}

const mapStep = (r: Step, f: (s: State) => State): Step => ({ ...r, state: f(r.state) });
