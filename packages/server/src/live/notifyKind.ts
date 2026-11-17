import type { NotifyKind } from '@agent-hangar/shared';

/**
 * notify_user が呼ばれたことと、その場面（kind）の購読。
 * 出し先が空になる呼び出し（知らせ方の決まり、休みの会話）も流れる。断られた呼び出しは流れない。
 * 統括への出来事の送り込み（orchestrator/feed.ts）が、turn.done を出すかどうかを決めるのに使う。
 * 未読の購読（live/unread.ts の onUnread）は出し先が空だと流れず、hangar が出し忘れの受け皿で積む未読も流れないので、別にした。
 * immediate は、エージェントではなく hangar が代わりに知らせるもの。
 */
type Listener = (sessionId: string, kind: NotifyKind, immediate: boolean) => void;
const listeners = new Set<Listener>();

export function onNotifyKind(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function noteNotifyKind(sessionId: string, kind: NotifyKind, immediate = false): void {
  for (const cb of listeners) {
    try { cb(sessionId, kind, immediate); } catch (e) { console.error('[notify] a listener failed', e instanceof Error ? e.constructor.name : typeof e); }
  }
}
