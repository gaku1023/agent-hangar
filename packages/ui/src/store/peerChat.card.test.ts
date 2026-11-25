import { describe, expect, it } from 'vitest';
import type { PeerChatCard, PeerChatUpdate } from '@agent-hangar/shared';
import { applyState, applyUpdate, emptySlice } from './peerChat.ts';

const card: PeerChatCard = { aside: null, turnFrom: 0, digest: { sessionId: 's', turnStartSeq: null, intent: null, agents: [] }, events: [], waitingFor: null, permission: null, limit: null, activity: null, artifacts: 0, hints: true };
const update = (over: Partial<PeerChatUpdate> = {}): PeerChatUpdate => ({ sessionId: 's', link: 'online', replace: false, status: 'busy', items: [], queued: [], cursor: null, ...over });

describe('PeerChatSlice.card', () => {
  it('update の札の材料を持ち、材料の無い update（古い相手、止まった会話）で外す', () => {
    const s = applyUpdate(emptySlice('v'), update({ card }));
    expect(s.card).toEqual(card);
    expect(applyUpdate(s, update()).card).toBeNull();
  });

  it('操作の答えの状態にも従う', () => {
    const s = applyState(emptySlice('v'), { sessionId: 's', status: 'busy', items: [], queued: [], cursor: null, truncated: false, card });
    expect(s.card).toEqual(card);
    expect(applyState(s, { sessionId: 's', status: 'idle', items: [], queued: [], cursor: null, truncated: false }).card).toBeNull();
  });
});
