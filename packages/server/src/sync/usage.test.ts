import { describe, expect, it, vi } from 'vitest';
import type { CloudUsageBody, CloudUsageDto } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { openDb } from '../db/open.ts';
import { QuotaCounter } from './quota.ts';
import { SyncStateStore } from './state.ts';
import { CloudUsagePoller, toUsageDto, USAGE_POLL_MS } from './usage.ts';

const NOW = Date.parse('2026-10-02T06:48:00Z');
const quota = () => new QuotaCounter({ state: new SyncStateStore(openDb(':memory:')), now: () => NOW });
const BODY: CloudUsageBody = {
  configured: true, fetchedAt: NOW - 120_000, errors: [],
  today: { day: '2026-10-02', d1RowsWritten: 23480, workersRequests: 4120 },
  plan: { workersPaid: false, items: [{ id: 'r2_paid', name: 'R2 Paid', priceUsd: 0, frequency: 'monthly' }], periodStart: '2026-09-05T00:50:22Z', periodEnd: '2026-10-05T00:00:00Z' },
  month: { periodStart: '2026-09-05T00:00:00Z', throughDay: '2026-09-30', billedUsd: 0, currency: 'USD', services: [
    { family: 'R2', name: 'R2 Data Storage (First 10GB-Month included)', consumed: 0.165, unit: 'GB-months', billedUsd: 0 },
    { family: 'R2', name: 'R2 Storage Class A Operations (First 1M included)', consumed: 6470, unit: 'Count', billedUsd: 0 },
    { family: 'R2', name: 'R2 Infrequent Access Data Retrieval', consumed: 3, unit: 'GB', billedUsd: 0 },
  ] },
};

describe('toUsageDto', () => {
  it('Cloudflare の数を、上限と込み量を添えて写す', () => {
    const d = toUsageDto(BODY, { quota: quota(), now: NOW, stale: false, lastGood: null });
    expect(d).toMatchObject({ source: 'cloudflare', fetchedAt: NOW - 120_000, stale: false, notice: null });
    expect(d.limits).toEqual({ d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000, stopRatio: 0.8 });
    expect(d.today).toEqual({ d1RowsWritten: 23480, workersRequests: 4120, resetAt: Date.parse('2026-10-03T00:00:00Z') });
    expect(d.plan).toEqual({ label: 'Workers 無料 · R2 従量', workersPaid: false });
    expect(d.month?.rows).toEqual([
      { label: 'R2 の保存', consumed: 0.165, unit: 'GB-月', included: 10 },
      { label: 'R2 の書く操作', consumed: 6470, unit: '回', included: 1_000_000 },
      { label: 'R2 Infrequent Access Data Retrieval', consumed: 3, unit: 'GB', included: null },
    ]);
    expect(d.month).toMatchObject({ periodStart: '2026-09-05T00:00:00Z', periodEnd: '2026-10-05T00:00:00Z', throughDay: '2026-09-30', billedUsd: 0 });
  });
  it('configured: false と null は見積もり', () => {
    const q = quota();
    q.note({ rows: 26700, requests: 3640 });
    for (const body of [{ configured: false } as const, null]) {
      const d = toUsageDto(body, { quota: q, now: NOW, stale: false, lastGood: null });
      expect(d).toMatchObject({ source: 'estimate', plan: null, month: null, today: { d1RowsWritten: 26700, workersRequests: 3640 } });
    }
  });
  it('トークンの失効は見積もりに落とし、文を添える', () => {
    const msg = 'トークンが無効です。setup cloud --usage-token で入れ直してください';
    const d = toUsageDto({ ...BODY, today: null, plan: null, month: null, errors: ['today', 'plan', 'month'].map((part) => ({ part: part as 'today', message: msg })) }, { quota: quota(), now: NOW, stale: false, lastGood: null });
    expect(d).toMatchObject({ source: 'estimate', notice: msg });
  });
  it('今日の数が取れず、前に取れた今日の数も無ければ、見積もりを Cloudflare の数と偽らない', () => {
    const q = quota();
    q.note({ rows: 26700, requests: 3640 });
    const d = toUsageDto({ ...BODY, today: null, errors: [{ part: 'today', message: 'Cloudflare が誤りを返しました' }] }, { quota: q, now: NOW, stale: false, lastGood: null });
    expect(d).toMatchObject({ source: 'estimate', stale: true, today: { d1RowsWritten: 26700, workersRequests: 3640 } });
  });
  it('今日の数が取れなくても、前に取れた今日の数があれば Cloudflare の数として stale で出す', () => {
    const good = toUsageDto(BODY, { quota: quota(), now: NOW, stale: false, lastGood: null });
    const d = toUsageDto({ ...BODY, today: null, errors: [{ part: 'today', message: 'Cloudflare が誤りを返しました' }] }, { quota: quota(), now: NOW, stale: false, lastGood: good });
    expect(d).toMatchObject({ source: 'cloudflare', stale: true, today: { d1RowsWritten: 23480 } });
  });
  it('Workers Paid はプランの語を変える', () => {
    const d = toUsageDto({ ...BODY, plan: { ...BODY.plan!, workersPaid: true, items: [{ id: 'workers_paid', name: 'Workers Paid', priceUsd: 5, frequency: 'monthly' }] } }, { quota: quota(), now: NOW, stale: false, lastGood: null });
    expect(d.plan).toEqual({ label: 'Workers Paid', workersPaid: true });
  });
});

