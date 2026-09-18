import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers, flush } from '../../test/fake-timers.ts';
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

/**
 * pull は 2 端末で確かめる。
 * FakeCloudClient の asDevice は同じストアを別端末として見せるので、a が push したものを b が受け取れる。
 */
describe('SyncEngine の pull', () => {
  let dbB: Db;
  let cloudB: FakeCloudClient;
  const makeB = (over: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) =>
    new SyncEngine({ db: dbB, deviceId: 'b', client: cloudB, now: () => timers.now, timers, url: 'https://h', ...over });
  /** upsertShared の updated_at は実時間の Date.now() なので、書き込みの前に実時間を少し進めて順序を確実にする。 */
  const realDelay = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

  beforeEach(() => { dbB = openDb(':memory:'); cloudB = cloud.asDevice('b'); });

  it('初回は rows の写しを受け、以後は差分を受け、changes には積まない', async () => {
    const a = make();
    await a.start();
    project('p1');
    await a.pushNow();
    const b = makeB();
    const applied: string[] = [];
    let pulled = 0;
    b.on({ applied: (c) => applied.push(`${c.tableName}:${c.rowId}`), pulled: () => pulled++ });
    await b.start();
    expect((dbB.prepare('select name from projects where id = ?').get('p1') as { name: string }).name).toBe('p1');
    expect((dbB.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(0);
    expect(applied).toEqual(['projects:p1']);
    expect(pulled).toBe(1);
    expect(b.state.get('snapshotDone')).toBe('1');
    expect(b.state.getNumber('lastSeq', -1)).toBe(1);
    expect(cloudB.calls.filter((c) => c.method === 'snapshot')).toHaveLength(1);
    project('p2');
    await a.pushNow();
    await b.pullNow();
    expect(applied).toEqual(['projects:p1', 'projects:p2']);
    expect(b.state.getNumber('lastSeq', -1)).toBe(2);
    expect(cloudB.calls.filter((c) => c.method === 'pullChanges').at(-1)?.args[0]).toBe(1);
    expect(b.status()).toMatchObject({ state: 'idle', lastPullAt: timers.now });
    a.stop(); b.stop();
  });

  it('30 秒ごとに push と pull を回す', async () => {
    const a = make();
    const b = makeB();
    await a.start(); await b.start();
    project('p1');
    await timers.advance(30_000);
    expect(dbB.prepare('select 1 from projects where id = ?').get('p1')).toBeTruthy();
    a.stop(); b.stop();
  });

  it('両端末が同じ行を変えたら updated_at の新しい方に揃う', async () => {
    const a = make(); const b = makeB();
    await a.start(); await b.start();
    project('p1', 'from-a');
    await a.pushNow(); await b.pullNow();
    timers.now += 10; await realDelay(2);
    upsertShared(dbB, 'projects', { ...(dbB.prepare('select * from projects where id = ?').get('p1') as Record<string, unknown>), name: 'from-b' }, 'b');
    timers.now += 10; await realDelay(2);
    upsertShared(db, 'projects', { ...(db.prepare('select * from projects where id = ?').get('p1') as Record<string, unknown>), name: 'from-a-2' }, 'a');
    await b.pushNow(); await a.pushNow();
    await a.pullNow(); await b.pullNow();
    const nameA = (db.prepare('select name from projects where id = ?').get('p1') as { name: string }).name;
    const nameB = (dbB.prepare('select name from projects where id = ?').get('p1') as { name: string }).name;
    expect(nameA).toBe(nameB);
    expect(nameA).toBe('from-a-2');
    a.stop(); b.stop();
  });

  it('圧縮で消えた区間を指したら、全件の写しから作り直す', async () => {
    const a = make();
    await a.start();
    project('p1');
    await a.pushNow();
    const b = makeB();
    await b.start();
    expect(b.state.getNumber('lastSeq', -1)).toBe(1);

    project('p2'); await a.pushNow();
    project('p3'); await a.pushNow();
    // b がまだ読んでいない区間を Worker が圧縮で削った。
    cloud.compact(3);

    const applied: string[] = [];
    const toasts: string[] = [];
    b.on({ applied: (c) => applied.push(c.rowId), toast: (_l, m) => toasts.push(m) });
    await b.pullNow();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('作り直');
    expect(applied).toEqual(['p2', 'p3']);
    expect((dbB.prepare('select id from projects order by id').all() as { id: string }[]).map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    expect(b.state.get('snapshotDone')).toBe('1');
    expect(b.state.getNumber('lastSeq', -1)).toBe(3);
    expect(cloudB.calls.filter((c) => c.method === 'snapshot')).toHaveLength(2);
    expect(b.status()).toMatchObject({ state: 'idle', error: null });
    a.stop(); b.stop();
  });

  it('410 の後の写しは最後のページまで読み切ってから差分に戻る', async () => {
    const a = make();
    await a.start();
    project('p1');
    await a.pushNow();
    // Worker の 1 ページの大きさを小さくして、写しが複数ページに割れる状況を作る。
    const paged = cloud.asDevice('b');
    const origSnap = paged.snapshot.bind(paged);
    let pageLimit = 500;
    paged.snapshot = (after) => origSnap(after, pageLimit);
    const b = makeB({ client: paged });
    await b.start();

    for (const id of ['p2', 'p3', 'p4', 'p5']) { project(id); await a.pushNow(); }
    cloud.compact(5);
    pageLimit = 2;
    await b.pullNow();

    // 途中のページで止めて since だけ進めると、ここで p3 以降を永久に取りこぼす。
    expect(paged.calls.filter((c) => c.method === 'snapshot')).toHaveLength(1 + 3);
    expect((dbB.prepare('select id from projects order by id').all() as { id: string }[]).map((r) => r.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(b.state.getNumber('lastSeq', -1)).toBe(5);
    expect(b.status()).toMatchObject({ state: 'idle', error: null });
    a.stop(); b.stop();
  });

  it('写しを読み終える前に更新された行を取りこぼさない', async () => {
    const a = make();
    await a.start();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) project(id);
    await a.pushNow();

    const paged = cloud.asDevice('b');
    const origSnap = paged.snapshot.bind(paged);
    let pages = 0;
    paged.snapshot = async (after) => {
      const page = await origSnap(after, 2);
      pages++;
      // 1 ページ目を返した後に、もう読み終えた鍵（p1）が他端末で更新された。
      // この変更の連番は、最後のページが返す seq より小さい。
      if (pages === 1) {
        await realDelay(2);
        upsertShared(db, 'projects', { ...(db.prepare('select * from projects where id = ?').get('p1') as Record<string, unknown>), name: 'updated' }, 'a');
        await a.pushNow();
      }
      return page;
    };

    const b = makeB({ client: paged });
    await b.start();
    // 最後のページの seq を since にすると、この変更は二度と届かない。
    expect((dbB.prepare('select name from projects where id = ?').get('p1') as { name: string }).name).toBe('updated');
    a.stop(); b.stop();
  });

  it('メモが他端末の新しい版で上書きされるとき、手元の本文を呼び手へ渡す', async () => {
    const conflicts: { projectId: string; markdown: string; deviceName: string }[] = [];
    const a = make();
    await a.start();
    project('p1');
    await a.pushNow();
    const b = makeB({ onMemoConflict: (o: { projectId: string; markdown: string; deviceName: string }) => conflicts.push(o) });
    await b.start();
    upsertShared(dbB, 'devices', { id: 'b', name: 'MacBook', platform: 'darwin' }, 'b');
    upsertShared(dbB, 'project_memos', { project_id: 'p1', markdown: '手元のメモ' }, 'b', 'project_id');
    await realDelay(2);
    upsertShared(db, 'project_memos', { project_id: 'p1', markdown: '相手のメモ' }, 'a', 'project_id');
    await a.pushNow();
    await b.pullNow();
    expect(conflicts).toEqual([{ projectId: 'p1', markdown: '手元のメモ', deviceName: 'MacBook' }]);
    expect((dbB.prepare('select markdown from project_memos where project_id = ?').get('p1') as { markdown: string }).markdown).toBe('相手のメモ');
    a.stop(); b.stop();
  });

  it('pull の要求も無料枠に数える', async () => {
    const b = makeB();
    await b.start();
    // 初回は snapshot 1 回と changes 1 回である。
    expect(b.quota.today().requests).toBe(2);
    await b.pullNow();
    expect(b.quota.today().requests).toBe(3);
    b.stop();
  });

  it('pullBeforeLaunch は 2 秒で諦め、pull 自体は続く', async () => {
    let release: () => void = () => {};
    const slow = cloud.asDevice('b');
    const orig = slow.pullChanges.bind(slow);
    slow.pullChanges = (since, limit) => new Promise((r) => { release = () => { void orig(since, limit).then(r); }; });
    slow.snapshot = async () => ({ changes: [], nextAfter: null, seq: 0 });
    const b = makeB({ client: slow });
    b.state.set('snapshotDone', true);
    const p = b.pullBeforeLaunch(2000);
    await timers.advance(2000);
    expect(await p).toBe(false);
    release();
    await flush();
    expect(b.status().state).toBe('idle');
    const fast = makeB();
    fast.state.set('snapshotDone', true);
    expect(await fast.pullBeforeLaunch(2000)).toBe(true);
    cloudB.offline = true;
    expect(await fast.pullBeforeLaunch(2000)).toBe(false);
    cloudB.offline = false;
  });

  it('onFocus は 5 秒以内の連続では pull しない', async () => {
    const b = makeB();
    await b.start();
    const n = () => cloudB.calls.filter((c) => c.method === 'pullChanges').length;
    const before = n();
    await b.onFocus();
    expect(n()).toBe(before);
    timers.now += 6000;
    await b.onFocus();
    expect(n()).toBe(before + 1);
    b.stop();
  });

  it('pull の失敗は error になり、次の成功で消える', async () => {
    const b = makeB();
    await b.start();
    cloudB.offline = true;
    await b.pullNow();
    expect(b.status()).toMatchObject({ state: 'error' });
    cloudB.offline = false;
    await b.pullNow();
    expect(b.status()).toMatchObject({ state: 'idle', error: null });
    b.stop();
  });
});
