import { describe, expect, it } from 'vitest';
import * as shared from './index.ts';
import type { PeerChatState } from './index.ts';

describe('PeerChatState.card（現在の札の材料）', () => {
  const base = { sessionId: 's', status: 'busy', items: [], queued: [], cursor: null, truncated: false };
  const card = {
    aside: { shell: false, agents: 1 }, turnFrom: 3,
    digest: { sessionId: 's', turnStartSeq: 3, intent: { text: 'やること', at: 5, stepsSince: 1, inThisTurn: true }, agents: [{ agentId: 'a', title: 't', state: 'running', startedAt: 1, lastAt: null, last: { text: 'x', mono: false, kind: 'read', isError: false }, report: null, endNote: null, linked: true }] },
    events: [{ kind: 'user', seq: 3, ts: 1, text: 'hi' }, { kind: 'tool_call', seq: 4, toolId: 'u', name: 'Read', input: { file_path: '/a/b.ts' } }, { kind: 'tool_result', seq: 5, toolId: 'u', isError: false }],
    droppedCalls: 2, waitingFor: null, permission: null, limit: null, activity: null, artifacts: 1, hints: true,
  };
  const stateOf = (v: unknown) => (shared.parsePeerChatReply({ ok: true, state: v }) as { state: PeerChatState }).state;

  it('札の材料を残し、知らない欄は捨てる', () => {
    expect(stateOf({ ...base, card: { ...card, extra: 1 } }).card).toEqual(card);
  });

  it('札が無い状態（古い相手）はそのまま読める。status は今の 4 値のままで、aside は札の欄で運ぶ', () => {
    expect('card' in stateOf(base)).toBe(false);
    expect(shared.parsePeerChatReply({ ok: true, state: { ...base, status: 'aside' } })).toBeNull();
  });

  it('札の形が違うときは札だけを捨て、答え全体は断らない', () => {
    const r = stateOf({ ...base, card: { ...card, events: [{ kind: 'tool_call', seq: 'x' }] } });
    expect(r.items).toEqual([]);
    expect('card' in r).toBe(false);
    expect('card' in stateOf({ ...base, card: 7 })).toBe(false);
  });
});
