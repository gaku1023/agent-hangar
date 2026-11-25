import type { PeerChatAsk } from '@agent-hangar/shared';
import type { Store } from './store.ts';

/**
 * この PC の会話の、いま出ている札（許可と質問）。会話ごとに 1 枚。
 * 最初の状態は bootstrap の peerAsks、あとは session.ask の知らせで置き換わる。
 * pending は答えを送って結果を待っている間。answered は答えが通ったあとの記録の文（札が閉じても、片付けるまで見せる）。
 * gone は、答えの結果が着く前に札が閉じた印（結果が着いたら記録を出す）。
 */
export type LocalAsk = { ask: PeerChatAsk; pending: boolean; answered: string | null; gone: boolean };

const fresh = (ask: PeerChatAsk): LocalAsk => ({ ask, pending: false, answered: null, gone: false });

/** bootstrap の peerAsks（古いサーバは無いので空として読む）。 */
export function asksOf(peerAsks: Record<string, PeerChatAsk> | undefined): Record<string, LocalAsk> {
  return Object.fromEntries(Object.entries(peerAsks ?? {}).map(([id, a]) => [id, fresh(a)]));
}

function put(store: Store, sessionId: string, next: LocalAsk | undefined): Store {
  const { [sessionId]: _, ...rest } = store.localAsks;
  return { ...store, localAsks: next ? { ...rest, [sessionId]: next } : rest };
}

/** session.ask の知らせ。札が出た・替わったら置き、閉じたら外す（答えの結果を待っている札と、記録を見せている札は残す）。 */
export function askUpdated(store: Store, sessionId: string, ask: PeerChatAsk | null): Store {
  const cur = store.localAsks[sessionId];
  if (ask === null) {
    if (!cur) return store;
    if (cur.answered !== null) return store;
    if (cur.pending) return cur.gone ? store : put(store, sessionId, { ...cur, gone: true });
    return put(store, sessionId, undefined);
  }
  if (cur && cur.ask.askId === ask.askId) return JSON.stringify(cur.ask) === JSON.stringify(ask) && !cur.gone ? store : put(store, sessionId, { ...cur, ask, gone: false });
  return put(store, sessionId, fresh(ask));
}

/** 答えを送った。結果が着くまで押せなくする。 */
export function askAnswerStarted(store: Store, sessionId: string, askId: string): Store {
  const cur = store.localAsks[sessionId];
  return cur && cur.ask.askId === askId && !cur.pending ? put(store, sessionId, { ...cur, pending: true }) : store;
}

/** 答えが通った。記録の文を持つ。 */
export function askAnswered(store: Store, sessionId: string, askId: string, line: string): Store {
  const cur = store.localAsks[sessionId];
  return cur && cur.ask.askId === askId ? put(store, sessionId, { ...cur, pending: false, gone: false, answered: line }) : store;
}

/** 答えが断られた。また押せる形に戻す（札がもう閉じていれば外す）。 */
export function askAnswerFailed(store: Store, sessionId: string, askId: string): Store {
  const cur = store.localAsks[sessionId];
  if (!cur || cur.ask.askId !== askId) return store;
  return cur.gone ? put(store, sessionId, undefined) : put(store, sessionId, { ...cur, pending: false });
}

/** 記録を見せ終えた札を片付ける。 */
export function askSettled(store: Store, sessionId: string): Store {
  const cur = store.localAsks[sessionId];
  return cur && cur.answered !== null ? put(store, sessionId, undefined) : store;
}