describe('CloudUsagePoller', () => {
  const setup = (o: { paused?: boolean } = {}) => {
    const client = new FakeCloudClient();
    client.usageBody = BODY;
    const sent: CloudUsageDto[] = [];
    let paused = o.paused ?? false;
    const p = new CloudUsagePoller({ client, quota: quota(), isPaused: () => paused, broadcast: (u) => sent.push(u), now: () => NOW });
    return { client, sent, p, setPaused: (v: boolean) => { paused = v; } };
  };
  it('refresh で取りに行き、配る', async () => {
    const { p, sent } = setup();
    const d = await p.refresh();
    expect(d?.source).toBe('cloudflare');
    expect(sent).toHaveLength(1);
    expect(p.current()).toEqual(d);
  });
  it('一時停止の間は取りに行かず、最後の値を返す', async () => {
    const { p, client, setPaused } = setup();
    await p.refresh();
    setPaused(true);
    const before = client.calls.length;
    const d = await p.refresh();
    expect(client.calls.length).toBe(before);
    expect(d?.source).toBe('cloudflare');
  });
  it('取れたあとの失敗は、最後の値に stale を付ける', async () => {
    const { p, client } = setup();
    await p.refresh();
    client.offline = true;
    const d = await p.refresh();
    expect(d).toMatchObject({ source: 'cloudflare', stale: true, today: { d1RowsWritten: 23480 } });
  });
  it('一度も取れないまま失敗したら見積もりで、stale', async () => {
    const { p, client } = setup();
    client.offline = true;
    expect(await p.refresh()).toMatchObject({ source: 'estimate', stale: true });
  });
  it('同期を設定していない端末は null', async () => {
    const p = new CloudUsagePoller({ client: null, quota: quota(), isPaused: () => false, broadcast: () => {}, now: () => NOW });
    expect(await p.refresh()).toBeNull();
  });
  it('stop の後に届いた結果は配らず、DB も読まず、refresh も落ちない', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const db = openDb(':memory:');
      const q = new QuotaCounter({ state: new SyncStateStore(db), now: () => NOW });
      let settle!: { resolve: (b: CloudUsageBody) => void; reject: (e: Error) => void };
      const client = { usage: () => new Promise<CloudUsageBody>((resolve, reject) => { settle = { resolve, reject }; }) } as unknown as ConstructorParameters<typeof CloudUsagePoller>[0]['client'];
      const sent: CloudUsageDto[] = [];
      const p = new CloudUsagePoller({ client, quota: q, isPaused: () => false, broadcast: (u) => sent.push(u), now: () => NOW });
      const pending = p.refresh();
      p.stop();
      // 閉じる途中を真似る。stop の後に DB を読めば、ここで投げる。
      db.close();
      if (outcome === 'resolve') settle.resolve(BODY);
      else settle.reject(new Error('socket closed'));
      await expect(pending).resolves.toBeNull();
      expect(sent).toEqual([]);
      expect(p.current()).toBeNull();
    }
  });
  it('閉じた DB を読んで失敗しても refresh は落ちない', async () => {
    const db = openDb(':memory:');
    const q = new QuotaCounter({ state: new SyncStateStore(db), now: () => NOW });
    const client = { usage: async () => { db.close(); throw new Error('offline'); } } as unknown as ConstructorParameters<typeof CloudUsagePoller>[0]['client'];
    const p = new CloudUsagePoller({ client, quota: q, isPaused: () => false, broadcast: () => {}, now: () => NOW });
    await expect(p.refresh()).resolves.toBeNull();
  });
  it('start は 5 分ごとに取りに行き、stop で止まる', async () => {
    vi.useFakeTimers();
    try {
      const { p, client } = setup();
      p.start();
      await vi.advanceTimersByTimeAsync(0);
      const first = client.calls.filter((c) => c.method === 'usage').length;
      await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
      expect(client.calls.filter((c) => c.method === 'usage').length).toBe(first + 1);
      p.stop();
      await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
      expect(client.calls.filter((c) => c.method === 'usage').length).toBe(first + 1);
    } finally { vi.useRealTimers(); }
  });
});
