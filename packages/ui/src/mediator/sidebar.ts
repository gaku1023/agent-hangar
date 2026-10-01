import type { Input, State, Step } from './types.ts';

/** サイドバーの折りたたみを残す localStorage の鍵。値は真偽値そのもの。 */
export const SIDEBAR_KEY = 'sidebar.collapsed';

/** サイドバーを帯に縮める・戻す。開閉のたびに保存し、再読み込みや再起動の後も同じ形で開く。 */
export function sidebarStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent' || input.intent.type !== 'sidebar.toggle') return null;
  const collapsed = !state.sidebarCollapsed;
  return { state: { ...state, sidebarCollapsed: collapsed }, effects: [{ kind: 'storage.save', key: SIDEBAR_KEY, value: collapsed }] };
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
