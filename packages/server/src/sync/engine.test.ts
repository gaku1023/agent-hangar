import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { getSessionNote, setSessionMemo, setSessionName } from '../sessions/notes.ts';
import { FakeCloudClient, MAX_ROW_BYTES } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { COMPAT_VERSION } from '@agent-hangar/shared';
import { CloudError, LimitError, MIN_WORKER_COMPAT } from './client.ts';
import { limitedMessage, limitedWhilePausedMessage, SyncEngine } from './engine.ts';

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;

const make = <E extends SyncEngine = SyncEngine>(over: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}, Engine: new (deps: ConstructorParameters<typeof SyncEngine>[0]) => E = SyncEngine as never): E =>
  new Engine({ db, deviceId: 'a', client: cloud, now: () => timers.now, timers, url: 'https://h', ...over });
/** protected な failPush と failPull を、並行する push と pull の断りに見立てて直接呼ぶ試験用の派生。 */
class Probe extends SyncEngine {
  refusePush(): void { this.failPush(new LimitError('d1-write', 429)); }
  refusePull(): void { this.failPull(new LimitError('requests', 429)); }
}
const unpushed = () => (db.prepare('select count(*) c from changes where pushed_at is null').get() as { c: number }).c;
const project = (id: string, name = id) => upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, 'a');
const pushBatches = () => cloud.calls.filter((c) => c.method === 'pushChanges').map((c) => (c.args[0] as unknown[]).length);

