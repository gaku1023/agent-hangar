import type { PaneId, UiAction } from '@agent-hangar/shared';
import type { KeyId } from '../keys.ts';
import { paneLeaves, type PanesState } from '../mediator/panes.ts';
import type { PaneDir } from './paneNeighbor.ts';

/** 矢印キーの key を向きにする。 */
const DIR: Record<string, PaneDir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/**
 * 画面の分割のキー（keys.ts の pane.*）と、分割中の ⌘J を、出す入力にする。
 * 操作が向かうのは操作中のペイン（panes.focus）。セッション画面の外では、分割のキーは何も出さない。
 * ⌘J（transcript.toggle）は、ペインが 2 つ以上のときは操作中のペインの右パネル（pane.toc）に向ける。1 つのときは今までどおりの transcript.toggle である。
 * 隣のペインは位置で決まる（DOM の矩形）ので、求める関数 neighbor を呼び出し側から受ける。
 * 分割に関係の無いキーは null を返す。出す入力が無い（隣が無いなど）ときは、none を返して打鍵を取らない。
 */
export function paneKeyAction(id: KeyId, ctx: { panes: PanesState; onSession: boolean; key: string; neighbor: (from: PaneId, dir: PaneDir) => PaneId | null }): UiAction | 'none' | null {
  const { panes } = ctx;
  if (id === 'transcript.toggle') {
    return ctx.onSession && panes.focus && paneLeaves(panes.root).length >= 2 ? { type: 'pane.toc', pane: panes.focus } : null;
  }
  switch (id) {
    case 'pane.splitRight': return ctx.onSession ? { type: 'pane.openEmpty', side: 'right' } : 'none';
    case 'pane.splitDown': return ctx.onSession ? { type: 'pane.openEmpty', side: 'down' } : 'none';
    case 'pane.remove': return ctx.onSession && panes.focus ? { type: 'pane.remove', pane: panes.focus } : 'none';
    case 'pane.zoom': return ctx.onSession && panes.focus ? { type: 'pane.zoom', pane: panes.focus } : 'none';
    case 'pane.focusDir': {
      const dir = DIR[ctx.key];
      const to = ctx.onSession && panes.focus && dir ? ctx.neighbor(panes.focus, dir) : null;
      return to ? { type: 'pane.focus', pane: to } : 'none';
    }
    default: return null;
  }
}
