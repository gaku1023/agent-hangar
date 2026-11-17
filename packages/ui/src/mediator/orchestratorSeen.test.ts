import { describe, expect, it } from 'vitest';
import type { SessionDto, SettingsDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition } from './transition.ts';
import type { Input, State } from './types.ts';

const unread = (count: number, at = 100) => ({ count, latest: '返答です', at });
const sess = (id: string, over: Partial<SessionDto> = {}) => ({ id, live: null, lastActivityAt: 1, parked: false, unread: null, ...over }) as SessionDto;
const storeOf = (o: SessionDto, settings: Partial<SettingsDto> = {}): Store => ({
  ...initialStore(), sessions: { [o.id]: o }, settings: { orchestrator: { enabled: true, sessionId: o.id }, ...settings } as SettingsDto,
});
const act = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });
const seens = (effects: { kind: string }[]) => effects.filter((e) => e.kind === 'api.markSeen');
const opened = (): State => ({ ...initialState(), orchestratorOpen: true });

describe('統括の柱を開いたら、統括の会話を既読にする', () => {
  it('柱を開いた瞬間に、未読があれば api.markSeen を出す', () => {
    const store = storeOf(sess('o1', { unread: unread(2) }));
    const r = transition(initialState(), store, act({ type: 'orchestrator.pillar', open: true }));
    expect(r.state.orchestratorOpen).toBe(true);
    expect(seens(r.effects)).toEqual([{ kind: 'api.markSeen', sessionId: 'o1' }]);
  });
  it('未読が無ければ出さない。畳むときも出さない', () => {
    expect(seens(transition(initialState(), storeOf(sess('o1')), act({ type: 'orchestrator.pillar', open: true })).effects)).toEqual([]);
    expect(seens(transition(opened(), storeOf(sess('o1', { unread: unread(2) })), act({ type: 'orchestrator.pillar', open: false })).effects)).toEqual([]);
  });
  it('開いている間に新しい返答が来たら、窓が前にあるときだけ送る印を付けて 1 度だけ出す', () => {
    const store = storeOf(sess('o1', { unread: unread(1, 200) }));
    const a = transition(opened(), store, { kind: 'store' });
    expect(seens(a.effects)).toEqual([{ kind: 'api.markSeen', sessionId: 'o1', ifFront: true }]);
    // 同じ未読へは重ねて頼まない。
    expect(seens(transition(a.state, store, { kind: 'store' }).effects)).toEqual([]);
    // 次の返答（未読の時刻が進んだ）には、また頼む。
    expect(seens(transition(a.state, storeOf(sess('o1', { unread: unread(1, 300) })), { kind: 'store' }).effects)).toHaveLength(1);
  });
  it('畳んでいる間の未読は既読にしない', () => {
    expect(seens(transition(initialState(), storeOf(sess('o1', { unread: unread(1) })), { kind: 'store' }).effects)).toEqual([]);
  });
  it('入力待ち（waiting）は既読では消えないので、触らない', () => {
    const store = storeOf(sess('o1', { live: 'waiting' }));
    expect(seens(transition(opened(), store, { kind: 'store' }).effects)).toEqual([]);
  });
});
