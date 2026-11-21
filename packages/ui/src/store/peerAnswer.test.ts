import { describe, expect, it } from 'vitest';
import type { PeerChatItem, SessionDto, SessionLockDto } from '@agent-hangar/shared';
import { applyServerEvent, initialStore, remoteReasonOf, type Store } from './store.ts';
import { emptySlice } from './peerChat.ts';
import { holdPeerAnswer, peerAnswerHeld, peerAnswerUnconfirmed, releasePeerAnswer } from './peerAnswer.ts';
import { sessionDto } from '../test/sessionDto.ts';

const lock = (over: Partial<SessionLockDto> = {}): SessionLockDto => ({ deviceId: 'win', deviceName: 'win', runId: 'r1', heartbeatAt: 1, stale: false, live: 'waiting', liveAt: 10, reason: 'permission', ...over });
const peer = (l: SessionLockDto | null = lock()): SessionDto => sessionDto({ id: 's1', providerSessionId: 'u1', name: 's1', startedAt: 1, lastActivityAt: 1, hasTranscript: true, lock: l });
const withPeer = (l: SessionLockDto | null = lock()): Store => ({ ...initialStore(), sessions: { s1: peer(l) } });

describe('holdPeerAnswer', () => {
  it('許可に答えたら、待ちを外して実行中に見せる', () => {
    const s = holdPeerAnswer(withPeer(), 's1', 'a1', 'busy', 1000);
    expect(s.sessions.s1!.lock).toMatchObject({ live: 'busy', reason: null });
    expect(remoteReasonOf(s.sessions.s1!.lock!, 'waiting')).toBeNull();
    expect(peerAnswerHeld(s, 's1', 'a1')).toBe(true);
  });

  it('拒否したら、入力待ちに見せる（許可待ちの印は付けない）', () => {
    const s = holdPeerAnswer(withPeer(), 's1', 'a1', 'waiting', 1000);
    expect(s.sessions.s1!.lock).toMatchObject({ live: 'waiting', reason: null });
    expect(remoteReasonOf(s.sessions.s1!.lock!, 'waiting')).toBeNull();
  });

  it('ロックの無い会話は何もしない', () => {
    const before = withPeer(null);
    expect(holdPeerAnswer(before, 's1', 'a1', 'busy', 1000)).toBe(before);
  });
});

describe('相手からの更新', () => {
  const upsert = (s: Store, l: SessionLockDto | null) => applyServerEvent(s, { type: 'session.upsert', session: peer(l) });

  it('相手がまだ同じ許可待ちのまま（鼓動だけ進んだ）なら、答えた見え方を保つ', () => {
    const s = upsert(holdPeerAnswer(withPeer(), 's1', 'a1', 'busy', 1000), lock({ heartbeatAt: 99 }));
    expect(s.sessions.s1!.lock).toMatchObject({ live: 'busy', reason: null, heartbeatAt: 99 });
    expect(peerAnswerHeld(s, 's1', 'a1')).toBe(true);
  });

  it('相手の状態が動いたら、手元の見え方を捨てて相手を信じる', () => {
    const s = upsert(holdPeerAnswer(withPeer(), 's1', 'a1', 'busy', 1000), lock({ live: 'busy', liveAt: 20, reason: null }));
    expect(s.sessions.s1!.lock).toMatchObject({ live: 'busy', liveAt: 20 });
    expect(peerAnswerHeld(s, 's1', 'a1')).toBe(false);
  });

  it('次の許可がすぐ来たら（liveAt が変わる）、隠さずに出す', () => {
    const s = upsert(holdPeerAnswer(withPeer(), 's1', 'a1', 'busy', 1000), lock({ liveAt: 30 }));
    expect(s.sessions.s1!.lock).toMatchObject({ live: 'waiting', reason: 'permission' });
    expect(peerAnswerHeld(s, 's1', 'a1')).toBe(false);
  });

  it('run が替わったら手元の見え方を捨てる', () => {
    const held = holdPeerAnswer(withPeer(), 's1', 'a1', 'busy', 1000);
    expect(held.peerAnswered.s1).toBeDefined();
    const s = applyServerEvent(held, { type: 'session.upsert', session: peer(lock({ runId: 'r2' })) });
    expect(s.peerAnswered.s1).toBeUndefined();
  });
});

describe('会話の更新で答えが届いたと分かる', () => {
  const ask = (askId: string, answered = false): PeerChatItem => ({ uuid: `u-${askId}`, at: 1, kind: 'permission', text: '', ask: { askId, kind: 'question', options: [{ key: '1', label: 'A' }], multi: false, allowText: false, ...(answered ? { answered: { by: { deviceId: 'me', deviceName: 'mac' }, label: 'A', at: 2 } } : {}) } });
  const opened = (s: Store): Store => ({ ...s, peerChat: { s1: { ...emptySlice('v'), phase: 'live', status: 'waiting', items: [ask('a1')] } } });
  const update = (s: Store, items: PeerChatItem[], status: 'busy' | 'waiting' = 'busy') => applyServerEvent(s, { type: 'peerChat.update', sessionId: 's1', link: 'online', replace: false, status, items, queued: [], cursor: 'c' });

  it('札に答えが付いたら届いた印を付け、見え方は保つ（時間切れでも知らせない）', () => {
    const s = update(holdPeerAnswer(opened(withPeer()), 's1', 'a1', 'busy', 1000), [ask('a1', true)]);
    expect(peerAnswerHeld(s, 's1', 'a1')).toBe(true);
    expect(peerAnswerUnconfirmed(s, 's1', 'a1')).toBe(false);
    expect(s.sessions.s1!.lock).toMatchObject({ live: 'busy' });
  });

  it('次の問いが答えを待っていたら、見え方を解いて本当の状態を出す', () => {
    const s = update(holdPeerAnswer(opened(withPeer()), 's1', 'a1', 'busy', 1000), [ask('a1', true), ask('a2')], 'waiting');
    expect(peerAnswerHeld(s, 's1', 'a1')).toBe(false);
  });

  it('札がまだ答えを待つ最後の項目なら、何も変えない', () => {
    const s = update(holdPeerAnswer(opened(withPeer()), 's1', 'a1', 'busy', 1000), [], 'waiting');
    expect(peerAnswerUnconfirmed(s, 's1', 'a1')).toBe(true);
  });
});

describe('releasePeerAnswer', () => {
  it('断られたら、相手の最新の状態（許可待ち）に戻す', () => {
    const held = applyServerEvent(holdPeerAnswer(withPeer(), 's1', 'a1', 'busy', 1000), { type: 'session.upsert', session: peer(lock({ heartbeatAt: 50 })) });
    const s = releasePeerAnswer(held, 's1', 'a1');
    expect(s.sessions.s1!.lock).toMatchObject({ live: 'waiting', reason: 'permission', heartbeatAt: 50 });
    expect(peerAnswerHeld(s, 's1', 'a1')).toBe(false);
  });

  it('別の札の解除や、もう捨てた見え方の解除は何もしない', () => {
    const held = holdPeerAnswer(withPeer(), 's1', 'a1', 'busy', 1000);
    expect(releasePeerAnswer(held, 's1', 'a2')).toBe(held);
    const plain = withPeer();
    expect(releasePeerAnswer(plain, 's1', 'a1')).toBe(plain);
  });
});
