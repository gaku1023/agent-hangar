import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { SyncEngine } from './engine.ts';
import { QuotaCounter } from './quota.ts';
import { SyncStateStore } from './state.ts';

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;

const make = (over: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) =>
  new SyncEngine({ db, deviceId: 'a', client: cloud, now: () => timers.now, timers, url: 'https://h', ...over });
const unpushed = () => (db.prepare('select count(*) c from changes where pushed_at is null').get() as { c: number }).c;
const project = (id: string, name = id) => upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, 'a');
const pushBatches = () => cloud.calls.filter((c) => c.method === 'pushChanges').map((c) => (c.args[0] as unknown[]).length);

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'a' });
  timers = new FakeTimers();
});

describe('SyncEngine の push', () => {
  it('書き込みの 1 秒後に未送信分をまとめて送り、pushed_at を書く', async () => {
    const e = make();
    await e.start();
    const statuses: string[] = [];
    e.on({ status: (s) => statuses.push(s.state) });
    project('p1'); project('p2');
    expect(unpushed()).toBe(2);
    expect(e.status().pending).toBe(2);
    await timers.advance(999);
    expect(cloud.changes).toHaveLength(0);
    await timers.advance(1);
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
    expect(pushBatches()).toEqual([2]);
    expect(unpushed()).toBe(0);
    expect(e.status()).toMatchObject({ state: 'idle', pending: 0, lastPushAt: timers.now, error: null, url: 'https://h' });
    expect(statuses).toContain('pushing');
    e.stop();
  });

  it('40 行ずつのバッチに分ける', async () => {
    const e = make();
    await e.start();
    for (let i = 0; i < 90; i++) project(`p${i}`);
    await e.pushNow();
    expect(pushBatches()).toEqual([40, 40, 10]);
    expect(unpushed()).toBe(0);
    e.stop();
  });

  it('オフラインでは積んだまま残し、復帰で順に送る', async () => {
    const e = make();
    await e.start();
    cloud.offline = true;
    project('p1');
    await timers.advance(1000);
    expect(unpushed()).toBe(1);
    expect(e.status()).toMatchObject({ state: 'error', pending: 1 });
    expect(e.status().error).toContain('offline');
    project('p2');
    await timers.advance(1000);
    expect(unpushed()).toBe(2);
    cloud.offline = false;
    await e.pushNow();
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
    expect(e.status()).toMatchObject({ state: 'idle', error: null, pending: 0 });
    e.stop();
  });

  it('一時停止中は送らず、再開で送る', async () => {
    const e = make();
    await e.start();
    e.setPaused(true);
    expect(e.status().state).toBe('paused');
    project('p1');
    await timers.advance(5000);
    expect(unpushed()).toBe(1);
    e.setPaused(false);
    await timers.advance(1000);
    expect(unpushed()).toBe(0);
    const e2 = make();
    expect(e2.status().state).toBe('idle');
    e.stop();
  });

  it('client が無ければ off で、書き込みは積むだけ', async () => {
    const e = make({ client: null, url: null });
    await e.start();
    project('p1');
    await timers.advance(2000);
    expect(e.status()).toMatchObject({ state: 'off', pending: 1, url: null });
    expect(cloud.calls).toEqual([]);
    e.stop();
  });

  it('push 済みで 7 日を過ぎた行を消す', async () => {
    const e = make();
    await e.start();
    project('p1');
    await e.pushNow();
    timers.now += 8 * 86_400_000;
    project('p2');
    await e.pushNow();
    expect((db.prepare('select row_id from changes order by seq').all() as { row_id: string }[]).map((r) => r.row_id)).toEqual(['p2']);
    e.stop();
  });

  it('stop の後は書き込みに反応しない', async () => {
    const e = make();
    await e.start();
    e.stop();
    project('p1');
    await timers.advance(2000);
    expect(unpushed()).toBe(1);
    expect(timers.pendingCount()).toBe(0);
  });

  it('前回の push から 10 秒経つまでは、デバウンスの期限が来ても送らない', async () => {
    const e = make();
    await e.start();
    project('p1');
    await timers.advance(1000);
    expect(unpushed()).toBe(0);
    const first = timers.now;

    project('p2');
    await timers.advance(1000);
    expect(unpushed()).toBe(1);
    expect(pushBatches()).toEqual([1]);
    await timers.advance(8000);
    expect(unpushed()).toBe(1);

    await timers.advance(1000);
    expect(timers.now).toBe(first + 10_000);
    expect(unpushed()).toBe(0);
    expect(pushBatches()).toEqual([1, 1]);
    e.stop();
  });

  it('利用者の syncNow は最小間隔を無視する', async () => {
    const e = make();
    await e.start();
    project('p1');
    await timers.advance(1000);
    expect(unpushed()).toBe(0);

    project('p2');
    await e.syncNow();
    expect(unpushed()).toBe(0);
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
    e.stop();
  });

  it('無料枠の 80% に達したら自分で一時停止してトーストを出す', async () => {
    const quota = new QuotaCounter({ state: new SyncStateStore(db), now: () => timers.now, limits: { d1Writes: 10, requests: 1_000 } });
    const e = make({ quota });
    await e.start();
    const toasts: { level: string; message: string }[] = [];
    e.on({ toast: (level, message) => toasts.push({ level, message }) });

    for (let i = 0; i < 8; i++) project(`p${i}`);
    await e.pushNow();
    expect(quota.today().rows).toBe(8);
    expect(e.status().state).toBe('paused');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.level).toBe('info');
    expect(toasts[0]?.message).toContain('80%');

    // 止まっている間は送らず、トーストも増えない。
    project('p9');
    await e.pushNow();
    await timers.advance(2000);
    expect(unpushed()).toBe(1);
    expect(toasts).toHaveLength(1);

    // 日付をまたぐと数えは 0 に戻るが、一時停止は自動では解けない。
    timers.now += 86_400_000;
    expect(quota.today()).toEqual({ rows: 0, requests: 0 });
    expect(e.status().state).toBe('paused');
    expect(unpushed()).toBe(1);
    e.stop();
  });

  it('枠で止まった後に利用者が再開したら、その日はもう止めない', async () => {
    const quota = new QuotaCounter({ state: new SyncStateStore(db), now: () => timers.now, limits: { d1Writes: 10, requests: 1_000 } });
    const e = make({ quota });
    await e.start();
    const toasts: string[] = [];
    e.on({ toast: (_l, m) => toasts.push(m) });

    for (let i = 0; i < 8; i++) project(`p${i}`);
    await e.pushNow();
    expect(e.status().state).toBe('paused');

    e.setPaused(false);
    project('p9');
    await e.pushNow();
    expect(unpushed()).toBe(0);
    expect(e.status().state).toBe('idle');
    expect(toasts).toHaveLength(1);
    e.stop();
  });

  it('setClaudeConfigStatus は status に載り、購読へ配る', async () => {
    const e = make();
    await e.start();
    const seen: { enabled: boolean; confirmed: boolean }[] = [];
    e.on({ status: (s) => seen.push(s.claudeConfig) });
    expect(e.status().claudeConfig).toEqual({ enabled: false, confirmed: false });
    e.setClaudeConfigStatus({ enabled: true, confirmed: false });
    expect(e.status().claudeConfig).toEqual({ enabled: true, confirmed: false });
    expect(seen).toEqual([{ enabled: true, confirmed: false }]);
    e.stop();
  });
});
