import { describe, expect, it } from 'vitest';
import { translator, type CloudUsageDto, type SyncStatusBody } from '@agent-hangar/shared';
import { presentCloudUsage as present } from './cloudUsage.ts';

const ja = translator('ja');
const en = translator('en');
const presentCloudUsage = (...a: Parameters<typeof present> extends [unknown, ...infer R] ? R : never) => present(ja, ...a);

const NOW = Date.parse('2026-10-02T06:48:00Z'); // 日本時間 15:48
const TZ = 'Asia/Tokyo';
const RESET = Date.parse('2026-10-03T00:00:00Z');
const base: CloudUsageDto = {
  source: 'cloudflare', fetchedAt: NOW - 120_000, stale: false, notice: null,
  limits: { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 },
  today: { d1RowsWritten: 23480, workersRequests: 4120, resetAt: RESET },
  plan: { workersPaid: false, r2Paid: true },
  month: { periodStart: '2026-09-05T00:00:00Z', periodEnd: '2026-10-05T00:00:00Z', throughDay: '2026-09-30', billedUsd: 0, rows: [
    { label: 'R2 Data Storage', consumed: 0.165, unit: 'GB-months', included: 10 },
    { label: 'R2 Storage Class A Operations', consumed: 6470, unit: 'Count', included: 1_000_000 },
    { label: 'R2 Infrequent Access Data Retrieval', consumed: 3, unit: 'GB', included: null },
  ] },
};
const unknown: CloudUsageDto = { ...base, source: 'unknown', fetchedAt: null, plan: null, month: null, today: { d1RowsWritten: null, workersRequests: null, resetAt: RESET } };
const sync = (o: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', url: 'https://w', lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 1, limitedUntil: null, paused: false, skipped: [], sweepPending: 0, oncePass: false, ...o });
/** 上限で退いている同期の状態。 */
const limitedSync = (): SyncStatusBody => sync({ state: 'paused', limitedUntil: RESET });
const TOKEN_COMMAND = 'npm run hangar -- setup cloud --usage-token';

describe('presentCloudUsage', () => {
  it('ふだん：札 3 枚と棒（今日 2、区切り、今月）。目盛りは無い', () => {
    const p = presentCloudUsage(base, sync(), NOW, TZ)!;
    expect(p.tiles).toEqual([
      { key: 'bill', label: '今月の請求', value: '$0.00', sub: '9/30 分まで', tone: 'ok' },
      { key: 'd1', label: 'D1 の書き込み（今日）', value: '23%', sub: '23,480 行', tone: 'ok' },
      { key: 'plan', label: 'プラン', value: 'Workers 無料', sub: 'R2 従量', tone: 'ok' },
    ]);
    expect(p.bars.map((b) => [b.label, b.when, b.pct, b.value, b.tone])).toEqual([
      ['D1 の書き込み', 'day', 23.48, '23,480 / 100,000 行', 'ok'],
      ['Workers の要求', 'day', 4.12, '4,120 / 100,000 回', 'ok'],
      ['R2 の保存', 'month', 1.65, '0.17 / 10 GB-月', 'ok'],
      ['R2 の書く操作', 'month', 0.65, '6,470 / 100 万', 'ok'],
      ['R2 Infrequent Access Data Retrieval', 'month', null, '3 GB', 'ok'],
    ]);
    expect(p.bars.every((b) => !('tickPct' in b))).toBe(true);
    expect(p.splitAfter).toBe(2);
    expect(p.legend).toEqual(['今日の枠は 9:00 にリセット', '今月は 9/5〜10/5']);
    expect(p.source).toBe('Cloudflare の実測値 · 2 分前');
    expect(p.strip).toBeNull();
    expect(p.command).toBeNull();
  });

  it('止まりそう：D1 の上限の 80%（8 万行）以上で注意の色と、上限までの残りの行数', () => {
    const p = presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 86_120 } }, sync(), NOW, TZ)!;
    expect(p.tiles[1]).toMatchObject({ value: '86%', tone: 'warn' });
    expect(p.bars[0]!.tone).toBe('warn');
    expect(p.legend).toEqual(['あと 13,880 行で無料枠の上限です · 9:00 にリセット']);
    expect(presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 79_999 } }, sync(), NOW, TZ)!.tiles[1]!.tone).toBe('ok');
  });

  it('上限で止まっている：止まった色と、自動で再開する帯', () => {
    const p = presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 100_000 } }, limitedSync(), NOW, TZ)!;
    expect(p.tiles[1]!.tone).toBe('stop');
    expect(p.bars[0]!.tone).toBe('stop');
    expect(p.legend).toEqual([]);
    expect(p.strip).toEqual({ tone: 'stop', text: 'Cloudflare の無料枠の上限に達したので、同期を停止しています。9:00 に枠がリセットされると、自動で再開します。' });
    expect(p.command).toBeNull();
  });

  it('上限で退いている間の帯の時刻は、同期の戻る時刻（limitedUntil）から出す', () => {
    // UTC の 0 時の直後に断られると、戻る時刻は 0 時の 5 分後になる。帯をヘッダーとそろえる。
    const p = presentCloudUsage(base, sync({ state: 'paused', limitedUntil: RESET + 5 * 60_000 }), NOW, TZ)!;
    expect(p.strip).toEqual({ tone: 'stop', text: 'Cloudflare の無料枠の上限に達したので、同期を停止しています。9:05 に枠がリセットされると、自動で再開します。' });
    // 退いていないときの凡例と出どころの時刻は、今までどおり今日の枠の戻る時刻である。
    expect(presentCloudUsage(base, sync(), NOW, TZ)!.legend[0]).toBe('今日の枠は 9:00 にリセット');
    expect(presentCloudUsage(unknown, sync(), NOW, TZ)!.source).toBe('数は不明（hangar は数えません） · 今日の枠は 9:00 にリセット');
  });

  it('手で止めたときは帯を出さない', () => {
    expect(presentCloudUsage(base, sync({ state: 'paused' }), NOW, TZ)!.strip).toBeNull();
  });

  it('止めている間に数が分からないときは、トークンを求めず、問い合わせていないと言う', () => {
    const p = presentCloudUsage(unknown, sync({ state: 'paused' }), NOW, TZ)!;
    expect(p.tiles.map((t) => [t.key, t.value, t.sub])).toEqual([['bill', '—', '同期の停止中'], ['d1', '—', '同期の停止中'], ['plan', '—', '同期の停止中']]);
    expect(p.bars).toEqual([]);
    expect(p.strip).toEqual({ tone: 'info', text: '同期を一時停止している間は Cloudflare に問い合わせません。再開すると Cloudflare の実測値と今月の請求額が出ます。' });
    expect(p.command).toBeNull();
    // 上限で止まっているときは、止まった帯を先に出す。
    const q = presentCloudUsage(unknown, limitedSync(), NOW, TZ)!;
    expect(q.strip?.tone).toBe('stop');
    expect(q.tiles[1]).toMatchObject({ value: '—', tone: 'stop' });
    expect(q.command).toBeNull();
  });

  it('トークンなし：数は不明。札は値の無い印、今日の棒は描かず、案内とコマンドを出す', () => {
    const p = presentCloudUsage(unknown, sync(), NOW, TZ)!;
    expect(p.tiles).toEqual([
      { key: 'bill', label: '今月の請求', value: '—', sub: 'トークンが要ります', tone: 'muted' },
      { key: 'd1', label: 'D1 の書き込み（今日）', value: '—', sub: 'トークンが要ります', tone: 'muted' },
      { key: 'plan', label: 'プラン', value: '—', sub: 'トークンが要ります', tone: 'muted' },
    ]);
    expect(p.bars).toEqual([]);
    expect(p.splitAfter).toBe(0);
    expect(p.legend).toEqual([]);
    expect(p.source).toBe('数は不明（hangar は数えません） · 今日の枠は 9:00 にリセット');
    expect(p.strip).toEqual({ tone: 'info', text: 'Cloudflare の実測値、R2、今月の請求額は、読み取り専用の API トークンを入力すると出ます。' });
    expect(p.command).toBe(TOKEN_COMMAND);
  });

  it('トークンの失効は案内の帯をその文に替える', () => {
    const msg = 'トークンが無効です。setup cloud --usage-token で入れ直してください';
    expect(presentCloudUsage({ ...unknown, notice: msg }, sync(), NOW, TZ)!.strip).toEqual({ tone: 'info', text: msg });
  });

  it('取れなかった：最後の値と時刻と失敗', () => {
    const p = presentCloudUsage({ ...base, stale: true, fetchedAt: Date.parse('2026-10-02T05:02:00Z') }, sync(), NOW, TZ)!;
    expect(p.source).toBe('Cloudflare の実測値 · 14:02 · 取得に失敗');
  });

  it('Workers Paid：今日の札と棒を出さない', () => {
    const p = presentCloudUsage({ ...base, plan: { workersPaid: true, r2Paid: false } }, sync(), NOW, TZ)!;
    expect(p.tiles.map((t) => t.key)).toEqual(['bill', 'plan']);
    expect(p.bars.every((b) => b.when === 'month')).toBe(true);
    expect(p.splitAfter).toBe(0);
    expect(p.legend).toEqual(['今月は 9/5〜10/5']);
  });

  it('期の初めで請求の行がまだ無い：$0.00 と出し、「分まで」と期の添え書きを出さず、落ちない', () => {
    const p = presentCloudUsage({ ...base, month: { periodStart: '', periodEnd: '2026-11-05T00:00:00Z', throughDay: null, billedUsd: 0, rows: [] } }, sync(), NOW, TZ)!;
    expect(p.tiles[0]).toEqual({ key: 'bill', label: '今月の請求', value: '$0.00', sub: '', tone: 'ok' });
    expect(p.bars.map((b) => b.when)).toEqual(['day', 'day']);
    expect(p.legend).toEqual(['今日の枠は 9:00 にリセット']);
  });

  it('期の日付は UTC の日で書く（端末の時差で前の日にずれない）', () => {
    expect(presentCloudUsage(base, sync(), NOW, 'America/Los_Angeles')!.legend[1]).toBe('今月は 9/5〜10/5');
  });

  it('期の終わりが読めなければ、終わりは空にする', () => {
    expect(presentCloudUsage({ ...base, month: { ...base.month!, periodEnd: 'not-a-date' } }, sync(), NOW, TZ)!.legend[1]).toBe('今月は 9/5〜');
  });

  it('使用量がまだ届いていなければ null', () => {
    expect(presentCloudUsage(null, sync(), NOW, TZ)).toBeNull();
  });

  it('英語：日本語を出さず、万にまとめず、単数と複数を使い分ける', () => {
    const p = present(en, base, sync(), NOW, TZ)!;
    expect(p.tiles.map((t) => [t.label, t.sub])).toEqual([["This month's bill", 'Through 9/30'], ['D1 writes (today)', '23,480 rows'], ['Plan', 'R2 pay-as-you-go']]);
    expect(p.bars.map((b) => [b.label, b.when, b.value])).toEqual([
      ['D1 writes', 'day', '23,480 / 100,000 rows'],
      ['Workers requests', 'day', '4,120 / 100,000 requests'],
      ['R2 storage', 'month', '0.17 / 10 GB-months'],
      ['R2 write operations', 'month', '6,470 / 1,000,000'],
      ['R2 Infrequent Access Data Retrieval', 'month', '3 GB'],
    ]);
    expect(p.legend).toEqual(["Today's allowance resets at 9:00", 'This month: 9/5–10/5']);
    expect(p.source).toBe('Cloudflare figures · 2 min ago');
    expect(present(en, { ...base, today: { ...base.today, d1RowsWritten: 99_999 } }, sync(), NOW, TZ)!.legend).toEqual(['1 row left before the free tier limit · Resets at 9:00']);
    expect(present(en, unknown, limitedSync(), NOW, TZ)!.strip!.text).toBe('Sync is paused because the Cloudflare free tier limit was reached. It resumes automatically when the allowance resets at 9:00.');
  });
});
