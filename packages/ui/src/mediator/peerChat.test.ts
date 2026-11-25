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

describe('mediator: この PC の会話の札への答え', () => {
  it('ask.answer と ask.settle は localAsk の効果になり、状態は変えない', () => {
    const a = step({ type: 'ask.answer', sessionId: 's1', askId: 'a1', keys: ['once'] });
    expect(a.effects).toEqual([{ kind: 'localAsk', command: { op: 'answer', sessionId: 's1', askId: 'a1', keys: ['once'] } }]);
    expect(a.state).toEqual(initialState());
    expect(step({ type: 'ask.answer', sessionId: 's1', askId: 'a1', keys: [], text: 'はい' }).effects).toEqual([{ kind: 'localAsk', command: { op: 'answer', sessionId: 's1', askId: 'a1', keys: [], text: 'はい' } }]);
    expect(step({ type: 'ask.settle', sessionId: 's1' }).effects).toEqual([{ kind: 'localAsk', command: { op: 'settle', sessionId: 's1' } }]);
  });
});

describe('mediator: ほかの PC の会話の目次と古い分', () => {
  it('turnsMore、older、jump は peerChat の効果になる', () => {
    expect(step({ type: 'peerChat.turnsMore', sessionId: 's1' }).effects).toEqual([{ kind: 'peerChat', command: { op: 'turnsMore', sessionId: 's1' } }]);
    expect(step({ type: 'peerChat.older', sessionId: 's1' }).effects).toEqual([{ kind: 'peerChat', command: { op: 'older', sessionId: 's1' } }]);
    expect(step({ type: 'peerChat.jump', sessionId: 's1', uuid: 'u9' }).effects).toEqual([{ kind: 'peerChat', command: { op: 'jump', sessionId: 's1', uuid: 'u9' } }]);
  });
});

describe('mediator: ほかの PC への答えが届かなかった知らせ', () => {
  it('会話の名前を入れた知らせを積み、押すとその会話を開く', () => {
    const store = { ...initialStore(), sessions: { s1: sessionDto({ id: 's1', providerSessionId: 'u1', name: 'ビルドの直し', startedAt: 1, lastActivityAt: 1, hasTranscript: true }) } };
    const r = transition(initialState(), store, { kind: 'runtime', event: { type: 'peerAnswer.failed', sessionId: 's1' } });
    expect(r.state.toasts.at(-1)).toMatchObject({ level: 'error', message: 'ビルドの直し への答えが届きませんでした', action: { label: '開く', send: { type: 'session.open', id: 's1' } } });
  });

  it('同じ会話への答えがあとで通ったら、その会話の断りの知らせだけを外す', () => {
    const store = initialStore();
    let st = transition(initialState(), store, { kind: 'runtime', event: { type: 'peerAnswer.failed', sessionId: 's1' } }).state;
    st = transition(st, store, { kind: 'runtime', event: { type: 'peerAnswer.failed', sessionId: 's2' } }).state;
    st = { ...st, toasts: [...st.toasts, { id: 'other', level: 'error', message: 'ほか' }] };
    const r = transition(st, store, { kind: 'runtime', event: { type: 'peerAnswer.delivered', sessionId: 's1' } });
    expect(r.state.toasts.map((x) => x.message)).toEqual([st.toasts[1]!.message, 'ほか']);
    expect(r.effects).toEqual([]);
  });
});
