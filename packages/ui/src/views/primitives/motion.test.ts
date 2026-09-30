import { afterEach, describe, expect, it } from 'vitest';
import { fakeMotionTokens } from '../../test/motion.ts';
import { motionEase, motionMs, motionValue, parseDuration } from './motion.ts';

describe('parseDuration', () => {
  it('ミリ秒と秒の書き方を、ミリ秒の数にする', () => {
    expect(parseDuration('420ms')).toBe(420);
    expect(parseDuration(' 0.25s ')).toBe(250);
    expect(parseDuration('3.2s')).toBe(3200);
    expect(parseDuration('0ms')).toBe(0);
  });
  // build の CSS の圧縮は 420ms を .42s に書き換える。読めないと、build した実物でだけ JS の動きが全部止まる。
  it('先頭の 0 を省いた書き方も読む', () => {
    expect(parseDuration('.42s')).toBe(420);
    expect(parseDuration('.2s')).toBe(200);
    expect(parseDuration('.25s')).toBe(250);
  });
  it('読めない値は 0 にして、動かさない側へ倒す', () => {
    for (const bad of ['', 'var(--dur)', '420', 'fast', '-1ms']) expect(parseDuration(bad), bad).toBe(0);
  });
});

describe('motion のトークン', () => {
  let restore = () => {};
  afterEach(() => restore());
  it('ルートの計算済みの値を読む', () => {
    restore = fakeMotionTokens({ '--dur': '420ms', '--ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)', '--rise': '6px' });
    expect(motionMs('--dur')).toBe(420);
    expect(motionValue('--rise')).toBe('6px');
    expect(motionEase('--ease-out')).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
  });
  // Web Animations は空の曲線を渡すと例外を投げる。トークンが読めない環境でも落とさない。
  it('トークンが読めなければ、長さは 0、曲線は linear', () => {
    restore = fakeMotionTokens({});
    expect(motionMs('--dur-exit')).toBe(0);
    expect(motionEase('--ease-in')).toBe('linear');
  });
});
