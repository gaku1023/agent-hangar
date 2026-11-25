import { describe, expect, it } from 'vitest';
import type { PeerChatAsk } from '@agent-hangar/shared';
import { createAskWatch } from './askWatch.ts';

const ask = (askId: string, over: Partial<PeerChatAsk> = {}): PeerChatAsk => ({ askId, kind: 'permission', tool: 'Bash', input: 'ls', options: [{ key: 'once', label: '1 回だけ許可' }], multi: false, allowText: false, ...over });

function setup() {
  const asks = new Map<string, PeerChatAsk>();
  const candidates: string[] = [];
  const events: unknown[] = [];
  const w = createAskWatch({ currentAsk: (id) => asks.get(id) ?? null, candidates: () => candidates, emit: (ev) => { events.push(ev); } });
  return { asks, candidates, events, w };
}

describe('askWatch（session.ask を、変わったときだけ流す）', () => {
  it('札が出たら流し、同じ札なら流さない', () => {
    const { asks, candidates, events, w } = setup();
    asks.set('s1', ask('A'));
    candidates.push('s1');
    w.checkAll();
    w.checkAll();
    expect(events).toEqual([{ type: 'session.ask', sessionId: 's1', ask: ask('A') }]);
  });
  it('札が替わったら流す（askId が違う、中身が違う）', () => {
    const { asks, events, w } = setup();
    asks.set('s1', ask('A'));
    w.check('s1');
    asks.set('s1', ask('B'));
    w.check('s1');
    asks.set('s1', ask('B', { answered: { by: { deviceId: 'd', deviceName: 'Mac' }, label: 'x', at: 1 } }));
    w.check('s1');
    expect(events).toHaveLength(3);
  });
  it('札が閉じたら null を 1 回だけ流す。もう候補でなくても、覚えている会話は見に行く', () => {
    const { asks, candidates, events, w } = setup();
    asks.set('s1', ask('A'));
    candidates.push('s1');
    w.checkAll();
    asks.delete('s1');
    candidates.length = 0;
    w.checkAll();
    w.checkAll();
    expect(events.at(-1)).toEqual({ type: 'session.ask', sessionId: 's1', ask: null });
    expect(events).toHaveLength(2);
  });
  it('札の無い会話は何も流さない', () => {
    const { candidates, events, w } = setup();
    candidates.push('s1');
    w.checkAll();
    expect(events).toEqual([]);
  });
  it('snapshot は流した札の全部（bootstrap 用）で、閉じたものは入らない', () => {
    const { asks, candidates, w } = setup();
    asks.set('s1', ask('A'));
    asks.set('s2', ask('B'));
    candidates.push('s1', 's2');
    w.checkAll();
    expect(w.snapshot()).toEqual({ s1: ask('A'), s2: ask('B') });
    asks.delete('s1');
    w.check('s1');
    expect(w.snapshot()).toEqual({ s2: ask('B') });
  });
  it('currentAsk が投げても、ほかの会話を止めない', () => {
    const events: unknown[] = [];
    const w = createAskWatch({ currentAsk: (id) => { if (id === 'bad') throw new Error('x'); return ask('A'); }, candidates: () => ['bad', 's2'], emit: (ev) => { events.push(ev); } });
    w.checkAll();
    expect(events).toHaveLength(1);
  });
});
