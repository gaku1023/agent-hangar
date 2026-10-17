import { describe, expect, it } from 'vitest';
import { DEVICE_ADMIN_MIN_WORKER_COMPAT, type Roster } from '@agent-hangar/shared';
import { testKey } from '../../test/cloudConfig.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { CloudError } from './client.ts';
import { loadCloudDevices } from './devices.ts';

const base = { deviceId: 'a', creator: false, language: () => 'ja' as const, roster: null };

const roster = (entries: Roster['entries']) => ({ read: async () => ({ version: 1, roster: { v: 1 as const, entries, recoveryPub: testKey(8), phoneKey: null } }) });

describe('loadCloudDevices', () => {
  it('同期していなければ off', async () => {
    expect(await loadCloudDevices({ ...base, client: null })).toEqual({ state: 'off', devices: [], creator: false, message: null });
  });

  it('Worker の一覧に、この PC の印を付けて返す。解除した PC も入る', async () => {
    const cloud = new FakeCloudClient({ deviceId: 'a' });
    await cloud.asDevice('b').health();
    await cloud.asDevice('b').listDevices();
    cloud.revoke('c');
    const r = await loadCloudDevices({ ...base, client: cloud, creator: true });
    expect(r.state).toBe('ok');
    expect(r.creator).toBe(true);
    expect(r.devices.map((d) => [d.id, d.self, d.revokedAt === null])).toEqual(expect.arrayContaining([['a', true, true], ['b', false, true], ['c', false, false]]));
  });

  it('一覧の名前と OS は名簿から、生存は devices から', async () => {
    let now = 1_000;
    const cloud = new FakeCloudClient({ deviceId: 'pc-a', now: () => now });
    await cloud.health();
    now = 5_000;
    await cloud.asDevice('pc-b').health();
    cloud.revoke('pc-c');
    const names = roster([
      { id: 'pc-a', kind: 'pc', name: 'desk', os: 'darwin', pub: testKey(9), joinedAt: 1 },
      { id: 'pc-b', kind: 'pc', name: 'laptop', os: 'win32', pub: testKey(10), joinedAt: 2 },
      // Worker に無い名簿の行は出さない（一覧の正は Worker の devices）。
      { id: 'pc-z', kind: 'pc', name: 'gone', os: 'linux', pub: testKey(11), joinedAt: 3 },
    ]);
    const r = await loadCloudDevices({ ...base, deviceId: 'pc-a', client: cloud, roster: names });
    expect(r.state).toBe('ok');
    const byId = new Map(r.devices.map((d) => [d.id, d]));
    expect(byId.get('pc-a')).toEqual({ id: 'pc-a', kind: 'pc', name: 'desk', platform: 'darwin', joinedAt: 1_000, lastSeenAt: 1_000, revokedAt: null, expiresAt: null, self: true });
    expect(byId.get('pc-b')).toMatchObject({ name: 'laptop', platform: 'win32', lastSeenAt: 5_000, revokedAt: null, self: false });
    // 名簿に無い Worker の端末は、名前のわからない端末として出す。
    expect(byId.get('pc-c')).toMatchObject({ name: null, platform: null, revokedAt: 5_000 });
    expect(byId.has('pc-z')).toBe(false);
    // IP と所在地は持たない。
    expect(Object.keys(byId.get('pc-a')!)).not.toContain('lastIp');
  });

  it('一覧を読むたびに名簿の写しを捨ててから読む（一時停止の間に変わった名前を古いまま出さない）', async () => {
    const cloud = new FakeCloudClient({ deviceId: 'a' });
    const order: string[] = [];
    const r = { read: async () => { order.push('read'); return { version: 1, roster: { v: 1 as const, entries: [], recoveryPub: testKey(8), phoneKey: null } }; }, invalidate: () => { order.push('invalidate'); } };
    await loadCloudDevices({ ...base, client: cloud, roster: r });
    expect(order).toEqual(['invalidate', 'read']);
  });

  it('名簿が読めなくても、一覧は名前なしで出す', async () => {
    const cloud = new FakeCloudClient({ deviceId: 'a' });
    const r = await loadCloudDevices({ ...base, client: cloud, roster: { read: async () => { throw new CloudError(0, 'offline'); } } });
    expect(r.state).toBe('ok');
    expect(r.devices.map((d) => [d.id, d.name])).toEqual([['a', null]]);
  });

  it('Worker が名乗った版が足りなければ、問い合わせずに outdated を返す', async () => {
    // 製品の下限（MIN_WORKER_COMPAT、版 6）は一覧の関所（版 5）より高いので、実物ではこの Worker を先に断る。ここでは関所だけを試す。
    const cloud = new FakeCloudClient({ deviceId: 'a', minWorkerCompat: 1 });
    cloud.workerCompat = DEVICE_ADMIN_MIN_WORKER_COMPAT - 1;
    await cloud.health();
    const before = cloud.calls.length;
    const r = await loadCloudDevices({ ...base, client: cloud });
    expect(r.state).toBe('outdated');
    expect(r.message).toContain('Worker');
    expect(cloud.calls.length).toBe(before);
  });

  it('一覧の口の無い古い Worker（404）は outdated', async () => {
    const cloud = new FakeCloudClient({ deviceId: 'a' });
    cloud.listDevices = async () => { throw new CloudError(404, JSON.stringify({ error: 'not found' })); };
    expect((await loadCloudDevices({ ...base, client: cloud })).state).toBe('outdated');
  });

  it('この PC が解除されていれば revoked、繋がらなければ unreachable', async () => {
    const cloud = new FakeCloudClient({ deviceId: 'a' });
    cloud.revoke('a');
    expect((await loadCloudDevices({ ...base, client: cloud })).state).toBe('revoked');
    const off = new FakeCloudClient({ deviceId: 'a' });
    off.offline = true;
    const r = await loadCloudDevices({ ...base, client: off });
    expect(r.state).toBe('unreachable');
    expect(r.message).not.toBeNull();
  });
});
