import { describe, expect, it } from 'vitest';
import { SCREEN_MISS_THRESHOLD, ScreenMissGate, screenDrift } from './screen.ts';

const MODE = { found: false, reason: 'mode' } as const;
const NOT_FOUND = { found: false, reason: 'notFound' } as const;
const FOUND = { found: true } as const;

describe('ScreenMissGate', () => {
  it('しきい値は 3 回', () => {
    expect(SCREEN_MISS_THRESHOLD).toBe(3);
  });

  it('続けて 3 回見つからなかった目印を、3 回目で初めて返す', () => {
    const g = new ScreenMissGate();
    expect(g.observe(['footer'], MODE)).toEqual([]);
    expect(g.observe(['footer'], MODE)).toEqual([]);
    expect(g.observe(['footer'], MODE)).toEqual(['footer']);
  });

  it('しきい値を超えて見つからないままなら、見つからないたびに返す', () => {
    const g = new ScreenMissGate();
    for (let i = 0; i < 3; i++) g.observe(['prompt-marker'], NOT_FOUND);
    expect(g.observe(['prompt-marker'], NOT_FOUND)).toEqual(['prompt-marker']);
  });

  it('途中で見えたら数え直す', () => {
    const g = new ScreenMissGate();
    g.observe(['footer'], MODE);
    g.observe(['footer'], MODE);
    // footer が見つからないと言われなかった跳び方では、footer は見えていた。
    expect(g.observe([], FOUND)).toEqual([]);
    expect(g.observe(['footer'], MODE)).toEqual([]);
    expect(g.observe(['footer'], MODE)).toEqual([]);
    expect(g.observe(['footer'], MODE)).toEqual(['footer']);
  });

  it('指示の行の記号は、着いたときと、記号を見つけたうえで着けなかったときに見えたと数える', () => {
    const g = new ScreenMissGate();
    g.observe(['prompt-marker'], NOT_FOUND);
    g.observe(['prompt-marker'], NOT_FOUND);
    g.observe([], NOT_FOUND);
    g.observe(['prompt-marker'], NOT_FOUND);
    g.observe(['prompt-marker'], NOT_FOUND);
    g.observe([], FOUND);
    g.observe(['prompt-marker'], NOT_FOUND);
    expect(g.observe(['prompt-marker'], NOT_FOUND)).toEqual([]);
    expect(g.observe(['prompt-marker'], NOT_FOUND)).toEqual(['prompt-marker']);
  });

  it('モードで止まった跳び方は、指示の行の記号について何も言わない', () => {
    const g = new ScreenMissGate();
    g.observe(['prompt-marker'], NOT_FOUND);
    g.observe(['prompt-marker'], NOT_FOUND);
    // footer が見つからずに止まった。指示の行の記号は読んでいない。
    g.observe(['footer'], MODE);
    // transcript には入れたが、途中で抜けて止まった。これも記号は読んでいない。
    g.observe([], MODE);
    expect(g.observe(['prompt-marker'], NOT_FOUND)).toEqual(['prompt-marker']);
  });

  it('目印ごとに別々に数える', () => {
    const g = new ScreenMissGate();
    g.observe(['footer'], MODE);
    g.observe(['prompt-marker'], NOT_FOUND);
    g.observe(['footer'], MODE);
    g.observe(['prompt-marker'], NOT_FOUND);
    // prompt-marker が見つからないと言われた跳び方では footer は見えていたので、footer は数え直しになっている。
    expect(g.observe(['footer'], MODE)).toEqual([]);
    // footer で止まった跳び方は記号を読んでいないので、記号は 2 回から続けて 3 回目になる。
    expect(g.observe(['prompt-marker'], NOT_FOUND)).toEqual(['prompt-marker']);
  });
});

describe('screenDrift', () => {
  it('目印ごとの値を返す', () => {
    expect(screenDrift('footer')).toEqual({ contract: 'screen', value: 'transcript-footer=(missing)', version: null });
    expect(screenDrift('prompt-marker')).toEqual({ contract: 'screen', value: 'prompt-marker=(missing)', version: null });
  });
});
