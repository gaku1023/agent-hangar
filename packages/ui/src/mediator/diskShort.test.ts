import { describe, expect, it } from 'vitest';
import type { SyncStatusBody } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition } from './transition.ts';
import type { State } from './types.ts';

const GB = 1024 ** 3;
const short = { sessions: 3, needBytes: 2.4 * GB, freeBytes: 6 * GB, reserveBytes: 5 * GB };
const sync = (o: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', paused: false, url: 'https://w', lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 1, limitedUntil: null, skipped: [], sweepPending: 0, oncePass: false, diskShort: null, ...o });
const storeOf = (s: SyncStatusBody | null): Store => ({ ...initialStore(), bootstrapped: true, sync: s });
const changed = (state: State, store: Store): State => transition(state, store, { kind: 'store' }).state;

describe('空きが足りずに取得を止めた札', () => {
  it('止めた瞬間に、注意の行の題と同じ文の札を 1 回だけ出す', () => {
    const a = changed(initialState(), storeOf(sync({ diskShort: short })));
    expect(a.toasts).toEqual([{ id: '1', level: 'info', message: TITLE_JA }]);
    expect(a.diskShortToasted).toBe(true);
    // 止めている間に状態が何度届いても、二度は出さない。
    const b = changed(a, storeOf(sync({ diskShort: { ...short, freeBytes: 5.5 * GB } })));
    expect(b.toasts).toHaveLength(1);
  });

  it('解けたら印を戻し、また止まればもう 1 回出す', () => {
    const a = changed(initialState(), storeOf(sync({ diskShort: short })));
    const b = changed(a, storeOf(sync()));
    expect(b.diskShortToasted).toBe(false);
    const c = changed(b, storeOf(sync({ diskShort: short })));
    expect(c.toasts).toHaveLength(2);
  });

  it('同期を使っていない端末と、止めていないときは出さず、state もそのまま返す', () => {
    const s = initialState();
    expect(changed(s, storeOf(sync({ state: 'off', url: null, diskShort: short }))).toasts).toEqual([]);
    expect(changed(s, storeOf(sync()))).toBe(s);
    expect(changed(s, storeOf(null))).toBe(s);
  });
});

/** 札の文（会話 3 件）。注意の行の題と同じ。 */
const TITLE_JA = '空き容量が不足しているため、会話 3 件の取得を中断しました';
