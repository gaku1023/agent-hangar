import { describe, expect, it } from 'vitest';
import { DEVICE_ADMIN_MIN_WORKER_COMPAT } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { CloudError } from './client.ts';
import { loadCloudDevices } from './devices.ts';

const base = { deviceId: 'a', creator: false, language: () => 'ja' as const };

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
