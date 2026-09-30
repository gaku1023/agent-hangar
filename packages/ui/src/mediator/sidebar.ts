import type { Input, State, Step } from './types.ts';

/** サイドバーの折りたたみを残す localStorage の鍵。値は真偽値そのもの。 */
export const SIDEBAR_KEY = 'sidebar.collapsed';

/** サイドバーを帯に縮める・戻す。開閉のたびに保存し、再読み込みや再起動の後も同じ形で開く。 */
export function sidebarStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent' || input.intent.type !== 'sidebar.toggle') return null;
  const collapsed = !state.sidebarCollapsed;
  return { state: { ...state, sidebarCollapsed: collapsed }, effects: [{ kind: 'storage.save', key: SIDEBAR_KEY, value: collapsed }] };
}
