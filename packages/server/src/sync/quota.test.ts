import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { SyncStateStore } from './state.ts';
import { D1_WRITES_PER_CHANGE, D1_WRITES_PER_DEVICE_TOUCH, QUOTA_LIMITS, QUOTA_STOP_RATIO, QuotaCounter, pushD1Writes, quotaDayKey } from './quota.ts';

let db: Db;
let state: SyncStateStore;
let now = Date.UTC(2026, 8, 19, 10, 0, 0);

const make = (limits?: { d1Writes: number; requests: number }, ratio?: number) =>
  new QuotaCounter({ state, now: () => now, limits, ratio });

/** sync_state の行を直に読む。quota の鍵は SyncStateKey の外なので、包みを通さずに見る。 */
const raw = (key: string): string | null =>
  ((db.prepare('select value from sync_state where key = ?').get(key) as { value: string } | undefined)?.value ?? null);

const putRaw = (key: string, value: string): void => {
  db.prepare('insert into sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
};

beforeEach(() => {
  db = openDb(':memory:');
  state = new SyncStateStore(db);
  now = Date.UTC(2026, 8, 19, 10, 0, 0);
});

describe('QuotaCounter', () => {
  it('既定の上限と止める割合は無料枠に合わせてある', () => {
    expect(QUOTA_LIMITS).toEqual({ d1Writes: 100_000, requests: 100_000 });
    expect(QUOTA_STOP_RATIO).toBe(0.8);
  });

  it('同じ日の分を足し合わせ、sync_state に残す', () => {
    const q = make();
    q.note({ rows: 10, requests: 1 });
    q.note({ rows: 5, requests: 1 });
    q.note({ requests: 1 });
    expect(q.today()).toEqual({ rows: 15, requests: 3 });

    // 別のインスタンスから読み直せる（サーバを立て直しても数えが続く）。
    expect(make().today()).toEqual({ rows: 15, requests: 3 });
    expect(raw(quotaDayKey(now))).toBe('{"rows":15,"requests":3}');
  });

  it('日付が変われば 0 から数え直し、前の日の行は消える', () => {
    const q = make();
    q.note({ rows: 10, requests: 1 });
    const yesterday = quotaDayKey(now);

    now += 86_400_000;
    expect(q.today()).toEqual({ rows: 0, requests: 0 });
    q.note({ rows: 2, requests: 1 });
    expect(q.today()).toEqual({ rows: 2, requests: 1 });
    expect(raw(yesterday)).toBeNull();
  });

  it('日付は UTC で区切る（Cloudflare の枠が戻るのと同じ境目）', () => {
    expect(quotaDayKey(Date.UTC(2026, 8, 19, 23, 59, 59))).toBe('quota:2026-09-19');
    expect(quotaDayKey(Date.UTC(2026, 8, 20, 0, 0, 0))).toBe('quota:2026-09-20');
  });

  it('行数が上限の 80% に達したら exceeded になる', () => {
    const q = make({ d1Writes: 10, requests: 1000 });
    q.note({ rows: 7, requests: 1 });
    expect(q.exceeded()).toBe(false);
    q.note({ rows: 1, requests: 1 });
    expect(q.today()).toEqual({ rows: 8, requests: 2 });
    expect(q.exceeded()).toBe(true);

    now += 86_400_000;
    expect(q.exceeded()).toBe(false);
  });

  it('要求の回数だけでも 80% に達したら exceeded になる', () => {
    const q = make({ d1Writes: 1_000_000, requests: 10 });
    for (let i = 0; i < 7; i++) q.note({ requests: 1 });
    expect(q.exceeded()).toBe(false);
    q.note({ requests: 1 });
    expect(q.exceeded()).toBe(true);
  });

  it('割合は差し替えられる', () => {
    const q = make({ d1Writes: 100, requests: 100 }, 0.5);
    q.note({ rows: 49 });
    expect(q.exceeded()).toBe(false);
    q.note({ rows: 1 });
    expect(q.exceeded()).toBe(true);
  });

  it('手で書き換えられた値や壊れた値は 0 として読む', () => {
    putRaw(quotaDayKey(now), 'not json');
    const q = make();
    expect(q.today()).toEqual({ rows: 0, requests: 0 });
    q.note({ rows: 3, requests: 1 });
    expect(q.today()).toEqual({ rows: 3, requests: 1 });

    putRaw(quotaDayKey(now), '{"rows":"たくさん","requests":null}');
    expect(q.today()).toEqual({ rows: 0, requests: 0 });
  });

  it('負の値や小数を渡されても数えを壊さない', () => {
    const q = make();
    q.note({ rows: -5, requests: -1 });
    expect(q.today()).toEqual({ rows: 0, requests: 0 });
    q.note({ rows: 1.7, requests: 1 });
    expect(q.today()).toEqual({ rows: 1, requests: 1 });
  });
});

describe('pushD1Writes', () => {
  it('Worker が採った 1 行につき 2 行、要求ごとに devices の 1 行を数える', () => {
    expect(D1_WRITES_PER_CHANGE).toBe(2);
    expect(D1_WRITES_PER_DEVICE_TOUCH).toBe(1);
    expect(pushD1Writes(40, 40)).toBe(81);
    expect(pushD1Writes(1, 1)).toBe(3);
  });

  it('同着で弾かれた行は数えない', () => {
    // 40 行送って 1 行も採られなければ、書かれるのは devices の 1 行だけである。
    expect(pushD1Writes(0, 40)).toBe(1);
    expect(pushD1Writes(10, 40)).toBe(21);
  });

  it('accepted が読めない応答では、送った行数で代用する', () => {
    expect(pushD1Writes(undefined, 10)).toBe(21);
    expect(pushD1Writes(null, 10)).toBe(21);
    expect(pushD1Writes('たくさん', 10)).toBe(21);
    expect(pushD1Writes(-1, 10)).toBe(21);
    expect(pushD1Writes(Number.NaN, 10)).toBe(21);
  });
});
