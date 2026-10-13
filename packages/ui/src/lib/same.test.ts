import { describe, expect, it } from 'vitest';
import { sameValue } from './same.ts';

describe('sameValue', () => {
  it('中身が同じなら、作り直した値でも同じと見る。鍵の並びは問わない', () => {
    expect(sameValue({ a: 1, b: [1, { c: 'x' }], d: null }, { d: null, b: [1, { c: 'x' }], a: 1 })).toBe(true);
    expect(sameValue([], [])).toBe(true);
    expect(sameValue(null, null)).toBe(true);
  });
  it('値、長さ、鍵の数、配列と物の違いは違うと見る', () => {
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue([1, 2], [1])).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValue([], {})).toBe(false);
    expect(sameValue({ a: undefined }, { b: undefined })).toBe(false);
    expect(sameValue(undefined, null)).toBe(false);
    expect(sameValue({ a: null }, null)).toBe(false);
  });
});
