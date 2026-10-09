import { defaultSessionView, persistedSessionView } from './sessionView.ts';
import { liveSessionIds, type Store } from '../store/store.ts';
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
 * 動いているセッションの顔ぶれを、ストアから読んで並びに合わせる（store.ts の liveSessionIds）。ストアが変わるたびに呼ばれる。
 * 初めて現れたものを、始めた順で並びの末尾に書き足す。場所はここで決まり、以後は利用者が動かすまで変わらない。
 * 減ったときは何もしない。抜けたセッションの席を残しておき、戻ってきたら同じ場所に出す。
 * 書き足したものは並びに残るので、顔ぶれが同じ間は何度呼ばれても何もしない。
 */
export function sidebarLiveStep(state: State, store: Store): Step {
  const ids = liveSessionIds(store);
  const known = new Set(state.sidebarOrder);
  const fresh = ids.filter((id) => !known.has(id));
  if (fresh.length === 0) return { state, effects: [] };
  const order = trimSidebarOrder([...state.sidebarOrder, ...fresh], ids);
  return { state: { ...state, sidebarOrder: order }, effects: [{ kind: 'storage.save', key: SIDEBAR_ORDER_KEY, value: order }] };
}

/**
 * 最後に動かした右ペインの上下の比率を残す localStorage の鍵。値は 0〜1 の数そのもの。
 * セッションごとの値は sv:<id> の livePaneSplit に残し、こちらはまだ境目を動かしていないセッションを開くときに使う。
 */
export const LIVE_PANE_SPLIT_KEY = 'livePane.split';
/** はじめは半分。「いま」は右ペインの高さの半分までにし、残りを目次に渡す。 */
export const LIVE_PANE_SPLIT_DEFAULT = 0.5;

/** 比率を 0〜1 に丸める。どちらの端でも見出しの 1 行は CSS の下限で残る（設計書 ④）。数でなければ既定に戻す。 */
export function clampLivePaneSplit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : LIVE_PANE_SPLIT_DEFAULT;
}

/** 保存から読んだセッションごとの比率を整える。数でなければ持たないもの（null）とし、数なら 0〜1 に丸める。 */
export function readSessionLivePaneSplit(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? clampLivePaneSplit(v) : null;
}

/**
 * 右ペインの境目を離したとき。丸めて、そのセッションの値と最後に動かした値の両方に覚え、保存する。
 * ダブルクリックで半分に戻すのも、動かしたのと同じに扱う。
 * ドラッグの途中は部品の中だけで動かし、ここへは来ない。
 */
export function livePaneSplitStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent' || input.intent.type !== 'livePane.split') return null;
  const { sessionId: id } = input.intent;
  const ratio = clampLivePaneSplit(input.intent.ratio);
  const view = { ...(state.sessionView[id] ?? defaultSessionView()), livePaneSplit: ratio };
  return {
    state: { ...state, livePaneSplit: ratio, sessionView: { ...state.sessionView, [id]: view } },
    effects: [{ kind: 'storage.save', key: LIVE_PANE_SPLIT_KEY, value: ratio }, { kind: 'storage.save', key: `sv:${id}`, value: persistedSessionView(view) }],
  };
}
