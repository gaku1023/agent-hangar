import type { Input, State, Step } from './types.ts';

/** サイドバーの折りたたみを残す localStorage の鍵。値は真偽値そのもの。 */
export const SIDEBAR_KEY = 'sidebar.collapsed';

/** サイドバーを帯に縮める・戻す。開閉のたびに保存し、再読み込みや再起動の後も同じ形で開く。 */
export function sidebarStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent' || input.intent.type !== 'sidebar.toggle') return null;
  const collapsed = !state.sidebarCollapsed;
  return { state: { ...state, sidebarCollapsed: collapsed }, effects: [{ kind: 'storage.save', key: SIDEBAR_KEY, value: collapsed }] };
}

/** サイドバーの「動いている」の並びを残す localStorage の鍵。値はセッションの id の配列。 */
export const SIDEBAR_ORDER_KEY = 'sidebar.order';

/** 並びを id の配列に整える。配列でなければ空にし、文字列でない要素と重なりは落とす。 */
export function cleanSidebarOrder(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))];
}

/** 覚える id の上限。抜けたセッションの席も覚えておくので、決めておかないと増え続ける。 */
export const SIDEBAR_ORDER_MAX = 200;

/**
 * 並べ替えた結果（いま動いている行の並び）を、覚えた並びに織り込む。
 * 動いている行が座っていた席だけを新しい順で埋め直し、抜けているセッションの席は動かさない。resume したときに元の場所へ戻すためである。
 * まだ覚えていない id が混じっていたら末尾に足す。
 */
export function mergeSidebarOrder(order: string[], moved: string[]): string[] {
  const known = new Set(order);
  const seats = moved.filter((id) => known.has(id));
  const taken = new Set(seats);
  let i = 0;
  return [...order.map((id) => (taken.has(id) ? seats[i++]! : id)), ...moved.filter((id) => !known.has(id))];
}

/** 上限を超えた分を、動いていないものの先頭の側から落とす。動いているものは落とさない。超えていなければ元のまま返す。 */
export function trimSidebarOrder(order: string[], live: string[]): string[] {
  let over = order.length - SIDEBAR_ORDER_MAX;
  if (over <= 0) return order;
  const on = new Set(live);
  return order.filter((id) => on.has(id) || over-- <= 0);
}

/** 「動いている」の行を並べ替えたとき。並びを覚え、保存する。ドラッグの途中は部品の中だけで動かし、ここへは離したときだけ来る。 */
export function sidebarOrderStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent' || input.intent.type !== 'sidebar.order') return null;
  const order = mergeSidebarOrder(state.sidebarOrder, cleanSidebarOrder(input.intent.ids));
  return { state: { ...state, sidebarOrder: order }, effects: [{ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: order }] };
}

/**
 * 動いているセッションの顔ぶれが変わったとき。
 * 初めて現れたものを、届いた順（始めた順）で並びの末尾に書き足す。場所はここで決まり、以後は利用者が動かすまで変わらない。
 * 減ったときは何もしない。抜けたセッションの席を残しておき、戻ってきたら同じ場所に出す。
 */
export function sidebarLiveStep(state: State, input: Input): Step | null {
  if (input.kind !== 'runtime' || input.event.type !== 'live.changed') return null;
  const known = new Set(state.sidebarOrder);
  const fresh = input.event.ids.filter((id) => !known.has(id));
  if (fresh.length === 0) return { state, effects: [] };
  const order = trimSidebarOrder([...state.sidebarOrder, ...fresh], input.event.ids);
  return { state: { ...state, sidebarOrder: order }, effects: [{ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: order }] };
}

/** 右ペインの上下の比率を残す localStorage の鍵。値は 0.2〜0.8 の数そのもの。 */
export const LIVE_PANE_SPLIT_KEY = 'livePane.split';
/** はじめは半分。「いま」は右ペインの高さの半分までにし、残りを目次に渡す。 */
export const LIVE_PANE_SPLIT_DEFAULT = 0.5;

/** 比率を 0.2〜0.8 に丸める。どちらへ寄せても、上の段と目次の両方を残す。数でなければ既定に戻す。 */
export function clampLivePaneSplit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0.2, Math.min(0.8, v)) : LIVE_PANE_SPLIT_DEFAULT;
}

/** 右ペインの境目を離したとき。丸めて覚え、保存する。ドラッグの途中は部品の中だけで動かし、ここへは来ない。 */
export function livePaneSplitStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent' || input.intent.type !== 'livePane.split') return null;
  const ratio = clampLivePaneSplit(input.intent.ratio);
  return { state: { ...state, livePaneSplit: ratio }, effects: [{ kind: 'storage.save', key: LIVE_PANE_SPLIT_KEY, value: ratio }] };
}
