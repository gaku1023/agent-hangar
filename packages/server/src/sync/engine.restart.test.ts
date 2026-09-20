import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { SyncEngine } from './engine.ts';
import { QuotaCounter, quotaDayKey } from './quota.ts';
import { SyncStateStore } from './state.ts';

/**
 * サーバを立て直したときに、何を覚えていてほしいかの試験である。
 * 同じ DB の上で SyncEngine を作り直すのが「立て直し」で、本番の `server.ts` もそうなる。
 */

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;

const make = (over: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) =>
  new SyncEngine({ db, deviceId: 'a', client: cloud, now: () => timers.now, timers, url: 'https://h', ...over });

const project = (id: string) => upsertShared(db, 'projects', { id, name: id, status: 'active', is_scratch: 0 }, 'a');

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'a' });
  timers = new FakeTimers();
});

describe('立て直しても失敗の理由を忘れない', () => {
  it('起こし直した直後も error のままで、理由が読める', async () => {
    const a = make();
    await a.start();
    cloud.offline = true;
    project('p1');
    await a.pushNow();
    expect(a.status()).toMatchObject({ state: 'error' });
    const reason = a.status().error;
    expect(reason).not.toBeNull();
    a.stop();

    // 立て直す。送れていない行は残っているのに、理由だけ消えて idle に戻るのがいちばんの嘘である。
    const b = make();
    expect(b.status()).toMatchObject({ state: 'error', error: reason, pending: 1 });
    b.stop();
  });

  it('次の push が通れば、覚えていた理由は消える', async () => {
    const a = make();
    await a.start();
    cloud.offline = true;
    project('p1');
    await a.pushNow();
    a.stop();

    cloud.offline = false;
    const b = make();
    expect(b.status().state).toBe('error');
    await b.start();
    expect(b.status()).toMatchObject({ state: 'idle', error: null, pending: 0 });
    // sync_state にも残さない。
    expect(new SyncStateStore(db).get('lastError')).toBeNull();
    b.stop();
  });
});

describe('立て直しても、無料枠で止めた日を忘れない', () => {
  const tinyQuota = () => new QuotaCounter({ state: new SyncStateStore(db), now: () => timers.now, limits: { d1Writes: 10, requests: 1_000 } });

  it('利用者が再開した後に起こし直しても、同じ日に止め直さない', async () => {
    const a = make({ quota: tinyQuota() });
    await a.start();
    for (let i = 0; i < 8; i++) project(`p${i}`);
    await a.pushNow();
    expect(a.status().state).toBe('paused');
    expect(a.quota.pausedDay()).toBe(quotaDayKey(timers.now));
    // 利用者が再開を押す。
    a.setPaused(false);
    a.stop();

    // 立て直す。数えは sync_state に残っているので、判定はもう一度通る。
    const b = make({ quota: tinyQuota() });
    expect(b.quota.exceeded()).toBe(true);
    project('p9');
    await b.pushNow();
    // それでも止め直さない（決定は「1 日に 1 度だけ止める」である）。
    expect(b.status().state).not.toBe('paused');
    b.stop();
  });

  it('日付が変われば、その日はまた 1 度だけ止める', async () => {
    const a = make({ quota: tinyQuota() });
    await a.start();
    for (let i = 0; i < 8; i++) project(`p${i}`);
    await a.pushNow();
    expect(a.status().state).toBe('paused');
    a.setPaused(false);
    a.stop();

    timers.now += 86_400_000;
    const b = make({ quota: tinyQuota() });
    await b.start();
    for (let i = 0; i < 8; i++) project(`q${i}`);
    await b.pushNow();
    expect(b.status().state).toBe('paused');
    expect(b.quota.pausedDay()).toBe(quotaDayKey(timers.now));
    b.stop();
  });
});
