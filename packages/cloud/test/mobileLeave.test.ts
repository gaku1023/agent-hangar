import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVOKED_ERROR, type DevicesOut } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { addPcDevice, joinPhoneDevice, startCloud, type CloudHarness } from './harness.ts';

/**
 * スマホが自分で接続を外す口（POST /m/leave）。
 * PC からの解除（POST /devices/:id/revoke）と同じ状態にする。
 */

let cloud: CloudHarness;
let pc = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const call = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const leave = (token?: string) => call('/m/leave', { method: 'POST', headers: token ? auth(token) : {} });

const subscribeRow = (deviceId: string) =>
  cloud.env.DB.prepare('insert into push_subscriptions (device_id, endpoint, p256dh, auth, quiet_start, quiet_end, tz_offset, created_at) values (?, ?, ?, ?, null, null, 0, ?)')
    .bind(deviceId, `https://fcm.googleapis.com/fcm/send/${deviceId}`, 'p', 'a', Date.now())
    .run();
const subIds = async () => (await cloud.env.DB.prepare('select device_id from push_subscriptions order by device_id').all<{ device_id: string }>()).results.map((r) => r.device_id);
const listDevices = async () => ((await (await call('/devices', { headers: auth(pc) })).json()) as DevicesOut).devices;

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  pc = await addPcDevice(cloud.env, 'pc-a');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('POST /m/leave', () => {
  it('スマホが自分を解除する。204 を返し、PC からの解除と同じく revoked_at が付いて購読が消える', async () => {
    const a = await joinPhoneDevice(cloud, pc);
    const b = await joinPhoneDevice(cloud, pc);
    await subscribeRow(a.deviceId);
    await subscribeRow(b.deviceId);
    const before = Date.now();
    const r = await leave(a.token);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    const devices = await listDevices();
    const mine = devices.find((d) => d.id === a.deviceId);
    expect(mine?.revokedAt).toBeGreaterThanOrEqual(before);
    expect(mine?.revokedAt).toBeLessThanOrEqual(Date.now());
    // 他のスマホと PC はそのまま。
    expect(devices.find((d) => d.id === b.deviceId)?.revokedAt).toBeNull();
    expect(devices.find((d) => d.id === 'pc-a')?.revokedAt).toBeNull();
    expect(await subIds()).toEqual([b.deviceId]);
    // 外したスマホのトークンは、PC からの解除と同じ 401 の revoked で断られる。
    const after = await call('/m/keybox', { headers: auth(a.token) });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: REVOKED_ERROR });
    // 残りのスマホは使い続けられる。
    expect((await call('/m/inbox', { headers: auth(b.token) })).status).toBe(200);
  });

  it('2 回目は、解除済みのトークンと同じ 401 の revoked で、解除日は動かない', async () => {
    const a = await joinPhoneDevice(cloud, pc);
    expect((await leave(a.token)).status).toBe(204);
    const first = (await listDevices()).find((d) => d.id === a.deviceId)?.revokedAt;
    const again = await leave(a.token);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: REVOKED_ERROR });
    expect((await listDevices()).find((d) => d.id === a.deviceId)?.revokedAt).toBe(first);
  });

  it('PC のトークンは 403 で断り、トークンが無ければ 401。どちらも何も変えない', async () => {
    const a = await joinPhoneDevice(cloud, pc);
    await subscribeRow(a.deviceId);
    expect((await leave(pc)).status).toBe(403);
    expect((await leave()).status).toBe(401);
    expect((await listDevices()).every((d) => d.revokedAt === null)).toBe(true);
    expect(await subIds()).toEqual([a.deviceId]);
  });
});
