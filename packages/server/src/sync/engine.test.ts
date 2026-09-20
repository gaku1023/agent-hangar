import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { D1_ROWS, FakeCloudClient, MAX_ROW_BYTES } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { CloudError } from './client.ts';
import { SyncEngine } from './engine.ts';
import { QUOTA_STOP_RATIO, QuotaCounter } from './quota.ts';
import { SyncStateStore } from './state.ts';

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;

const make = (over: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) =>
  new SyncEngine({ db, deviceId: 'a', client: cloud, now: () => timers.now, timers, url: 'https://h', ...over });
const unpushed = () => (db.prepare('select count(*) c from changes where pushed_at is null').get() as { c: number }).c;
const project = (id: string, name = id) => upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, 'a');
const pushBatches = () => cloud.calls.filter((c) => c.method === 'pushChanges').map((c) => (c.args[0] as unknown[]).length);

/**
 * Worker が実際に D1 へ書く行数を、要求の外側から数える覆い。
 *
 * 行数の表は偽のクラウドから借りる（`packages/server/test/fake-cloud.ts` の `D1_ROWS`）。
 * ここに数を写し直すと 3 つ目の写しになり、「見積もりどうしを比べているだけ」の試験になる。
 * 表そのものは実物のスキーマと実測に縛られている（`fake-cloud-usage.test.ts`）。
 *
 * - POST /changes … 採った 1 行につき changes の insert と鏡の upsert、要求ごとに devices の 1 行と台帳の 1 文。
 * - GET /changes … devices の 1 行と台帳の 1 文。
 * - GET /rows … 読むだけで 0 行。
 */
