import { describe, expect, it } from 'vitest';
import { tokensShort, usageLabel } from './format.ts';

describe('使用量の略記（実行中の opencode の行の右端）', () => {
  it('トークンは 1,000 未満はそのまま、10 万未満は小数 1 桁の k、100 万未満は整数の k、それ以上は M', () => {
    expect(tokensShort(0)).toBe('0');
    expect(tokensShort(950)).toBe('950');
    expect(tokensShort(1_000)).toBe('1k');
    expect(tokensShort(13_600)).toBe('13.6k');
    expect(tokensShort(62_040)).toBe('62k');
    expect(tokensShort(99_960)).toBe('100k');
    expect(tokensShort(148_400)).toBe('148k');
    expect(tokensShort(1_250_000)).toBe('1.3M');
    expect(tokensShort(2_000_000)).toBe('2M');
  });

  it('「トークン · コスト」。コストが分からなければトークンだけ', () => {
    expect(usageLabel({ tokens: 13_600, cost: 0 })).toBe('13.6k · $0.00');
    expect(usageLabel({ tokens: 148_000, cost: 0.4249 })).toBe('148k · $0.42');
    expect(usageLabel({ tokens: 9_000, cost: null })).toBe('9k');
  });
});
