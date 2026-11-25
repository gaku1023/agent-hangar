import type { PeerChatAsk } from '@agent-hangar/shared';

/**
 * この PC の会話の札の変化を拾い、画面へ session.ask を流す。
 * 札の中身が前に流したものと同じなら流さない（実行中の一覧が変わるたびに呼ばれるため）。
 * 札が出た、替わった（askId や選択肢、答えの記録が変わった）、閉じた（null を 1 回だけ）ときに流す。
 * 流した札は覚えておき、bootstrap の peerAsks（snapshot）に使う。
 */
export type SessionAskEvent = { type: 'session.ask'; sessionId: string; ask: PeerChatAsk | null };

export type AskWatch = {
  /** 1 つの会話の札を読み直し、変わっていれば流す。 */
  check(sessionId: string): void;
  /** 候補の会話と、札を覚えている会話を全部読み直す。 */
  checkAll(): void;
  /** いま覚えている札（会話の id ごと）。 */
  snapshot(): Record<string, PeerChatAsk>;
};

export function createAskWatch(d: {
  currentAsk(sessionId: string): PeerChatAsk | null;
  /** 札が出ているかもしれない会話（待ちの会話など）。覚えている会話は含めなくてよい。 */
  candidates(): string[];
  emit(ev: SessionAskEvent): void;
}): AskWatch {
  const known = new Map<string, { key: string; ask: PeerChatAsk }>();
  function check(sessionId: string): void {
    let ask: PeerChatAsk | null;
    try {
      ask = d.currentAsk(sessionId);
    } catch (e) {
      console.error('[ask-watch] could not read an ask', e instanceof Error ? e.constructor.name : typeof e);
      return;
    }
    const prev = known.get(sessionId);
    if (!ask) {
      if (!prev) return;
      known.delete(sessionId);
      d.emit({ type: 'session.ask', sessionId, ask: null });
      return;
    }
    const key = JSON.stringify(ask);
    if (prev?.key === key) return;
    known.set(sessionId, { key, ask });
    d.emit({ type: 'session.ask', sessionId, ask });
  }
  return {
    check,
    checkAll() {
      for (const id of new Set([...d.candidates(), ...known.keys()])) check(id);
    },
    snapshot: () => Object.fromEntries([...known].map(([id, k]) => [id, k.ask])),
  };
}