/** Worker が 413 で断る相手を作る。名指しは先頭の 1 件だけで、本文は 200 字に収まる。 */
const rejectOversize = (c: FakeCloudClient, tooBig: (rowId: string) => boolean, bytes = 200_000): void => {
  const push = c.pushChanges.bind(c);
  c.pushChanges = async (changes) => {
    const bad = changes.find((x) => tooBig(x.rowId));
    if (!bad) return push(changes);
    throw new CloudError(413, JSON.stringify({ error: 'payload too large', limit: 131_072, count: 1, row: { tableName: bad.tableName, rowId: bad.rowId, bytes } }));
  };
};

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

  it('一時停止中でも、利用者の syncNow は 1 回だけ送受信して、停止に戻る', async () => {
    const e = make();
    await e.start();
    e.setPaused(true);
    project('p1');
    const pullsBefore = cloud.calls.filter((c) => c.method === 'pullChanges').length;
    await e.syncNow({ evenIfPaused: true });
    expect(unpushed()).toBe(0);
    expect(cloud.calls.filter((c) => c.method === 'pullChanges').length).toBeGreaterThan(pullsBefore);
    // 止めた状態はそのまま残る。
    expect(e.status()).toMatchObject({ state: 'paused', limitedUntil: null });
    // 1 回きりである。その後の書き込みと定期実行は、今までどおり外へ出ない。
    project('p2');
    await timers.advance(120_000);
    await e.idle();
    expect(unpushed()).toBe(1);
    e.stop();
  });

  it('一時停止中の syncNow は、頼まれなければ今までどおり何もしない', async () => {
    const e = make();
    await e.start();
    e.setPaused(true);
    project('p1');
    await e.syncNow();
    expect(unpushed()).toBe(1);
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
    await e.idle();
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

  it('クラウドが応答しないとき、stop の後は要求を 1 件も出さない', async () => {
    // 要求は「出した時点」で数える。偽クラウドの calls は応答を返した時点に積まれるので、
    // 届かないまま止まっている回を数えられない。
    let issued = 0;
    const waiting: (() => void)[] = [];
    let answering = false;
    const realSnapshot = cloud.snapshot.bind(cloud);
    const realPush = cloud.pushChanges.bind(cloud);
    const realPull = cloud.pullChanges.bind(cloud);
    cloud.snapshot = ((after: string | null, limit: number) => { issued++; return realSnapshot(after, limit); }) as typeof cloud.snapshot;
    cloud.pushChanges = ((batch: Parameters<typeof realPush>[0]) => { issued++; return realPush(batch); }) as typeof cloud.pushChanges;
    // pull だけを止めて、応答が定期実行の周期より遅い状況を作る。
    // クラウドへ届かないときは応答も 30 秒待ちなので、鎖は減るより速く伸びる。
    cloud.pullChanges = ((since: number, limit: number) => {
      issued++;
      if (answering) return realPull(since, limit);
      return new Promise((resolve, reject) => { waiting.push(() => { realPull(since, limit).then(resolve, reject); }); });
    }) as typeof cloud.pullChanges;

    const e = make();
    const startup = e.start();
    // 応答が返らないあいだに、定期実行を 5 回ぶん鎖へ積む。
    for (let i = 0; i < 5; i++) await timers.advance(30_000);
    expect(issued).toBeGreaterThan(0);

    e.stop();
    const afterStop = issued;

    // 止めた後で応答を返し、鎖が捌けるまで待つ。
    answering = true;
    for (const w of waiting.splice(0)) w();
    await startup;
    await e.idle();

    // 止めたら止まる。鎖に並んだ tick は先頭の検査で譲るので、追加の要求は 0 件である。
    expect(issued - afterStop).toBe(0);
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
    // タイマーから始まる push と pull は誰も約束を持たないので、段ごとに idle() で待ち合わせる。
    // マイクロタスクの回数で待つと、非同期の終わる回が端末ごとに変わるぶん取りこぼす。
    await timers.advance(10_000);
    await a.idle();
    await timers.advance(20_000);
    await b.idle();
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
    expect(toasts[0]).toContain('再同期');
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

  it('別の PC で付けた名前とメモは、本文を持つ PC が sessions の行を書き直しても消えない', async () => {
    // a は本文を持つ PC で、索引が sessions の行を書き直す。b は名前とメモを付ける PC である。
    const a = make();
    await a.start();
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'a' }, 'a');
    await a.pushNow();
    const b = makeB();
    await b.start();
    await b.pullNow();
    setSessionName(dbB, 'b', 's1', 'b で付けた名前');
    setSessionMemo(dbB, 'b', 's1', 'b で書いたメモ');
    await b.pushNow();

    // a は b の行を受ける前に、手元の古い行に本文の伸びを重ねて書く（索引がしていること）。
    await realDelay(2);
    const row = db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>;
    upsertShared(db, 'sessions', { ...row, last_activity_at: 999 }, 'a');
    await a.pushNow();
    await a.pullNow();
    await b.pullNow();

    // どちらの PC でも、名前とメモは残り、本文の伸びも届いている。
    for (const d of [db, dbB]) {
      expect(getSessionNote(d, 's1')).toEqual({ name: 'b で付けた名前', memo: 'b で書いたメモ' });
      expect((d.prepare('select last_activity_at l from sessions where id = ?').get('s1') as { l: number }).l).toBe(999);
    }
    // sessions の payload は、名前とメモを運ばない。
    for (const c of cloud.changes.filter((x) => x.tableName === 'sessions')) {
      expect(Object.keys(c.payload)).not.toContain('name');
      expect(Object.keys(c.payload)).not.toContain('memo');
    }
    a.stop(); b.stop();
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
    await b.idle();
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

describe('SyncEngine の失敗の見せ方', () => {
  it('push が落ち続けている間は、pull が通っても error のままになる', async () => {
    const e = make();
    await e.start();
    cloud.pushChanges = async () => { throw new CloudError(400, '{"error":"invalid body"}'); };
    project('p1');
    await timers.advance(1_000);
    await e.idle();
    expect(e.status()).toMatchObject({ state: 'error', pending: 1 });

    // 定期実行は push の後に pull を回す。pull は通るが、送れていない事実は消えない。
    await timers.advance(5 * 60_000);
    await e.idle();
    expect(e.status()).toMatchObject({ state: 'error', pending: 1 });
    expect(e.status().error).toContain('invalid body');
    expect(e.state.get('lastError')).toContain('invalid body');
    expect(e.status().lastPullAt).not.toBeNull();

    // 直れば消える。
    cloud.pushChanges = FakeCloudClient.prototype.pushChanges.bind(cloud);
    await e.pushNow();
    expect(e.status()).toMatchObject({ state: 'idle', error: null, pending: 0 });
    e.stop();
  });

  it('pull が落ちている間は、push が通っても error のままになる', async () => {
    const e = make();
    await e.start();
    cloud.pullChanges = async () => { throw new CloudError(500, 'boom'); };
    await e.pullNow();
    expect(e.status().state).toBe('error');
    project('p1');
    await timers.advance(1_000);
    expect(unpushed()).toBe(0);
    expect(e.status()).toMatchObject({ state: 'error' });
    expect(e.status().error).toContain('boom');
    e.stop();
  });

  it('送るものが無くなれば push の失敗は消える', async () => {
    const e = make();
    await e.start();
    cloud.pushChanges = async () => { throw new CloudError(400, '{"error":"invalid body"}'); };
    project('p1');
    await timers.advance(1_000);
    expect(e.status().state).toBe('error');
    // 行が消えれば（7 日の掃除や諦めの後）、送れていないものは無い。
    db.prepare('update changes set pushed_at = ?').run(timers.now);
    await e.pushNow();
    expect(e.status()).toMatchObject({ state: 'idle', error: null });
    e.stop();
  });
});

describe('SyncEngine の 413（大きすぎる行）', () => {
  it('名指しされた行を諦めて先へ進み、1 度だけ知らせる', async () => {
    const e = make();
    await e.start();
    const toasts: { level: string; message: string }[] = [];
    e.on({ toast: (level, message) => toasts.push({ level, message }) });
    project('p1'); project('big'); project('p2');
    rejectOversize(cloud, (id) => id === 'big');

    await e.pushNow();
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
    expect(unpushed()).toBe(0);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.level).toBe('error');
    expect(toasts[0]?.message).toContain('big');
    expect(toasts[0]?.message).toMatch(/他の PC には届きません$/);
    expect(e.status()).toMatchObject({ state: 'idle', error: null });

    // 同じ行がまた大きいまま書き直されても、知らせるのは 1 度だけである。
    project('big');
    await e.pushNow();
    expect(unpushed()).toBe(0);
    expect(toasts).toHaveLength(1);
    e.stop();
  });

  it('偽クラウドの実物の上限でも、大きすぎるメモだけが諦められて残りは届く', async () => {
    // ここだけは 413 を手で組み立てず、偽クラウドに実物の上限（128 KiB）で断らせる。
    // 手で組み立てた本文とずれていれば、この 1 件だけが落ちる。
    const e = make();
    await e.start();
    const toasts: { level: string; message: string }[] = [];
    e.on({ toast: (level, message) => toasts.push({ level, message }) });

    project('p1'); project('p2');
    // 日本語は 1 文字 3 バイトなので、これで確実に上限を超える。
    const huge = 'あ'.repeat(MAX_ROW_BYTES / 2);
    upsertShared(db, 'project_memos', { project_id: 'p1', markdown: huge }, 'a', 'project_id');
    expect(unpushed()).toBe(3);

    await e.pushNow();

    // 大きすぎる 1 行だけが落ち、同じ塊にいた 2 行は普通に届く。
    expect(cloud.changes.map((c) => `${c.tableName}:${c.rowId}`)).toEqual(['projects:p1', 'projects:p2']);
    expect(unpushed()).toBe(0);
    expect(e.status()).toMatchObject({ state: 'idle', error: null });

    // 諦めたことは 1 度だけ知らせる。上限は Worker の 128 KiB のまま伝える。
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.level).toBe('error');
    expect(toasts[0]?.message).toContain('project_memos');
    expect(toasts[0]?.message).toContain('上限 128 KiB');
    // 知らせに本文そのものを混ぜない。
    expect(toasts[0]?.message).not.toContain('ああ');

    // 手元の本文は消えていない。届かないだけである。
    expect((db.prepare('select markdown from project_memos where project_id = ?').get('p1') as { markdown: string }).markdown).toBe(huge);
    e.stop();
  });

  it('413 の名指しが手元に無ければ、その push を止める（永久に送り直さない）', async () => {
    const e = make();
    await e.start();
    project('p1');
    let calls = 0;
    cloud.pushChanges = async () => {
      calls++;
      throw new CloudError(413, JSON.stringify({ error: 'payload too large', limit: 131_072, count: 1, row: { tableName: 'projects', rowId: 'knows-nothing', bytes: 200_000 } }));
    };
    await e.pushNow();
    expect(calls).toBe(1);
    expect(unpushed()).toBe(1);
    expect(e.status().state).toBe('error');
    e.stop();
  });

  it('413 を繰り返す相手でも、10 分で諦めて push が止まらない', async () => {
    const e = make();
    await e.start();
    rejectOversize(cloud, (id) => id.startsWith('big'));
    project('big1'); project('big2'); project('p1');
    await timers.advance(10 * 60_000);
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1']);
    expect(unpushed()).toBe(0);
    e.stop();
  });
});

describe('SyncEngine の文の言語', () => {
  it('language を渡すと、失敗の理由と知らせをその言語で出す。失敗の理由は出した時点の言語のまま残る', async () => {
    let language: 'ja' | 'en' = 'en';
    const e = make({ language: () => language });
    await e.start();
    const toasts: string[] = [];
    e.on({ toast: (_l, m) => toasts.push(m) });
    // 大きすぎる行の知らせ
    project('big');
    rejectOversize(cloud, (id) => id === 'big');
    await e.pushNow();
    expect(toasts).toEqual(["One row of projects (big) is too large to sync (195 KiB, limit 128 KiB). It stays on this computer but will not reach other computers"]);
    // 互換の版の失敗の理由
    cloud.minDeviceCompat = COMPAT_VERSION + 1;
    project('p1');
    await timers.advance(1_000);
    await e.idle();
    expect(e.status().error).toContain("This computer's hangar is out of date");
    language = 'ja';
    expect(e.status().error).toContain("This computer's hangar is out of date");
  });
});

describe('互換の版', () => {
  /** Worker の下限を上げて、書き込みの push を断らせる。push で止まった状態を作る。 */
  const blockOnPush = async (e: SyncEngine): Promise<void> => {
    cloud.minDeviceCompat = COMPAT_VERSION + 1;
    project('p1');
    await timers.advance(1_000);
    await e.idle();
  };

  it('Worker に断られたら（426）同期を止め、この PC の hangar を上げるよう error に出す', async () => {
    const e = make();
    await e.start();
    await blockOnPush(e);
    expect(e.compatBlocked()).toBe(true);
    expect(e.status()).toMatchObject({ state: 'error', pending: 1 });
    expect(e.status().error).toContain('この PC の hangar');
    expect(e.status().paused).toBe(false);
    // 止めた後は、書き込みも定期実行も外へ出ない。
    const calls = cloud.calls.length;
    project('p2');
    await timers.advance(5 * 60_000);
    await e.idle();
    expect(cloud.calls.length).toBe(calls);
    expect(unpushed()).toBe(2);
    e.stop();
  });

  it('Worker の版がこの PC の下限より古ければ同期を止め、Worker を上げるよう error に出す', async () => {
    cloud = new FakeCloudClient({ deviceId: 'a', minWorkerCompat: COMPAT_VERSION });
    cloud.workerCompat = COMPAT_VERSION - 1;
    const e = make();
    await e.start();
    expect(e.compatBlocked()).toBe(true);
    expect(e.status().state).toBe('error');
    expect(e.status().error).toContain('Worker');
    expect(e.status().error).toContain('今すぐ同期');
    e.stop();
  });

  it('版の見出しを返さない古い Worker（版 0）は、この PC の下限 2 で断り、Worker を上げるよう error に出す', async () => {
    expect(MIN_WORKER_COMPAT).toBe(2);
    cloud.workerCompat = 0;
    const e = make();
    await e.start();
    project('p1');
    await timers.advance(1_000);
    await e.idle();
    expect(cloud.changes).toEqual([]);
    expect(e.compatBlocked()).toBe(true);
    expect(e.status().state).toBe('error');
    expect(e.status().error).toContain('Worker');
    e.stop();
  });

  it('止まった後も、利用者の今すぐ同期は 1 度だけ試し直し、直っていれば戻る', async () => {
    const e = make();
    await e.start();
    await blockOnPush(e);
    // まだ合わなければ、試し直しても止まったまま。
    const before = cloud.calls.length;
    await e.syncNow();
    // 試すのは push の 1 回だけで、断られた後の pull は外へ出ない。
    expect(cloud.calls.slice(before).map((c) => c.method)).toEqual(['pushChanges']);
    expect(e.compatBlocked()).toBe(true);
    // Worker の側が合えば、次の今すぐ同期で戻る。
    cloud.minDeviceCompat = 0;
    await e.syncNow();
    expect(e.compatBlocked()).toBe(false);
    expect(e.status()).toMatchObject({ state: 'idle', error: null, pending: 0 });
    e.stop();
  });

  it('push で止まった後の起動前の pull は、外へ出ずに false を返す', async () => {
    const e = make();
    await e.start();
    await blockOnPush(e);
    const before = cloud.calls.length;
    expect(await e.pullBeforeLaunch()).toBe(false);
    expect(cloud.calls.length).toBe(before);
    e.stop();
  });

  it('止めた印は DB に残さない。立て直したら最初の要求でまた確かめる', async () => {
    const e = make();
    await e.start();
    await blockOnPush(e);
    e.stop();
    // この PC の hangar を入れ替えて立て直した筋（相手とも版が合っている）。
    cloud.minDeviceCompat = 0;
    const e2 = make();
    expect(e2.compatBlocked()).toBe(false);
    await e2.start();
    expect(e2.status()).toMatchObject({ state: 'idle', error: null, pending: 0 });
    e2.stop();
  });

  it('一時停止していても、版で止まったことを error で見せる', async () => {
    const e = make();
    await e.start();
    e.setPaused(true);
    cloud.minDeviceCompat = COMPAT_VERSION + 1;
    project('p1');
    await e.syncNow({ evenIfPaused: true });
    expect(e.status().state).toBe('error');
    expect(e.status().error).toContain('この PC の hangar');
    expect(e.status().limitedUntil).toBeNull();
    // 状態は error でも、一時停止していることは印で伝える。画面はこれで一時停止中と添え、切り替えを隠す。
    expect(e.status().paused).toBe(true);
    e.stop();
  });

  it('一時停止のまま何も送らない今すぐ同期では、止めた印を外さない', async () => {
    const e = make();
    await e.start();
    e.setPaused(true);
    cloud.minDeviceCompat = COMPAT_VERSION + 1;
    project('p1');
    await e.syncNow({ evenIfPaused: true });
    expect(e.compatBlocked()).toBe(true);
    // 一時停止の 1 巡でない今すぐ同期は何も送らないので、表示だけが一時停止に戻ることはない。
    await e.syncNow();
    expect(e.compatBlocked()).toBe(true);
    expect(e.status().state).toBe('error');
    e.stop();
  });
});

describe('上限で退く', () => {
  /** UTC の 0 時の 1 分前に時計を合わせる。日をまたぐのを 2 分で試せる。戻る時刻を返す。 */
  const beforeMidnight = (): number => {
    timers.now = Date.UTC(2026, 9, 8, 23, 59, 0);
    return Date.UTC(2026, 9, 9);
  };
  /** 上限に当てたまま書き込みを 1 つ送らせ、退いた状態を作る。 */
  const hitLimit = async (e: SyncEngine, kind: 'd1-write' | 'requests' = 'd1-write'): Promise<void> => {
    cloud.limited = kind;
    project('p1');
    await timers.advance(1_000);
    await e.idle();
  };

  it('知らせの文は、戻る時刻を渡した時間帯の時刻で書く', () => {
    expect(limitedMessage(Date.UTC(2026, 9, 9), 'Asia/Tokyo')).toBe('Cloudflare の無料枠の上限に達したので、9:00 まで同期を停止します。枠がリセットされると自動で再開します');
    expect(limitedMessage(Date.UTC(2026, 9, 9), 'UTC')).toBe('Cloudflare の無料枠の上限に達したので、0:00 まで同期を停止します。枠がリセットされると自動で再開します');
  });

  it('上限の失敗を受けたら、次の UTC の 0 時まで外へ出ず、戻る時刻を見せ、1 度だけ知らせる', async () => {
    const midnight = beforeMidnight();
    const toasts: string[] = [];
    const e = make();
    e.on({ toast: (_l, m) => toasts.push(m) });
    await e.start();
    await hitLimit(e);
    expect(e.limitedUntil()).toBe(midnight);
    expect(e.status()).toMatchObject({ state: 'paused', limitedUntil: midnight, error: null, pending: 1 });
    expect(toasts).toEqual([limitedMessage(midnight)]);
    // 退いている間は、書き込みも定期実行も起動前の pull も外へ出ない。
    const calls = cloud.calls.length;
    project('p2');
    await timers.advance(30_000);
    await e.idle();
    expect(cloud.calls.length).toBe(calls);
    expect(await e.pullBeforeLaunch()).toBe(false);
    expect(cloud.calls.length).toBe(calls);
    e.stop();
  });

  it('日が変われば次の定期実行で自分で戻り、溜まった変更を送る', async () => {
    const midnight = beforeMidnight();
    const e = make();
    await e.start();
    await hitLimit(e, 'requests');
    expect(e.limitedUntil()).toBe(midnight);
    cloud.limited = null;
    await timers.advance(120_000);
    await e.idle();
    expect(e.limitedUntil()).toBeNull();
    expect(e.status()).toMatchObject({ state: 'idle', limitedUntil: null, error: null, pending: 0 });
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1']);
    e.stop();
  });

  it('日が変わって猶予を過ぎてもまだ断られたら、また次の 0 時まで退き、もう 1 度知らせる', async () => {
    const midnight = beforeMidnight();
    const toasts: string[] = [];
    const e = make();
    e.on({ toast: (_l, m) => toasts.push(m) });
    await e.start();
    await hitLimit(e);
    // 0 時から 10 分の間は短く黙って退くので、その外まで進める。
    await timers.advance(12 * 60_000);
    await e.idle();
    expect(e.limitedUntil()).toBe(midnight + 86_400_000);
    expect(toasts).toHaveLength(2);
    e.stop();
  });

  it('利用者の今すぐ同期は 1 度だけ試し直し、まだ断られれば退いたまま知らせ直し、通れば戻る', async () => {
    beforeMidnight();
    const toasts: string[] = [];
    const e = make();
    e.on({ toast: (_l, m) => toasts.push(m) });
    await e.start();
    await hitLimit(e);
    expect(toasts).toHaveLength(1);
    const before = cloud.calls.length;
    await e.syncNow();
    // 試すのは push の 1 回だけで、断られた後の pull は外へ出ない。
    expect(cloud.calls.slice(before).map((c) => c.method)).toEqual(['pushChanges']);
    expect(e.limitedUntil()).not.toBeNull();
    // まだ断られたので、また戻る時刻まで退いたことを知らせる（Task 1 の Q4）。
    expect(toasts).toHaveLength(2);
    cloud.limited = null;
    await e.syncNow();
    expect(e.limitedUntil()).toBeNull();
    expect(e.status()).toMatchObject({ state: 'idle', pending: 0 });
    e.stop();
  });

  it('止めていないときの今すぐ同期は、ふだんの文のままである', async () => {
    const midnight = beforeMidnight();
    const toasts: string[] = [];
    const e = make();
    e.on({ toast: (_l, m) => toasts.push(m) });
    await e.start();
    project('p1');
    cloud.limited = 'd1-write';
    await e.syncNow();
    expect(toasts).toEqual([limitedMessage(midnight)]);
    e.stop();
  });

  it('利用者が一時停止している間は一時停止として見せ、再開すると戻る時刻まで退いたことを見せる', async () => {
    const midnight = beforeMidnight();
    const e = make();
    await e.start();
    await hitLimit(e);
    e.setPaused(true);
    expect(e.status()).toMatchObject({ state: 'paused', limitedUntil: null });
    const calls = cloud.calls.length;
    e.setPaused(false);
    await e.idle();
    expect(cloud.calls.length).toBe(calls);
    expect(e.status()).toMatchObject({ state: 'paused', limitedUntil: midnight });
    e.stop();
  });

  describe('利用者が一時停止している間に頼んだ 1 巡', () => {
    it('上限で断られたら、時刻を入れない文を 1 件だけ知らせる', async () => {
      beforeMidnight();
      const toasts: string[] = [];
      const e = make();
      e.on({ toast: (_l, m) => toasts.push(m) });
      await e.start();
      e.setPaused(true);
      project('p1');
      cloud.limited = 'd1-write';
      await e.syncNow({ evenIfPaused: true });
      expect(toasts).toEqual(['Cloudflare の無料枠の上限に達したので、同期できませんでした。同期は一時停止のままです']);
      expect(toasts[0]).toBe(limitedWhilePausedMessage());
      expect(toasts.join('')).not.toContain('自動で再開します');
      expect(toasts.join('')).not.toMatch(/\d:\d\d/);
      e.stop();
    });

    it('0 時の直後の猶予の間に断られたら、一時停止中でも黙って退く', async () => {
      const midnight = Date.UTC(2026, 9, 9);
      timers.now = midnight + 4_000;
      const toasts: string[] = [];
      const e = make();
      e.on({ toast: (_l, m) => toasts.push(m) });
      await e.start();
      e.setPaused(true);
      project('p1');
      cloud.limited = 'd1-write';
      await e.syncNow({ evenIfPaused: true });
      expect(toasts).toEqual([]);
      e.stop();
    });
  });

  describe('日付の境目の猶予', () => {
    const MIN = 60_000;
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warn.mockRestore(); });

    it('UTC の 0 時の 5 秒後に断られたら 5 分だけ黙って退き、5 分後に通れば戻る', async () => {
      const midnight = Date.UTC(2026, 9, 9);
      timers.now = midnight + 4_000;
      const toasts: string[] = [];
      const e = make();
      e.on({ toast: (_l, m) => toasts.push(m) });
      await e.start();
      await hitLimit(e);
      expect(e.limitedUntil()).toBe(midnight + 5_000 + 5 * MIN);
      expect(e.status()).toMatchObject({ state: 'paused', limitedUntil: midnight + 5_000 + 5 * MIN, error: null, pending: 1 });
      expect(toasts).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      // 退いている間は外へ出ない。
      const calls = cloud.calls.length;
      await timers.advance(4 * MIN);
      await e.idle();
      expect(cloud.calls.length).toBe(calls);
      // 5 分を過ぎた後の定期実行で通れば戻り、溜まった変更を送る。
      cloud.limited = null;
      await timers.advance(2 * MIN);
      await e.idle();
      expect(e.limitedUntil()).toBeNull();
      expect(e.status()).toMatchObject({ state: 'idle', limitedUntil: null, error: null, pending: 0 });
      expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1']);
      expect(toasts).toEqual([]);
      e.stop();
    });

    it('猶予の間は断られるたびに 5 分ずつ黙って退き、猶予の外で断られたら次の 0 時まで退いて 1 度だけ知らせる', async () => {
      const midnight = Date.UTC(2026, 9, 9);
      timers.now = midnight + 4_000;
      const toasts: string[] = [];
      const e = make();
      e.on({ toast: (_l, m) => toasts.push(m) });
      await e.start();
      await hitLimit(e);
      expect(e.limitedUntil()).toBe(midnight + 5_000 + 5 * MIN);
      // 0:05:05 の後の定期実行でまた断られても、まだ猶予の間なので黙って 5 分退く。
      await timers.advance(6 * MIN);
      await e.idle();
      const second = e.limitedUntil();
      expect(second).not.toBeNull();
      expect(second! - midnight).toBeGreaterThan(5 * MIN);
      expect(second! - midnight).toBeLessThanOrEqual(15 * MIN);
      expect(toasts).toEqual([]);
      // 猶予の外で断られたら、次の 0 時まで退いて知らせる。
      await timers.advance(10 * MIN);
      await e.idle();
      expect(e.limitedUntil()).toBe(midnight + 86_400_000);
      expect(toasts).toEqual([limitedMessage(midnight + 86_400_000)]);
      expect(warn).toHaveBeenCalledTimes(1);
      e.stop();
    });

    it('猶予の外（0 時 20 分）に断られたら、次の 0 時まで退いて 1 度だけ知らせる', async () => {
      const next = Date.UTC(2026, 9, 10);
      timers.now = Date.UTC(2026, 9, 9, 0, 19, 59);
      const toasts: string[] = [];
      const e = make();
      e.on({ toast: (_l, m) => toasts.push(m) });
      await e.start();
      await hitLimit(e);
      expect(e.limitedUntil()).toBe(next);
      expect(toasts).toEqual([limitedMessage(next)]);
      expect(warn).toHaveBeenCalledTimes(1);
      e.stop();
    });

    it('短い退きの印が生きているうちに猶予の外で断られたら、1 日の退きへ移って 1 度だけ知らせる', async () => {
      const midnight = Date.UTC(2026, 9, 9);
      timers.now = midnight + 9 * MIN;
      const toasts: string[] = [];
      const e = make({}, Probe);
      e.on({ toast: (_l, m) => toasts.push(m) });
      // 0:09 の断りは猶予の中なので、0:14 までの短い印が黙って立つ。
      e.refusePush();
      expect(e.limitedUntil()).toBe(midnight + 14 * MIN);
      expect(toasts).toEqual([]);
      // 印が生きているまま 0:11 になり、別の要求（飛んでいた pull）が断られる。
      timers.now = midnight + 11 * MIN;
      expect(e.limitedUntil()).toBe(midnight + 14 * MIN);
      e.refusePull();
      expect(e.limitedUntil()).toBe(midnight + 86_400_000);
      expect(toasts).toEqual([limitedMessage(midnight + 86_400_000)]);
      // 同じ 1 日の退きの間にもう 1 度断られても、知らせは増えない。
      timers.now = midnight + 12 * MIN;
      e.refusePush();
      expect(e.limitedUntil()).toBe(midnight + 86_400_000);
      expect(toasts).toHaveLength(1);
    });

    it('0 時の直前に送った要求が 0 時をまたいで断られても、短く黙って退く', async () => {
      const midnight = Date.UTC(2026, 9, 9);
      timers.now = midnight - 2_000;
      const toasts: string[] = [];
      const e = make();
      e.on({ toast: (_l, m) => toasts.push(m) });
      await e.start();
      // 23:59:59 に出した push の答えが、0:00:01 に上限の失敗として返る。
      let refuse: (err: unknown) => void = () => {};
      cloud.pushChanges = () => new Promise((_res, rej) => { refuse = rej; });
      project('p1');
      await timers.advance(1_000);
      expect(timers.now).toBe(midnight - 1_000);
      timers.now = midnight + 1_000;
      refuse(new LimitError('d1-write', 429));
      await e.idle();
      expect(e.limitedUntil()).toBe(midnight + 1_000 + 5 * MIN);
      expect(toasts).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      e.stop();
    });

    it('利用者の今すぐ同期が猶予の間に断られても、短く黙って退く', async () => {
      const midnight = beforeMidnight();
      const toasts: string[] = [];
      const e = make();
      e.on({ toast: (_l, m) => toasts.push(m) });
      await e.start();
      await hitLimit(e);
      expect(toasts).toHaveLength(1);
      // 次の 0 時まで退いている間に 0 時を過ぎ、0:00:30 より前に利用者が押す。
      timers.now = midnight + 20_000;
      await e.syncNow();
      expect(e.limitedUntil()).toBe(midnight + 20_000 + 5 * MIN);
      expect(toasts).toHaveLength(1);
      e.stop();
    });
  });

  it('上限でない失敗（500）では退かず、error を出す', async () => {
    const e = make();
    await e.start();
    cloud.pushChanges = async () => { throw new CloudError(500, '{"error":"internal error"}'); };
    project('p1');
    await timers.advance(1_000);
    await e.idle();
    expect(e.limitedUntil()).toBeNull();
    expect(e.status()).toMatchObject({ state: 'error', error: '{"error":"internal error"}', limitedUntil: null });
    e.stop();
  });
});
