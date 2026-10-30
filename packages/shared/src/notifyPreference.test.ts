import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFY_RULES, isNotifyPreference, notifyPreferenceOf, notifyRulesOf } from './notifyPreference.ts';

describe('notifyRulesOf', () => {
  it('未設定と null は既定。unread はすべて、os と phone は done と ask、見ている間は出さず、まとめる', () => {
    for (const s of [{}, { notifyPreference: null }]) {
      expect(notifyRulesOf(s)).toEqual({ text: '', unread: ['done', 'ask', 'progress'], os: ['done', 'ask'], phone: ['done', 'ask'], whileFocused: false, merge: true });
    }
    expect(DEFAULT_NOTIFY_RULES.os).toEqual(['done', 'ask']);
  });
  it('古いスイッチが false の出し先は空の配列として読む（notifyPreference が無いとき）', () => {
    const r = notifyRulesOf({ unreadBadge: false, unreadOs: false, unreadPhone: true });
    expect(r.unread).toEqual([]);
    expect(r.os).toEqual([]);
    expect(r.phone).toEqual(['done', 'ask']);
    expect(notifyRulesOf({ notifyPreference: null, unreadPhone: false }).phone).toEqual([]);
  });
  it('notifyPreference があればそちらが勝つ。省いた whileFocused と merge は既定', () => {
    const r = notifyRulesOf({ unreadBadge: false, unreadOs: false, notifyPreference: { text: '済んだら', unread: ['done'], os: ['ask'], phone: [] } });
    expect(r).toEqual({ text: '済んだら', unread: ['done'], os: ['ask'], phone: [], whileFocused: false, merge: true });
    expect(notifyRulesOf({ notifyPreference: { text: '', unread: [], os: [], phone: [], whileFocused: true, merge: false } })).toMatchObject({ whileFocused: true, merge: false });
  });
  it('壊れた notifyPreference は既定として読む', () => {
    expect(notifyRulesOf({ notifyPreference: { text: 1 } as never })).toEqual(notifyRulesOf({}));
  });
});

describe('検査', () => {
  const ok = { text: 'a', unread: ['done'], os: [], phone: ['ask', 'progress'] };
  it('isNotifyPreference は形が全部合うものだけを通す', () => {
    expect(isNotifyPreference(ok)).toBe(true);
    expect(isNotifyPreference({ ...ok, whileFocused: true, merge: false })).toBe(true);
    for (const bad of [null, 'x', [], { ...ok, text: 1 }, { ...ok, unread: 'done' }, { ...ok, os: ['nope'] }, { ...ok, phone: undefined }, { ...ok, merge: 'yes' }, { ...ok, whileFocused: 1 }]) expect(isNotifyPreference(bad)).toBe(false);
  });
  it('notifyPreferenceOf は kind でない要素と重なりを捨て、配列でない・text が文字列でないものは null', () => {
    expect(notifyPreferenceOf({ text: 'a', unread: ['done', 'x', 'done', 3], os: ['ask'], phone: [], merge: 'no' })).toEqual({ text: 'a', unread: ['done'], os: ['ask'], phone: [] });
    expect(notifyPreferenceOf({ text: 'a', unread: 'done', os: [], phone: [] })).toBeNull();
    expect(notifyPreferenceOf({ text: 2, unread: [], os: [], phone: [] })).toBeNull();
    expect(notifyPreferenceOf(undefined)).toBeNull();
  });
});
