import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState, transition } from './transition.ts';
import type { Input } from './types.ts';

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
