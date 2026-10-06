import { describe, expect, it } from 'vitest';
import { usageAt, windowAt } from './usage.ts';

describe('windowAt', () => {
  it('戻る時刻より前は、届いた値のまま', () => {
    const w = { usedPercent: 35, resetsAt: 1_000 };
    expect(windowAt(w, 999)).toBe(w);
  });

  it('戻る時刻を過ぎた窓は 0% にし、次に戻る時刻は分からないので null にする', () => {
    expect(windowAt({ usedPercent: 35, resetsAt: 1_000 }, 1_000)).toEqual({ usedPercent: 0, resetsAt: null });
    expect(windowAt({ usedPercent: 35, resetsAt: 1_000 }, 5_000)).toEqual({ usedPercent: 0, resetsAt: null });
  });

  it('戻る時刻が無い窓と、窓が無いときはそのまま', () => {
    const w = { usedPercent: 35, resetsAt: null };
    expect(windowAt(w, 5_000)).toBe(w);
    expect(windowAt(null, 5_000)).toBeNull();
  });
});

describe('usageAt', () => {
  it('5 時間と週を別々に見る。更新の時刻は変えない', () => {
    const u = { fiveHour: { usedPercent: 35, resetsAt: 1_000 }, sevenDay: { usedPercent: 30, resetsAt: 9_000 }, updatedAt: 500 };
    expect(usageAt(u, 2_000)).toEqual({ fiveHour: { usedPercent: 0, resetsAt: null }, sevenDay: { usedPercent: 30, resetsAt: 9_000 }, updatedAt: 500 });
  });

  it('どちらも過ぎていなければ同じものを返す', () => {
    const u = { fiveHour: { usedPercent: 35, resetsAt: 1_000 }, sevenDay: null, updatedAt: 500 };
    expect(usageAt(u, 999)).toBe(u);
  });
});
