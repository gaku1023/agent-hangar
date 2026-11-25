import { describe, expect, it } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import type { SessionViewState } from '../mediator/types.ts';
import { sessionDto } from '../test/sessionDto.ts';
import { tocFolds } from './tocFold.ts';

const stats = { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null };
const view = { agentId: null } as unknown as SessionViewState;
const withSession = (over: Partial<SessionDto> = {}): Store => {
  const s = initialStore();
  return { ...s, sessions: { s1: sessionDto({ id: 's1', hasTranscript: true, stats, ...over }) } };
};
const withPeer = (store: Store, status: 'busy' | 'idle' | 'waiting' | 'stopped' | null): Store =>
  ({ ...store, peerChat: { s1: { status } as unknown as Store['peerChat'][string] } });

describe('tocFolds', () => {
  it('ターンの少ない終わった会話は、はじめ畳む', () => {
    expect(tocFolds(withSession(), view, 's1', false)).toBe(true);
  });
  it('別の PC で動いている会話（peer chat が止まっていない）は、ターンが少なくても畳まない', () => {
    for (const st of ['busy', 'idle', 'waiting'] as const) expect(tocFolds(withPeer(withSession(), st), view, 's1', false)).toBe(false);
  });
  it('別の PC の会話でも、止まっていれば今までどおり畳む', () => {
    expect(tocFolds(withPeer(withSession(), 'stopped'), view, 's1', false)).toBe(true);
    expect(tocFolds(withPeer(withSession(), null), view, 's1', false)).toBe(true);
  });
});
