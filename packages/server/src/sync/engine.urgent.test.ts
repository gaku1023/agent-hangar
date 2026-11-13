import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { SyncEngine } from './engine.ts';

/** 急ぐ変更（run の出入りと新しい会話）は最小間隔を待たずに、呼び鈴の印つきで push される。 */

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
/** push ごとの印（ring）。 */
let rings: boolean[];

const make = (): SyncEngine => {
  const e = new SyncEngine({ db, deviceId: 'a', client: cloud, now: () => timers.now, timers, url: 'https://h' });
  timers.settleWith(() => e.idle());
  return e;
};

const session = (id: string, extra: Record<string, unknown> = {}) =>
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `ps-${id}`, cwd: '/w', home_device: 'a', ...extra }, 'a');
const run = (id: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  upsertShared(db, 'runs', { id, session_id: sessionId, device_id: 'a', kind: 'start', tmux_name: `t-${id}`, pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: 1, ...extra }, 'a');
const project = (id: string) => upsertShared(db, 'projects', { id, name: id, status: 'active', is_scratch: 0 }, 'a');
const unpushed = () => (db.prepare('select count(*) c from changes where pushed_at is null').get() as { c: number }).c;

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'a' });
  timers = new FakeTimers();
  rings = [];
  const push = cloud.pushChanges.bind(cloud);
  cloud.pushChanges = (changes, opts) => {
    rings.push(opts?.ring === true);
    return push(changes, opts);
  };
});

describe('急ぐ push', () => {
  it('新しい会話は、直前に push した直後でも 1 秒ほどで、印つきで送る', async () => {
    const e = make();
    await e.start();
    project('p1');
    await timers.advance(1000);
    expect(rings).toEqual([false]);
    session('s1');
    await timers.advance(1000);
    expect(unpushed()).toBe(0);
    expect(rings).toEqual([false, true]);
    e.stop();
  });

  it('急ぐ変更は 150ms 待つだけで、普通の 1 秒のデバウンスを待たない', async () => {
    const e = make();
    await e.start();
    session('s1');
    await timers.advance(149);
    expect(rings).toEqual([]);
    await timers.advance(1);
    expect(rings).toEqual([true]);
    e.stop();
  });

  it('run が新しくできた、ended_at が入ったときは急ぐ。pid の更新と heartbeat だけでは急がない', async () => {
    const e = make();
    await e.start();
    session('s1');
    await timers.advance(1000);
    rings.length = 0;
    run('r1', 's1');
    await timers.advance(1000);
    expect(rings).toEqual([true]);
    run('r1', 's1', { pid: 42, heartbeat_at: 5 });
    await timers.advance(1000);
    expect(rings).toEqual([true]);
    expect(unpushed()).toBe(1);
    await timers.advance(10_000);
    expect(rings).toEqual([true, false]);
    run('r1', 's1', { pid: 42, ended_at: 9, end_reason: 'exited' });
    await timers.advance(1000);
    expect(rings).toEqual([true, false, true]);
    e.stop();
  });

  it('run の live_status が waiting に変わったときは急ぐ。busy や idle への変化は急がない', async () => {
    const e = make();
    await e.start();
    session('s1');
    run('r1', 's1');
    await timers.advance(1000);
    rings.length = 0;
    run('r1', 's1', { live_status: 'busy', live_at: 2 });
    await timers.advance(1000);
    expect(rings).toEqual([]);
    expect(unpushed()).toBe(1);
    await timers.advance(10_000);
    expect(rings).toEqual([false]);
    run('r1', 's1', { live_status: 'waiting', live_at: 3 });
    await timers.advance(1000);
    expect(rings).toEqual([false, true]);
    // 同じ waiting の書き直し（理由だけの変化）は急がない。
    run('r1', 's1', { live_status: 'waiting', live_reason: 'permission', live_at: 3 });
    await timers.advance(1000);
    expect(rings).toEqual([false, true]);
    e.stop();
  });

  it('既にある会話の更新（本文の伸びなど）と、会話以外の変更は急がず、10 秒の最小間隔を守る', async () => {
    const e = make();
    await e.start();
    session('s1');
    await timers.advance(1000);
    rings.length = 0;
    session('s1', { ai_title: 'renamed' });
    project('p1');
    await timers.advance(9_000);
    expect(rings).toEqual([]);
    expect(unpushed()).toBe(2);
    await timers.advance(1_000);
    expect(rings).toEqual([false]);
    e.stop();
  });

  it('急ぐ変更と普通の変更が同じ塊に混ざっても、印は付く', async () => {
    const e = make();
    await e.start();
    project('p1');
    session('s1');
    await timers.advance(1000);
    expect(rings).toEqual([true]);
    e.stop();
  });

  it('急ぐ push が失敗したら、次の push にも印を付ける', async () => {
    const e = make();
    await e.start();
    cloud.offline = true;
    session('s1');
    await timers.advance(1000);
    expect(rings).toEqual([true]);
    cloud.offline = false;
    await e.pushNow();
    expect(rings).toEqual([true, true]);
    e.stop();
  });

  it('急ぐ変更が続いても、印つきの push の間は 1 秒空ける', async () => {
    const e = make();
    await e.start();
    session('s1');
    await timers.advance(200);
    expect(rings).toEqual([true]);
    session('s2');
    await timers.advance(200);
    expect(rings).toEqual([true]);
    await timers.advance(800);
    expect(rings).toEqual([true, true]);
    e.stop();
  });
});
