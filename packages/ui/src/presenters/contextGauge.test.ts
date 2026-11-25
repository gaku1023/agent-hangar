import { describe, expect, it } from 'vitest';
import { contextGaugeOf, ctxK } from './contextGauge.ts';

const stats = (contextTokens: number | null | undefined, contextSize?: number | null) => ({ contextTokens, contextSize });

describe('contextGaugeOf', () => {
  it('値が無いときは null', () => {
    expect(contextGaugeOf(stats(null, 1_000_000), {})).toBeNull();
    expect(contextGaugeOf(stats(undefined), {})).toBeNull();
  });
  it('k の単位でそろえ、1M も 1000K と書く', () => {
    expect(ctxK(448_000)).toBe('448K');
    expect(ctxK(1_000_000)).toBe('1000K');
    expect(contextGaugeOf(stats(448_000, 1_000_000), {})!.label).toBe('448K/1000K');
  });
  it('窓が無いときは量だけを出し、輪は alert を満ちとする', () => {
    const g = contextGaugeOf(stats(200_000), {})!;
    expect(g.label).toBe('200K');
    expect(g.size).toBeNull();
    expect(g.fraction).toBeCloseTo(0.5);
  });
  it('窓が大きいときは設定の warn と alert で色が変わる', () => {
    expect(contextGaugeOf(stats(299_999, 1_000_000), {})!.level).toBe('none');
    expect(contextGaugeOf(stats(300_000, 1_000_000), {})!.level).toBe('warn');
    expect(contextGaugeOf(stats(400_000, 1_000_000), {})!.level).toBe('alert');
    expect(contextGaugeOf(stats(150_000, 1_000_000), { contextWarnTokens: 100_000, contextAlertTokens: 200_000 })!.level).toBe('warn');
  });
  it('窓が alert より小さいときは窓の 75% と 90%', () => {
    expect(contextGaugeOf(stats(149_999, 200_000), {})!.level).toBe('none');
    expect(contextGaugeOf(stats(150_000, 200_000), {})!.level).toBe('warn');
    expect(contextGaugeOf(stats(180_000, 200_000), {})!.level).toBe('alert');
  });
  it('窓が alert ちょうどのときは設定の値を使う', () => {
    expect(contextGaugeOf(stats(350_000, 400_000), {})!.level).toBe('warn');
  });
  it('warn が alert 以上の設定は、warn を alert と同じに扱う', () => {
    expect(contextGaugeOf(stats(350_000, 1_000_000), { contextWarnTokens: 500_000, contextAlertTokens: 300_000 })!.level).toBe('alert');
    expect(contextGaugeOf(stats(250_000, 1_000_000), { contextWarnTokens: 500_000, contextAlertTokens: 300_000 })!.level).toBe('none');
  });
  it('fraction は窓があれば tokens/size で、0 から 1 に収める', () => {
    expect(contextGaugeOf(stats(250_000, 1_000_000), {})!.fraction).toBeCloseTo(0.25);
    expect(contextGaugeOf(stats(2_000_000, 1_000_000), {})!.fraction).toBe(1);
    expect(contextGaugeOf(stats(900_000), {})!.fraction).toBe(1);
  });
});
