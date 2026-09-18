import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { parseStatusline, UsageTracker } from './statusline.ts';

const first = { session_id: 'u1', session_name: 'n', cwd: '/x', transcript_path: '/t.jsonl', model: { id: 'claude-opus-4-1', display_name: 'Opus' }, effort: 'high', cost: { total_cost_usd: 0.05 }, context_window: { context_window_size: 200_000, current_usage: null } };
const second = { ...first, cost: { total_cost_usd: 0.12 }, context_window: { context_window_size: 200_000, current_usage: { input_tokens: 40_000, output_tokens: 1_000, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 5_000 } }, rate_limits: { five_hour: { used_percentage: 47, resets_at: 1_760_000_000 }, seven_day: { used_percentage: 7, resets_at: 1_760_500_000 } } };

describe('parseStatusline', () => {
  it('必要な項目だけを取り出す', () => {
    expect(parseStatusline(second)).toEqual({ providerSessionId: 'u1', model: 'claude-opus-4-1', effort: 'high', contextUsed: 50_000, contextSize: 200_000, costUsd: 0.12, rateLimits: { fiveHour: { usedPercent: 47, resetsAt: 1_760_000_000_000 }, sevenDay: { usedPercent: 7, resetsAt: 1_760_500_000_000 } } });
    expect(parseStatusline(first)).toMatchObject({ contextUsed: null, contextSize: 200_000, rateLimits: null });
    expect(parseStatusline({ model: { display_name: 'Opus' }, context_window: { current_usage: 12_345 } })).toMatchObject({ providerSessionId: null, model: 'Opus', contextUsed: 12_345, contextSize: null });
    expect(parseStatusline('x')).toBeNull();
    expect(parseStatusline(null)).toBeNull();
  });
});

describe('UsageTracker', () => {
  it('1 回目は rate_limits が無く、直前の値を保つ。2 回目で埋まる', () => {
    const db = openDb(':memory:');
    let t = 1_000;
    const tr = new UsageTracker(db, { now: () => t });
    expect(tr.current()).toEqual({ fiveHour: null, sevenDay: null, updatedAt: null });
    const a = tr.ingest(first)!;
    expect(a.usageChanged).toBe(false);
    expect(a.usage.updatedAt).toBeNull();
    t = 2_000;
    const b = tr.ingest(second)!;
    expect(b.usageChanged).toBe(true);
    expect(b.usage).toEqual({ fiveHour: { usedPercent: 47, resetsAt: 1_760_000_000_000 }, sevenDay: { usedPercent: 7, resetsAt: 1_760_500_000_000 }, updatedAt: 2_000 });
    t = 3_000;
    const c = tr.ingest(first)!;
    expect(c.usageChanged).toBe(false);
    expect(c.usage).toEqual(b.usage);
    expect((db.prepare('select count(*) c from usage_snapshots').get() as { c: number }).c).toBe(3);
    const ls = db.prepare('select * from session_live_stats where provider_session_id = ?').get('u1') as Record<string, unknown>;
    // 3 回目の payload は current_usage が null なので、2 回目の値を保つ。cost は 3 回目の値。
    expect(ls).toMatchObject({ model: 'claude-opus-4-1', effort: 'high', context_used: 50_000, context_size: 200_000, cost_usd: 0.05, updated_at: 3_000 });
  });
  it('起動時に直近のスナップショットから復元し、古いものを keep 件に切る', () => {
    const db = openDb(':memory:');
    let t = 10;
    const tr = new UsageTracker(db, { now: () => t, keep: 3 });
    tr.ingest(second);
    for (let i = 0; i < 4; i++) { t += 10; tr.ingest(first); }
    expect((db.prepare('select count(*) c from usage_snapshots').get() as { c: number }).c).toBe(3);
    // keep で second のスナップショットは消えたが、復元は残っている行だけを見る。
    const fresh = new UsageTracker(db, { now: () => t, keep: 3 });
    expect(fresh.current()).toEqual({ fiveHour: null, sevenDay: null, updatedAt: null });
    t += 10;
    tr.ingest(second);
    const again = new UsageTracker(db, { now: () => t, keep: 3 });
    expect(again.current()).toEqual({ fiveHour: { usedPercent: 47, resetsAt: 1_760_000_000_000 }, sevenDay: { usedPercent: 7, resetsAt: 1_760_500_000_000 }, updatedAt: t });
  });
  it('同じミリ秒の 2 件は at をずらして両方残す。壊れた payload は null', () => {
    const db = openDb(':memory:');
    const tr = new UsageTracker(db, { now: () => 5 });
    tr.ingest(first); tr.ingest(first);
    expect((db.prepare('select at from usage_snapshots order by at').all() as { at: number }[]).map((r) => r.at)).toEqual([5, 6]);
    expect(tr.ingest('not json')).toBeNull();
  });
});
