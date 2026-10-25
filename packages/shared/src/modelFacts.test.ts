import { describe, expect, it } from 'vitest';
import { dataUseOf, MODEL_FACTS, MODEL_FACTS_STALE_DAYS, MODEL_FACTS_UPDATED, modelFactsStale, providerFactOf } from './modelFacts.ts';

const DAY = 86_400_000;
const updated = Date.parse(`${MODEL_FACTS_UPDATED}T00:00:00Z`);

describe('modelFacts（データの扱いと上限の手書きの表）', () => {
  it('更新日は YYYY-MM-DD の形で、読める日付である', () => {
    expect(MODEL_FACTS_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(updated)).toBe(false);
  });

  it('更新日から決めた日数までは新しく、それを過ぎたら古い（要確認）', () => {
    expect(modelFactsStale(updated)).toBe(false);
    expect(modelFactsStale(updated + MODEL_FACTS_STALE_DAYS * DAY)).toBe(false);
    expect(modelFactsStale(updated + (MODEL_FACTS_STALE_DAYS + 1) * DAY)).toBe(true);
    // 日付を渡せば、その日を更新日として測る。
    expect(modelFactsStale(Date.parse('2026-03-01T00:00:00Z'), '2026-01-01')).toBe(true);
    expect(modelFactsStale(Date.parse('2026-01-10T00:00:00Z'), '2026-01-01')).toBe(false);
  });

  it('無料モデルの顔ぶれは固定で書かない（モデル ID を名指しせず、* の型で書く）', () => {
    const free = MODEL_FACTS.filter((f) => f.provider === 'opencode');
    expect(free.length).toBeGreaterThan(0);
    for (const f of free) expect(f.match === 'big-pickle' || f.match.includes('*')).toBe(true);
  });

  it('データの扱いはモデルの型で引き、無ければプロバイダーの既定、それも無ければ null', () => {
    expect(dataUseOf('opencode', 'big-pickle')).toBe('may-train');
    expect(dataUseOf('opencode', 'mimo-v2.6-flash-free')).toBe('may-train');
    expect(dataUseOf('opencode', 'nemotron-3-ultra-free')).toBe('provider-logs');
    expect(dataUseOf('opencode', 'glm-5.3-flash-free')).toBe('no-training');
    expect(dataUseOf('opencode', 'beam-free')).toBe('retain-30d');
    expect(dataUseOf('deepseek', 'deepseek-v4-flash')).toBe('no-training');
    expect(dataUseOf('opencode-go', 'muse-spark-contributor-1')).toBe('may-train');
    expect(dataUseOf('opencode-go', 'kimi-k3.1-pro')).toBe('no-training');
    expect(dataUseOf('opencode', 'brand-new-free')).toBeNull();
    expect(dataUseOf('somebody', 'x')).toBeNull();
  });

  it('プロバイダーの事実は表示名と費用の型を持ち、知らないものは空', () => {
    expect(providerFactOf('lmstudio')).toMatchObject({ name: 'LM Studio', cost: 'local' });
    expect(providerFactOf('opencode-go')).toMatchObject({ name: 'OpenCode Go', cost: 'plan' });
    expect(providerFactOf('opencode')).toMatchObject({ name: 'OpenCode Zen', limitedFree: true });
    expect(providerFactOf('nobody')).toEqual({});
  });
});
