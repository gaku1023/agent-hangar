import { describe, expect, it } from 'vitest';
import { NOTICES_READ_KEY, NOTICES_READ_MAX, noticesStep, readNoticesRead } from './notices.ts';
import { initialState, transition } from './transition.ts';
import { initialStore } from '../store/store.ts';
import type { State } from './types.ts';

const read = (keys: string[]) => ({ kind: 'action' as const, action: { type: 'notices.read' as const, keys } });
const run = (state: State, keys: string[]) => transition(state, initialStore(), read(keys));

describe('readNoticesRead：localStorage から既読の鍵を読み戻す', () => {
  it('配列の文字列だけを、重ねずに順を保って取る', () => {
    expect(readNoticesRead(['a|1', 'b|2', 'a|1', 3, null, { x: 1 }])).toEqual(['a|1', 'b|2']);
  });
  it('配列でないもの（未保存、壊れた値）は空にする', () => {
    for (const v of [undefined, null, 'a|1', 7, { 0: 'a' }, true]) expect(readNoticesRead(v), String(v)).toEqual([]);
  });
  it('多すぎれば、新しい側を残す', () => {
    const many = Array.from({ length: NOTICES_READ_MAX + 5 }, (_, i) => `k${i}`);
    const r = readNoticesRead(many);
    expect(r).toHaveLength(NOTICES_READ_MAX);
    expect(r[0]).toBe('k5');
    expect(r.at(-1)).toBe(`k${NOTICES_READ_MAX + 4}`);
  });
});

describe('notices.read：行を既読にする', () => {
  it('はじめは何も既読にしていない', () => {
    expect(initialState().noticesRead).toEqual([]);
  });
  it('鍵を足し、localStorage へ保存する効果を返す', () => {
    const r = run(initialState(), ['sync|error|x', 'compat|2.4.2|1 change']);
    expect(r.state.noticesRead).toEqual(['sync|error|x', 'compat|2.4.2|1 change']);
    expect(r.effects).toEqual([{ kind: 'storage.save', key: NOTICES_READ_KEY, value: ['sync|error|x', 'compat|2.4.2|1 change'] }]);
  });
  it('「すべて既読にする」は、いまある鍵を全部足す。すでに既読のものは重ねない', () => {
    const first = run(initialState(), ['a']).state;
    const r = run(first, ['a', 'b', 'c']);
    expect(r.state.noticesRead).toEqual(['a', 'b', 'c']);
  });
  it('足すものが無ければ、状態も保存も動かさない', () => {
    const first = run(initialState(), ['a', 'b']).state;
    const r = run(first, ['b']);
    expect(r.state).toBe(first);
    expect(r.effects).toEqual([]);
    expect(run(first, []).effects).toEqual([]);
  });
  it('上限を越えたら、古い鍵から捨てる', () => {
    const full = { ...initialState(), noticesRead: Array.from({ length: NOTICES_READ_MAX }, (_, i) => `k${i}`) };
    const r = run(full, ['new']);
    expect(r.state.noticesRead).toHaveLength(NOTICES_READ_MAX);
    expect(r.state.noticesRead[0]).toBe('k1');
    expect(r.state.noticesRead.at(-1)).toBe('new');
  });
  it('既読は localStorage にだけ置く（サーバを呼ぶ効果を出さない）', () => {
    const r = run(initialState(), ['a']);
    expect(r.effects.every((e) => e.kind === 'storage.save')).toBe(true);
  });
  it('ほかの入力には応じない', () => {
    expect(noticesStep(initialState(), { kind: 'action', action: { type: 'nav.back' } })).toBeNull();
    expect(noticesStep(initialState(), { kind: 'store' })).toBeNull();
  });
});
