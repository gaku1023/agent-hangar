import type { LiveStatus, PaneId, StopReason } from '@agent-hangar/shared';
import { asideOf } from '../lib/aside.ts';
import { paneLeaves, type PaneNode } from '../mediator/panes.ts';
import type { State } from '../mediator/types.ts';
import { liveSessionIds, shownLive, shownReason, type Store } from '../store/store.ts';
import { translatorOf } from './i18n.ts';
import { presentSession, type SessionProps } from './session.ts';

/** 空のペインに出す、動いているセッションの 1 行。 */
export type PickerRow = { id: string; name: string; live: LiveStatus | null; aside: boolean; reason: StopReason | null };

/**
 * 分割した本体（PaneWorkspace）の中身。
 * screens はセッションの入ったペインごとの SessionProps（presentSession にペインの sessionId を渡したもの）。
 * picker は空のペインに出す一覧で、すでに木にあるセッションは入れない。
 */
export type PanesProps = {
  root: PaneNode;
  focus: PaneId | null;
  zoom: PaneId | null;
  flash: { pane: PaneId; n: number } | null;
  screens: Record<PaneId, SessionProps>;
  picker: PickerRow[];
};

/** セッション画面で、ペインが 2 つ以上のときだけ返す。1 つ以下なら null（今までの 1 画面）。 */
export function presentPanes(state: State, store: Store, now: number): PanesProps | null {
  const { root, focus, zoom, flash } = state.panes;
  if (state.screen.name !== 'session' || !root) return null;
  const leaves = paneLeaves(root);
  if (leaves.length < 2) return null;
  const screens: Record<PaneId, SessionProps> = {};
  for (const l of leaves) if (l.sessionId !== null) screens[l.id] = presentSession(state, store, now, l.sessionId);
  const inTree = new Set(leaves.map((l) => l.sessionId));
  const t = translatorOf(store);
  const picker = liveSessionIds(store).filter((id) => !inTree.has(id)).map((id): PickerRow => {
    const s = store.sessions[id]!;
    const live = shownLive(s);
    return { id, name: s.name ?? t('common.label.noName'), live, aside: asideOf(s.live, s.liveAside) !== null, reason: shownReason(s, live) };
  });
  return { root, focus, zoom: zoom && leaves.some((l) => l.id === zoom) ? zoom : null, flash, screens, picker };
}
