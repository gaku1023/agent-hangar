import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { SyncEngine } from './engine.ts';
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

describe('立て直しても、上限で退いていることを忘れない', () => {
  it('戻る時刻は sync_state に残り、立て直した直後に外へ出ない。時刻を過ぎていれば最初の要求から戻る', async () => {
    timers.now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const midnight = Date.UTC(2026, 9, 9);
    const a = make();
    await a.start();
    cloud.limited = 'd1-write';
    upsertShared(db, 'projects', { id: 'p1', name: 'p1', status: 'active', is_scratch: 0 }, 'a');
    await timers.advance(1_000);
    await a.idle();
    a.stop();
    expect(new SyncStateStore(db).get('limitedUntil')).toBe(String(midnight));

    // 同じ日のうちに立て直す。起動は利用者の押下ではないので、印を外さずに退いたままでいる。
    const calls = cloud.calls.length;
    const b = make();
    await b.start();
    await b.idle();
    expect(cloud.calls.length).toBe(calls);
    expect(b.status()).toMatchObject({ state: 'paused', limitedUntil: midnight });
    b.stop();

    // 日が変わってから立て直す。
    cloud.limited = null;
    timers.now = midnight + 1;
    const c = make();
    await c.start();
    await c.idle();
    expect(c.status()).toMatchObject({ state: 'idle', limitedUntil: null, pending: 0 });
    expect(new SyncStateStore(db).get('limitedUntil')).toBeNull();
    c.stop();
  });
});
