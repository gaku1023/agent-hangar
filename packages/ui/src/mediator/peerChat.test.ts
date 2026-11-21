import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState, transition } from './transition.ts';
import type { Input } from './types.ts';
import { sessionDto } from '../test/sessionDto.ts';

const action = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });
const step = (a: Extract<Input, { kind: 'action' }>['action']) => transition(initialState(), initialStore(), action(a));

describe('mediator: ほかの PC の会話の操作は効果にして Runtime へ渡す', () => {
  it('open、close、send は peerChat の効果になり、状態は変えない', () => {
    const open = step({ type: 'peerChat.open', sessionId: 's1', viewer: 'v1' });
    expect(open.effects).toEqual([{ kind: 'peerChat', command: { op: 'open', sessionId: 's1', viewer: 'v1' } }]);
    expect(open.state).toEqual(initialState());
    expect(step({ type: 'peerChat.close', sessionId: 's1', viewer: 'v1' }).effects).toEqual([{ kind: 'peerChat', command: { op: 'close', sessionId: 's1', viewer: 'v1' } }]);
    const body: { t: 'answer'; askId: string; keys: string[] } = { t: 'answer', askId: 'a', keys: ['1'] };
    expect(step({ type: 'peerChat.send', sessionId: 's1', body }).effects).toEqual([{ kind: 'peerChat', command: { op: 'send', sessionId: 's1', body } }]);
  });
});

describe('mediator: ほかの PC への答えが届かなかった知らせ', () => {
  it('会話の名前を入れた知らせを積み、押すとその会話を開く', () => {
    const store = { ...initialStore(), sessions: { s1: sessionDto({ id: 's1', providerSessionId: 'u1', name: 'ビルドの直し', startedAt: 1, lastActivityAt: 1, hasTranscript: true }) } };
    const r = transition(initialState(), store, { kind: 'runtime', event: { type: 'peerAnswer.failed', sessionId: 's1', kind: 'permission' } });
    expect(r.state.toasts.at(-1)).toMatchObject({ level: 'error', message: 'ビルドの直し への許可が届きませんでした', action: { label: '開く', send: { type: 'session.open', id: 's1' } } });
    const q = transition(initialState(), store, { kind: 'runtime', event: { type: 'peerAnswer.failed', sessionId: 's1', kind: 'question' } });
    expect(q.state.toasts.at(-1)?.message).toBe('ビルドの直し への答えが届きませんでした');
  });
});
