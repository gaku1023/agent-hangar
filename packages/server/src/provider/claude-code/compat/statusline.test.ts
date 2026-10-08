import { describe, expect, it } from 'vitest';
import { resetsAtMs, statuslineDrifts } from './statusline.ts';

const full = { session_id: 'u1', version: '2.1.300', model: { id: 'claude-haiku', display_name: 'Haiku' }, cost: { total_cost_usd: 0.01 }, context_window: { context_window_size: 200_000, current_usage: null }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 3, resets_at: 1_800_500_000 } } };
const s = (value: string) => ({ contract: 'statusline', value, version: '2.1.300' });

describe('resetsAtMs', () => {
  it('秒は 1000 倍し、ミリ秒と見られる値はそのまま使う', () => {
    expect(resetsAtMs(1_760_000_000)).toBe(1_760_000_000_000);
    expect(resetsAtMs(1_760_000_000_000)).toBe(1_760_000_000_000);
  });
});

describe('statuslineDrifts', () => {
  it('読む項目がそろっていればずれは無い。rate_limits が無い 1 回目と null も、ずれではない', () => {
    expect(statuslineDrifts(full)).toEqual([]);
    const { rate_limits: _r, ...first } = full;
    expect(statuslineDrifts(first)).toEqual([]);
    expect(statuslineDrifts({ ...full, rate_limits: null })).toEqual([]);
    expect(statuslineDrifts({ ...full, model: 'Haiku' })).toEqual([]);
    expect(statuslineDrifts('x')).toEqual([]);
  });
  it('欠けた項目を、JSON の版を添えて返す', () => {
    expect(statuslineDrifts({ version: '2.1.300' })).toEqual([
      s('session_id=(missing)'), s('model=(missing)'), s('context_window.context_window_size=(missing)'), s('cost.total_cost_usd=(missing)'),
    ]);
  });
  it('窓の中の欠けた項目と、ミリ秒に見える resets_at を返す', () => {
    expect(statuslineDrifts({ ...full, rate_limits: { five_hour: { resets_at: '2026-10-07T10:00:00Z' }, seven_day: { used_percentage: 3, resets_at: 1_800_500_000_000 } } })).toEqual([
      s('rate_limits.five_hour.used_percentage=(missing)'), s('rate_limits.five_hour.resets_at=(missing)'), s('rate_limits.seven_day.resets_at=ms'),
    ]);
    expect(statuslineDrifts({ ...full, rate_limits: 'x' })).toEqual([s('rate_limits=(missing)')]);
  });
});
