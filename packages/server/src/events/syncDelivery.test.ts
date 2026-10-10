import { setSessionMemo } from '../sessions/notes.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { getProject, getSession, listDevices } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { setSessionState } from '../sessions/states.ts';
import { SyncEngine } from '../sync/engine.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { Publisher } from './publisher.ts';

/**
 * 同期で降りた行が画面へ届くまでを、本物の同期エンジンと配る層で通す。クラウドだけが偽である。
 * 端末 a が書いて送り、端末 b が受けて配る。
 */
let dbA: Db;
let dbB: Db;
let cloud: FakeCloudClient;
let timers: FakeTimers;
let a: SyncEngine;
let b: SyncEngine;
let publisher: Publisher;
let sent: ServerEvent[];

beforeEach(() => {
  dbA = openDb(':memory:');
  dbB = openDb(':memory:');
  cloud = new FakeCloudClient({ deviceId: 'a' });
  timers = new FakeTimers();
  a = new SyncEngine({ db: dbA, deviceId: 'a', client: cloud, now: () => timers.now, timers, url: 'https://h' });
  b = new SyncEngine({ db: dbB, deviceId: 'b', client: cloud.asDevice('b'), now: () => timers.now, timers, url: 'https://h' });
  sent = [];
  publisher = new Publisher({ db: dbB, deviceId: 'b', live: () => [], hub: { broadcast: (ev) => { sent.push(ev); } } });
});
afterEach(() => { publisher.stop(); a.stop(); b.stop(); });

const types = () => sent.map((e) => e.type).sort();

describe('同期で降りた行の配り', () => {
  it('他端末が書いたセッション、状態、run、プロジェクト、端末が、行ごとに 1 つずつ届く。ロックも載る', async () => {
    await a.start();
    await b.start();
    upsertShared(dbA, 'devices', { id: 'a', name: '端末 A', platform: 'darwin', last_seen_at: 1 }, 'a');
    upsertShared(dbA, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'a');
    upsertShared(dbA, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'a', path: '/a/alpha', resolved: 1 }, 'a');
    upsertShared(dbA, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', project_id: 'p1', cwd: '/a/alpha', home_device: 'a' }, 'a');
    setSessionMemo(dbA, 'a', 's1', '向こうのメモ');
    upsertShared(dbA, 'runs', { id: 'run1', session_id: 's1', device_id: 'a', kind: 'start', tmux_name: 'hangar-run1', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: Date.now() }, 'a');
    setSessionState(dbA, 'a', 's1', { status: 'paused', note: '明日', returnOn: '2099-01-01', setBy: 'user' });
    await a.pushNow();
    sent.length = 0;
    await b.pullNow();
    publisher.flush();

    // sessions、runs、session_states、session_notes の 4 行が降りても、セッションは 1 つ。projects と project_roots の 2 行でも、プロジェクトは 1 つ。
    expect(types()).toEqual(['devices.update', 'project.upsert', 'session.upsert']);
    const s = sent.find((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert')!.session;
    expect(s).toEqual(getSession(dbB, [], 's1', { deviceId: 'b' }));
    expect(s).toMatchObject({ memo: '向こうのメモ', projectId: 'p1', state: { status: 'paused' }, lock: { deviceId: 'a', deviceName: '端末 A', runId: 'run1' } });
    expect(sent.find((e) => e.type === 'project.upsert')).toEqual({ type: 'project.upsert', project: getProject(dbB, 'b', [], 'p1') });
    expect(sent.find((e) => e.type === 'devices.update')).toEqual({ type: 'devices.update', devices: listDevices(dbB, 'b') });
    // 降りた行は changes に積まれない。受けた側が push し返すものは無い。
    expect(dbB.prepare('select count(*) c from changes').get()).toEqual({ c: 0 });
  });

  it('続けて降りた変更は、変わった行の分だけ届く', async () => {
    await a.start();
    await b.start();
    upsertShared(dbA, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', project_id: null, cwd: '/a', home_device: 'a' }, 'a');
    upsertShared(dbA, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', project_id: null, cwd: '/a', home_device: 'a' }, 'a');
    await a.pushNow();
    await b.pullNow();
    publisher.flush();
    sent.length = 0;
    await new Promise<void>((r) => { setTimeout(r, 5); });
    // メモは session_notes の行だけで降りる。sessions の行は動かないが、当のセッションが届く。
    setSessionMemo(dbA, 'a', 's2', '後から');
    await a.pushNow();
    await b.pullNow();
    publisher.flush();
    expect(sent).toEqual([{ type: 'session.upsert', session: getSession(dbB, [], 's2', { deviceId: 'b' }) }]);
    expect(getSession(dbB, [], 's2', { deviceId: 'b' })!.memo).toBe('後から');
  });
});
