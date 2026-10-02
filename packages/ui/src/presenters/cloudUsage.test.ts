import { describe, expect, it } from 'vitest';
import type { CloudUsageDto, SyncStatusBody } from '@agent-hangar/shared';
import { presentCloudUsage } from './cloudUsage.ts';

const NOW = Date.parse('2026-10-02T06:48:00Z'); // 日本時間 15:48
const TZ = 'Asia/Tokyo';
const base: CloudUsageDto = {
  source: 'cloudflare', fetchedAt: NOW - 120_000, stale: false, notice: null,
  limits: { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000, stopRatio: 0.8 },
  today: { d1RowsWritten: 23480, workersRequests: 4120, resetAt: Date.parse('2026-10-03T00:00:00Z') },
  plan: { label: 'Workers 無料 · R2 従量', workersPaid: false },
  month: { periodStart: '2026-09-05T00:00:00Z', periodEnd: '2026-10-05T00:00:00Z', throughDay: '2026-09-30', billedUsd: 0, rows: [
    { label: 'R2 の保存', consumed: 0.165, unit: 'GB-月', included: 10 },
    { label: 'R2 の書く操作', consumed: 6470, unit: '回', included: 1_000_000 },
    { label: 'R2 Infrequent Access Data Retrieval', consumed: 3, unit: 'GB', included: null },
  ] },
};
const sync = (o: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', url: 'https://w', lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 1, claudeConfig: { enabled: false, confirmed: false }, skipped: [], sweepPending: 0, ...o });

describe('presentCloudUsage', () => {
  it('ふだん：札 3 枚と棒（今日 2、区切り、今月）', () => {
    const p = presentCloudUsage(base, sync(), NOW, TZ)!;
    expect(p.tiles).toEqual([
      { key: 'bill', label: '今月の請求', value: '$0.00', sub: '9/30 分まで', tone: 'ok' },
      { key: 'd1', label: 'D1 の書き込み（今日）', value: '23%', sub: '23,480 行', tone: 'ok' },
      { key: 'plan', label: 'プラン', value: 'Workers 無料', sub: 'R2 従量', tone: 'ok' },
    ]);
    expect(p.bars.map((b) => [b.label, b.when, b.pct, b.tickPct, b.value, b.tone])).toEqual([
      ['D1 の書き込み', '今日', 23.48, 80, '23,480 / 100,000 行', 'ok'],
      ['Workers の要求', '今日', 4.12, 80, '4,120 / 100,000 回', 'ok'],
      ['R2 の保存', '今月', 1.65, null, '0.17 / 10 GB-月', 'ok'],
      ['R2 の書く操作', '今月', 0.65, null, '6,470 / 100 万', 'ok'],
      ['R2 Infrequent Access Data Retrieval', '今月', null, null, '3 GB', 'ok'],
    ]);
    expect(p.splitAfter).toBe(2);
    expect(p.legend).toEqual(['今日の枠は 9:00 に戻る · 目盛りの 80% で同期を止める', '今月は 9/5〜10/5']);
    expect(p.source).toBe('Cloudflare の数 · 2 分前');
    expect(p.strip).toBeNull();
    expect(p.command).toBeNull();
  });
  it('止まりそう：止める線の 75%（6 万行）以上で注意の色と残りの行数', () => {
    const p = presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 68120 } }, sync(), NOW, TZ)!;
    expect(p.tiles[1]).toMatchObject({ value: '68%', tone: 'warn' });
    expect(p.bars[0]!.tone).toBe('warn');
    expect(p.legend).toEqual(['あと 11,880 行で同期を止めます · 9:00 に戻る']);
    expect(p.source).toBe('Cloudflare の数 · 2 分前');
  });
  it('無料枠で停止中：止まった色と再開の帯。Cloudflare の数が 80% 未満なら食い違いを添える', () => {
    const p = presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 58590 } }, sync({ state: 'paused', pausedReason: 'quota', quotaPausedDay: '2026-10-02' }), NOW, TZ)!;
    expect(p.tiles[1]!.tone).toBe('stop');
    expect(p.bars[0]!.tone).toBe('stop');
    expect(p.legend).toEqual([]);
    expect(p.source).toBe('Cloudflare の数 · 2 分前');
    expect(p.strip).toEqual({ tone: 'stop', text: '無料枠の 80% に届いたので同期を止めました（Cloudflare の数では 59%）。9:00 に枠が戻ります。戻ったあと「同期を再開」で再開できます。' });
  });
  it('停止中で枠が戻った後は、戻ったと言う', () => {
    const p = presentCloudUsage(base, sync({ state: 'paused', pausedReason: 'quota', quotaPausedDay: '2026-10-01' }), NOW, TZ)!;
    expect(p.strip?.text).toBe('無料枠の 80% に届いたので同期を止めました。枠は戻っています。「同期を再開」で再開できます。');
    expect(p.legend).toEqual([]);
    expect(p.source).toBe('Cloudflare の数 · 2 分前');
  });
  it('手で止めたときは帯を出さない', () => {
    expect(presentCloudUsage(base, sync({ state: 'paused', pausedReason: 'user' }), NOW, TZ)!.strip).toBeNull();
  });
  it('トークンなし：見積もりの札と棒、案内とコマンド', () => {
    const p = presentCloudUsage({ ...base, source: 'estimate', fetchedAt: null, plan: null, month: null, today: { ...base.today, d1RowsWritten: 26700, workersRequests: 3640 } }, sync(), NOW, TZ)!;
    expect(p.tiles).toEqual([
      { key: 'bill', label: '今月の請求', value: '—', sub: 'トークンが要ります', tone: 'muted' },
      { key: 'd1', label: 'D1 の書き込み（今日）', value: '約 27%', sub: '見積もり', tone: 'ok' },
      { key: 'plan', label: 'プラン', value: '—', sub: 'トークンが要ります', tone: 'muted' },
    ]);
    expect(p.bars.map((b) => b.value)).toEqual(['約 26,700 / 100,000 行', 'この PC 3,640 回']);
    expect(p.legend).toEqual([]);
    expect(p.source).toBe('hangar の見積もり（実際より 1〜4 割多め）· 9:00 に戻る');
    expect(p.strip).toEqual({ tone: 'info', text: 'Cloudflare の正確な数、R2、今月の費用は、読み取り専用のトークンを入れると出ます。' });
    expect(p.command).toBe('npm run hangar -- setup cloud --usage-token');
  });
  it('トークンの失効は案内の帯をその文に替える', () => {
    const msg = 'トークンが無効です。setup cloud --usage-token で入れ直してください';
    const p = presentCloudUsage({ ...base, source: 'estimate', fetchedAt: null, plan: null, month: null, notice: msg }, sync(), NOW, TZ)!;
    expect(p.strip).toEqual({ tone: 'info', text: msg });
  });
  it('取れなかった：最後の値と時刻と失敗', () => {
    const p = presentCloudUsage({ ...base, stale: true, fetchedAt: Date.parse('2026-10-02T05:02:00Z') }, sync(), NOW, TZ)!;
    expect(p.source).toBe('Cloudflare の数 · 14:02 · 取得に失敗');
  });
  it('Workers Paid：今日の札と棒を出さない', () => {
    const p = presentCloudUsage({ ...base, plan: { label: 'Workers Paid', workersPaid: true } }, sync(), NOW, TZ)!;
    expect(p.tiles.map((t) => t.key)).toEqual(['bill', 'plan']);
    expect(p.bars.every((b) => b.when === '今月')).toBe(true);
    expect(p.splitAfter).toBe(0);
    expect(p.legend).toEqual(['今月は 9/5〜10/5']);
    expect(p.source).toBe('Cloudflare の数 · 2 分前');
  });
  it('期の初めで請求の行がまだ無い：$0.00 と出し、「分まで」と期の添え書きを出さず、落ちない', () => {
    const p = presentCloudUsage({ ...base, month: { periodStart: '', periodEnd: '2026-11-05T00:00:00Z', throughDay: null, billedUsd: 0, rows: [] } }, sync(), NOW, TZ)!;
    expect(p.tiles[0]).toEqual({ key: 'bill', label: '今月の請求', value: '$0.00', sub: '', tone: 'ok' });
    expect(p.bars.map((b) => b.when)).toEqual(['今日', '今日']);
    expect(p.legend).toEqual(['今日の枠は 9:00 に戻る · 目盛りの 80% で同期を止める']);
  });
  it('期の日付は UTC の日で書く（端末の時差で前の日にずれない）', () => {
    const p = presentCloudUsage(base, sync(), NOW, 'America/Los_Angeles')!;
    expect(p.legend[1]).toBe('今月は 9/5〜10/5');
  });
  it('期の終わりが読めなければ、終わりは空にする', () => {
    const p = presentCloudUsage({ ...base, month: { ...base.month!, periodEnd: 'not-a-date' } }, sync(), NOW, TZ)!;
    expect(p.legend[1]).toBe('今月は 9/5〜');
  });
  it('トークンなしで止まりそう：見積もりの残りの行数を「約」付きで凡例に出す', () => {
    const p = presentCloudUsage({ ...base, source: 'estimate', fetchedAt: null, plan: null, month: null, today: { ...base.today, d1RowsWritten: 68120, workersRequests: 3640 } }, sync(), NOW, TZ)!;
    expect(p.tiles[1]).toMatchObject({ value: '約 68%', tone: 'warn' });
    expect(p.legend).toEqual(['あと約 11,880 行で同期を止めます · 9:00 に戻る']);
    // 戻る時刻は凡例が言うので、出どころの行には重ねない。
    expect(p.source).toBe('hangar の見積もり（実際より 1〜4 割多め）');
  });
  it('使用量がまだ届いていなければ null', () => {
    expect(presentCloudUsage(null, sync(), NOW, TZ)).toBeNull();
  });
});
