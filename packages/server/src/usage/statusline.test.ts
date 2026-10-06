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
  it('トークンの項目を 1 つも持たない current_usage は null にする', () => {
    expect(parseStatusline({ context_window: { current_usage: { output_tokens: 7 } } })).toMatchObject({ contextUsed: null });
    expect(parseStatusline({ context_window: { current_usage: {} } })).toMatchObject({ contextUsed: null });
    expect(parseStatusline({ context_window: { current_usage: { input_tokens: 0, output_tokens: 7 } } })).toMatchObject({ contextUsed: 0 });
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
  it('トークンの項目を持たない current_usage は既存の context_used を上書きしない', () => {
    const db = openDb(':memory:');
    let t = 1_000;
    const tr = new UsageTracker(db, { now: () => t });
    tr.ingest(second);
    t = 2_000;
    tr.ingest({ ...first, context_window: { context_window_size: 200_000, current_usage: { output_tokens: 7 } } });
    const ls = db.prepare('select * from session_live_stats where provider_session_id = ?').get('u1') as Record<string, unknown>;
    expect(ls).toMatchObject({ context_used: 50_000, context_size: 200_000, updated_at: 2_000 });
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

describe('アカウントごとの使用量', () => {
  const payload = (sid: string, five: number, seven: number) => ({ session_id: sid, rate_limits: { five_hour: { used_percentage: five, resets_at: 1000 }, seven_day: { used_percentage: seven, resets_at: 2000 } } });
  const accountOf = (sid: string | null) => (sid === 'univ-session' ? 'a1' : 'primary');

  it('セッションのアカウントへ振り分け、互いに上書きしない', () => {
    const db = openDb(':memory:');
    let t = 100;
    const u = new UsageTracker(db, { now: () => t++, accountOf });
    const r1 = u.ingest(payload('work-session', 82, 41))!;
    const r2 = u.ingest(payload('univ-session', 12, 9))!;
    expect([r1.accountId, r2.accountId]).toEqual(['primary', 'a1']);
    expect(r2.usage.fiveHour?.usedPercent).toBe(12);
    expect(u.current().fiveHour?.usedPercent).toBe(82);
    expect(u.of('a1')).toEqual({ fiveHour: { usedPercent: 12, resetsAt: 1_000_000 }, sevenDay: { usedPercent: 9, resetsAt: 2_000_000 }, updatedAt: 101 });
    expect(u.of('unknown')).toEqual({ fiveHour: null, sevenDay: null, updatedAt: null });
  });

  it('起動時に、アカウントごとの直近の値と時刻を復元する', () => {
    const db = openDb(':memory:');
    let t = 100;
    const u = new UsageTracker(db, { now: () => t++, accountOf });
    u.ingest(payload('univ-session', 12, 9));
    u.ingest(payload('work-session', 82, 41));
    const again = new UsageTracker(db, { accountOf });
    expect(again.of('a1').fiveHour?.usedPercent).toBe(12);
    expect(again.of('a1').updatedAt).toBe(100);
    expect(again.current().updatedAt).toBe(101);
  });

  it('keep はアカウントごとに数える。片方が多くても、もう片方の値は押し出されない', () => {
    const db = openDb(':memory:');
    let t = 100;
    const u = new UsageTracker(db, { now: () => t++, keep: 3, accountOf });
    u.ingest(payload('univ-session', 12, 9));
    for (let i = 0; i < 10; i++) u.ingest(payload('work-session', 50 + i, 41));
    expect((db.prepare("select count(*) n from usage_snapshots where account = 'primary'").get() as { n: number }).n).toBe(3);
    expect((db.prepare("select count(*) n from usage_snapshots where account = 'a1'").get() as { n: number }).n).toBe(1);
    expect(new UsageTracker(db, { accountOf }).of('a1').fiveHour?.usedPercent).toBe(12);
  });

  it('v15 より前に積まれた行（account が null）は primary として復元する', () => {
    const db = openDb(':memory:');
    db.prepare('insert into usage_snapshots (at, payload) values (?, ?)').run(50, JSON.stringify(payload('old', 70, 30)));
    expect(new UsageTracker(db).current().fiveHour?.usedPercent).toBe(70);
  });
});
