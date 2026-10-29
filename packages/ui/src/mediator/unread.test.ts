import { describe, expect, it } from 'vitest';
import type { SessionDto, SettingsDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { liveStep } from './live.ts';
import { initialState, transition } from './transition.ts';
import type { Input, State } from './types.ts';

const unread = (count: number, at = 100) => ({ count, latest: '調べ終わりました', at });
const sess = (id: string, over: Partial<SessionDto> = {}) => ({ id, live: null, lastActivityAt: 1, parked: false, unread: null, ...over }) as SessionDto;
const storeOf = (list: SessionDto[], settings: Partial<SettingsDto> | null = null): Store => ({ ...initialStore(), sessions: Object.fromEntries(list.map((s) => [s.id, s])), settings: settings as SettingsDto | null });
const hash = (id: string): Input => ({ kind: 'runtime', event: { type: 'hash.changed', route: { name: 'session', id } } });
const seen = (id: string, ifFront?: true) => ({ kind: 'api.markSeen', sessionId: id, ...(ifFront ? { ifFront } : {}) });
const badges = (effects: { kind: string }[]) => effects.filter((e) => e.kind === 'badge');
const seens = (effects: { kind: string }[]) => effects.filter((e) => e.kind === 'api.markSeen');

describe('Dock のバッジは入力待ちに未読を足す', () => {
  it('入力待ち 1 と未読 2 で 3。未読だけが変わっても出し直す', () => {
    const a = liveStep(initialState(), storeOf([sess('w', { live: 'waiting' }), sess('u', { unread: unread(2) })]));
    expect(badges(a.effects)).toEqual([{ kind: 'badge', count: 3 }]);
    const b = liveStep(a.state, storeOf([sess('w', { live: 'waiting' }), sess('u', { unread: unread(3, 200) })]));
    expect(badges(b.effects)).toEqual([{ kind: 'badge', count: 4 }]);
    // 数が変わらなければ何も出さない。
    expect(liveStep(b.state, storeOf([sess('w', { live: 'waiting' }), sess('u', { unread: unread(3, 200) })])).effects).toEqual([]);
  });
  it('未読だけでも出し、既読で 0 に戻す', () => {
    const a = liveStep(initialState(), storeOf([sess('u', { unread: unread(2) })]));
    expect(badges(a.effects)).toEqual([{ kind: 'badge', count: 2 }]);
    expect(badges(liveStep(a.state, storeOf([sess('u')])).effects)).toEqual([{ kind: 'badge', count: 0 }]);
  });
  it('unreadBadge が切なら、未読は数えない', () => {
    const a = liveStep(initialState(), storeOf([sess('w', { live: 'waiting' }), sess('u', { unread: unread(2) })], { unreadBadge: false }));
    expect(badges(a.effects)).toEqual([{ kind: 'badge', count: 1 }]);
  });
});

describe('既読', () => {
  it('未読のあるセッションへ移ったら api.markSeen を出す。未読が無ければ出さない', () => {
    const store = storeOf([sess('u', { unread: unread(2) }), sess('n')]);
    expect(transition(initialState(), store, hash('u')).effects).toContainEqual(seen('u'));
    expect(seens(transition(initialState(), store, hash('n')).effects)).toEqual([]);
  });
  it('unreadBadge が切でも、開いたら既読にする', () => {
    const store = storeOf([sess('u', { unread: unread(2) })], { unreadBadge: false });
    expect(transition(initialState(), store, hash('u')).effects).toContainEqual(seen('u'));
  });
  it('開いて見ている間に未読が増えたら、窓が前にあるときだけ送る印を付けて、すぐ既読にする。同じ未読へは 1 回だけ', () => {
    const at: State = { ...initialState(), screen: { name: 'session', id: 'u' } };
    const a = transition(at, storeOf([sess('u', { unread: unread(1, 100) })]), { kind: 'store' });
    expect(a.effects).toContainEqual(seen('u', true));
    const b = transition(a.state, storeOf([sess('u', { unread: unread(1, 100), lastActivityAt: 5 })]), { kind: 'store' });
    expect(seens(b.effects)).toEqual([]);
    const c = transition(b.state, storeOf([sess('u', { unread: unread(2, 200) })]), { kind: 'store' });
    expect(c.effects).toContainEqual(seen('u', true));
  });
  it('別のセッションの未読は、開いていなければ既読にしない', () => {
    const at: State = { ...initialState(), screen: { name: 'session', id: 'x' } };
    expect(seens(transition(at, storeOf([sess('u', { unread: unread(1) })]), { kind: 'store' }).effects)).toEqual([]);
  });
});
