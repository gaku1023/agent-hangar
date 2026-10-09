import { describe, expect, it } from 'vitest';
import { fitCount } from './nowFit.ts';

describe('fitCount（「いま」の列に丸ごと入る項目の数）', () => {
  it('全部入るなら、「ほか N」を置かずに全部を数える', () => {
    expect(fitCount([80, 80, 80], 12, 300, 40)).toBe(3);
    expect(fitCount([], 12, 0, 40)).toBe(0);
  });
  it('入り切らないときは、「ほか N」の分を空けて、丸ごと入る数だけ数える', () => {
    // 80 + 12 + 40 = 132 は入り、80 + 12 + 80 + 12 + 40 = 224 は入らない。
    expect(fitCount([80, 80, 80, 80], 12, 200, 40)).toBe(1);
    expect(fitCount([80, 80, 80, 80], 12, 230, 40)).toBe(2);
  });
  it('1 つも入らなければ 0 を返す（「ほか N」だけが残る）', () => {
    expect(fitCount([300, 80], 12, 100, 40)).toBe(0);
  });
  it('ちょうど入るときは入れる', () => {
    expect(fitCount([80, 80], 12, 172, 40)).toBe(2);
    expect(fitCount([80, 80, 80], 12, 132, 40)).toBe(1);
  });
  it('幅がまだ測れていない（0）ときは、全部を出す', () => {
    expect(fitCount([80, 80], 12, 0, 40)).toBe(2);
  });
});