function countingD1(c: FakeCloudClient): { readonly rows: number } {
  let rows = 0;
  const push = c.pushChanges.bind(c);
  const pull = c.pullChanges.bind(c);
  c.pushChanges = async (changes) => {
    const r = await push(changes);
    rows += r.accepted * (D1_ROWS.changeInsert + D1_ROWS.mirrorUpsert) + D1_ROWS.deviceTouch + D1_ROWS.note;
    return r;
  };
  c.pullChanges = async (since, limit) => { const r = await pull(since, limit); rows += D1_ROWS.deviceTouch + D1_ROWS.note; return r; };
  return { get rows() { return rows; } };
}

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

  it('無料枠の 80% に達したら自分で一時停止してトーストを出す', async () => {
    const quota = new QuotaCounter({ state: new SyncStateStore(db), now: () => timers.now, limits: { d1Writes: 10, requests: 1_000 } });
    const e = make({ quota });
    await e.start();
    const toasts: { level: string; message: string }[] = [];
    e.on({ toast: (level, message) => toasts.push({ level, message }) });

    for (let i = 0; i < 8; i++) project(`p${i}`);
    await e.pushNow();
    // 8 行の push で 8*5 + devices 1 + 台帳 2、start() の初回 pull で 3。上限 10 の 80% は 8 なので超えている。
    expect(quota.today().rows).toBe(8 * 5 + 1 + 2 + 3);
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

  it('2 台で使っても、アカウント全体で 80% を超える前に両方が止まる', async () => {
    // 無料枠はアカウントごとなので、端末ごとに 80% で止めると 2 台では 160% まで走ってしまう。
    const limits = { d1Writes: 1_000, requests: 1_000_000 };
    const dA = countingD1(cloud);
    const dB = countingD1(cloudB);
    const a = make({ quotaLimits: limits });
    const b = makeB({ quotaLimits: limits });
    await a.start();
    await b.start();

    // 互いの端末を知る（devices の行が両方の DB に入る）。
    upsertShared(db, 'devices', { id: 'a', name: 'A', platform: 'darwin' }, 'a');
    upsertShared(dbB, 'devices', { id: 'b', name: 'B', platform: 'darwin' }, 'b');
    await a.pushNow(); await b.pushNow();
    await a.pullNow(); await b.pullNow();
    expect(a.status().deviceCount).toBe(2);
    expect(b.status().deviceCount).toBe(2);

    let n = 0;
    while ((a.status().state !== 'paused' || b.status().state !== 'paused') && n < 2_000) {
      if (a.status().state !== 'paused') project(`a${n}`);
      if (b.status().state !== 'paused') upsertShared(dbB, 'projects', { id: `b${n}`, name: `b${n}`, status: 'active', is_scratch: 0 }, 'b');
      n++;
      await timers.advance(2_000);
    }
    expect(a.status().state).toBe('paused');
    expect(b.status().state).toBe('paused');
    // 2 台ぶんを足しても、アカウントの枠そのものは超えない。
    expect(dA.rows + dB.rows).toBeLessThan(limits.d1Writes);
    expect(dA.rows + dB.rows).toBeGreaterThanOrEqual(limits.d1Writes * QUOTA_STOP_RATIO);
    a.stop(); b.stop();
  });

  it('セッションのメモが他端末の新しい版で消えるとき、控えの知らせを呼び手へ渡す', async () => {
    const saved = process.env.HANGAR_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-engine-'));
    process.env.HANGAR_HOME = home;
    try {
      const backups: { sessionId: string; markdown: string; deviceName: string; backupFile: string }[] = [];
      const a = make();
      await a.start();
      upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'a' }, 'a');
      await a.pushNow();

      const b = makeB({ onSessionMemoBackup: (o) => backups.push(o) });
      await b.start();
      upsertShared(dbB, 'devices', { id: 'b', name: 'MacBook', platform: 'darwin' }, 'b');
      const localRow = dbB.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>;
      upsertShared(dbB, 'sessions', { ...localRow, memo: '手元のメモ' }, 'b');

      // 相手がメモを消しにくる。消える側なので、控えを残してから上書きする。
      await realDelay(2);
      const remoteRow = db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>;
      upsertShared(db, 'sessions', { ...remoteRow, memo: null }, 'a');
      await a.pushNow();
      await b.pullNow();

      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatchObject({ sessionId: 's1', markdown: '手元のメモ', deviceName: 'MacBook' });
      expect(path.basename(backups[0]!.backupFile)).toMatch(/^session-s1-\d{8}-\d{6}\.md$/);
      expect(fs.readFileSync(backups[0]!.backupFile, 'utf8')).toBe('手元のメモ');
      expect((dbB.prepare('select memo from sessions where id = ?').get('s1') as { memo: string | null }).memo).toBeNull();
      a.stop(); b.stop();
    } finally {
      if (saved === undefined) delete process.env.HANGAR_HOME; else process.env.HANGAR_HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
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

describe('SyncEngine の無料枠の見張り', () => {
  it('数えが Worker の実際の D1 書き込みと一致する', async () => {
    const d1 = countingD1(cloud);
    const e = make();
    await e.start();
    for (let i = 0; i < 50; i++) project(`p${i}`);
    await e.pushNow();
    await e.pullNow();
    // 50 行は 40 と 10 の 2 バッチに割れる。pull は start() の初回と明示の pullNow の 2 回である。
    const perRow = D1_ROWS.changeInsert + D1_ROWS.mirrorUpsert;
    expect(d1.rows).toBe(40 * perRow + 1 + D1_ROWS.note + (10 * perRow + 1 + D1_ROWS.note) + 2 * (1 + D1_ROWS.note));
    // 見張りが見る数は、Worker が実際に書いた行数そのものである（Worker の報告をそのまま採る）。
    expect(e.quota.d1().rows).toBe(d1.rows);
    expect(e.quota.d1().authoritative).toBe(true);
    // 手元の見積もりも、この端末が起こした書き込みは 1 行残らず数えている。
    // 圧縮も参加も他端末も無いこの筋では、報告と一致する（2026-09-20 に定数を直すまでは 2 割少なかった）。
    expect(e.quota.today().rows).toBe(d1.rows);
    e.stop();
  });

  it('Worker が同着で弾いた行は、書き込みとして数えない', async () => {
    const d1 = countingD1(cloud);
    const e = make();
    await e.start();
    project('p1');
    await e.pushNow();
    const after = e.quota.today().rows;
    // 同じ行を同じ updated_at のまま送り直すと、Worker は skipped にして 1 行も書かない。
    db.prepare('update changes set pushed_at = null').run();
    await e.pushNow();
    expect(e.quota.today().rows).toBe(after + 3);   // devices の 1 行と台帳の 2 行だけ
    expect(e.quota.d1().rows).toBe(d1.rows);
    e.stop();
  });

  it('実際の D1 書き込みが無料枠の 80% を超える前に止まる', async () => {
    const limits = { d1Writes: 1_000, requests: 1_000_000 };
    const d1 = countingD1(cloud);
    const quota = new QuotaCounter({ state: new SyncStateStore(db), now: () => timers.now, limits });
    const e = make({ quota });
    await e.start();
    let n = 0;
    // 索引器と同じ刻みで共有テーブルを書き続ける。
    while (e.status().state !== 'paused' && n < 3_000) { project(`p${n++}`); await timers.advance(2_000); }
    expect(e.status().state).toBe('paused');
    // 止まった時点で、実際の書き込みは 80%（800 行）の前後に収まっていなければならない。
    // 1 バッチ（40 行 = 81 行の書き込み）の行き過ぎまでは避けられないが、枠の 1000 は超えない。
    expect(d1.rows).toBeGreaterThanOrEqual(limits.d1Writes * 0.8);
    expect(d1.rows).toBeLessThan(limits.d1Writes);
    expect(quota.d1().rows).toBe(d1.rows);
    e.stop();
  });

  it('pull の 1 要求も devices の 1 行と台帳の 2 行として数える', async () => {
    const e = make();
    await e.start();
    const before = e.quota.today().rows;
    await e.pullNow();
    expect(e.quota.today().rows).toBe(before + 3);
    e.stop();
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
