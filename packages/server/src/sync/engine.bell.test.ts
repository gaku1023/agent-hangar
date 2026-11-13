import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { SyncEngine } from './engine.ts';

/**
 * 呼び鈴で始める pull（pullAfterBell）。
 * 走っている pull は鳴る前に始まっていて、鳴らした変更をまだ見ていないことがある。そのときは終わった後にもう 1 回取る。
 * 実測（2026-11-13、0.22.0-rc.2 の 2 台）：前の急ぐ push の呼び鈴で始まった pull に相乗りし、10 本中 1 本が 0.6 秒でなく 2.5 秒かかった。
 */

let db: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let gate: Promise<void> | null;
let open: () => void;

const pulls = () => cloud.calls.filter((c) => c.method === 'pullChanges').length;

beforeEach(() => {
  db = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'a' });
  timers = new FakeTimers();
  gate = null;
  const pull = cloud.pullChanges.bind(cloud);
  cloud.pullChanges = async (since, limit) => {
    const g = gate;
    if (g) await g;
    return pull(since, limit);
  };
});

const make = async (): Promise<SyncEngine> => {
  const e = new SyncEngine({ db, deviceId: 'a', client: cloud, now: () => timers.now, timers, url: 'https://h' });
  timers.settleWith(() => e.idle());
  await e.start();
  return e;
};

const hold = () => { gate = new Promise((r) => { open = () => { gate = null; r(); }; }); };

describe('呼び鈴で始める pull', () => {
  it('pull が走っていなければ、すぐ 1 回取る', async () => {
    const e = await make();
    const before = pulls();
    await e.pullAfterBell();
    expect(pulls()).toBe(before + 1);
    e.stop();
  });

  it('pull が走っているときに鳴ったら、その pull の後にもう 1 回取る', async () => {
    const e = await make();
    const before = pulls();
    hold();
    const running = e.pullNow();
    const bell = e.pullAfterBell();
    open();
    await running;
    await bell;
    expect(pulls()).toBe(before + 2);
    e.stop();
  });

  it('同じ pull の最中に何度鳴っても、後の pull は 1 回にまとめる', async () => {
    const e = await make();
    const before = pulls();
    hold();
    const running = e.pullNow();
    const bells = [e.pullAfterBell(), e.pullAfterBell(), e.pullAfterBell()];
    open();
    await running;
    await Promise.all(bells);
    expect(pulls()).toBe(before + 2);
    e.stop();
  });

  it('pullNow どうしは今までどおり、走っている pull を分け合う', async () => {
    const e = await make();
    const before = pulls();
    hold();
    const a = e.pullNow();
    const b = e.pullNow();
    open();
    await Promise.all([a, b]);
    expect(pulls()).toBe(before + 1);
    e.stop();
  });
});
