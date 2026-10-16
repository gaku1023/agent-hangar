import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudDeviceOut, CloudDevicesResponse } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { addPcDevice, startCloud, type CloudHarness } from './harness.ts';

let cloud: CloudHarness;

/** Cloudflare の端が付ける見出しと request.cf を真似る。値は試験用の作り物である。 */
type Origin = { ip?: string; cf?: Record<string, unknown> };

const send = (path: string, init: RequestInit & { origin?: Origin } = {}) => {
  const { origin, ...rest } = init;
  const headers = { ...((rest.headers as Record<string, string> | undefined) ?? {}) };
  if (origin?.ip) headers['cf-connecting-ip'] = origin.ip;
  return cloud.SELF.fetch(`https://x${path}`, { ...rest, headers, ...(origin?.cf ? { cf: origin.cf } : {}) } as RequestInit);
};

/**
 * PC の行を D1 へ直に置く（互換の版 9 で POST /join を消した）。
 * 名前と OS は devices に置かなくなったので、その引数は読まない。devices の試験を作り直すまで呼び方だけ残す。
 */
const join = async (id: string, _name = id, _platform = 'darwin', _origin?: Origin): Promise<string> => addPcDevice(cloud.env, id);

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const list = async (token: string): Promise<CloudDeviceOut[]> => {
  const r = await send('/devices', { headers: auth(token) });
  expect(r.status).toBe(200);
  return ((await r.json()) as CloudDevicesResponse).devices;
};

const revoke = (token: string, id: string) => send(`/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: auth(token) });

const pull = (token: string, origin?: Origin) => send('/changes?since=0', { headers: auth(token), origin });

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
});

afterEach(async () => {
  await cloud.dispose();
});

describe('GET /devices', () => {
  it('参加した PC を、参加日と最後に同期した時刻と一緒に返す', async () => {
    const a = await join('dev-a', 'studio', 'darwin');
    await join('dev-b', 'desk', 'win32');
    const devices = await list(a);
    expect(devices.map((d) => [d.id, d.name, d.platform])).toEqual(expect.arrayContaining([['dev-a', 'studio', 'darwin'], ['dev-b', 'desk', 'win32']]));
    for (const d of devices) {
      expect(d.joinedAt).toBeGreaterThan(0);
      expect(d.revokedAt).toBeNull();
    }
  });

  it('端末トークンも秘密のハッシュも返さない', async () => {
    const a = await join('dev-a');
    const r = await send('/devices', { headers: auth(a) });
    const text = await r.text();
    expect(text).not.toContain(a);
    expect(text).not.toContain('token');
    expect(text).not.toContain(await sha256Hex(a));
  });

  it('端末トークンが要る', async () => {
    expect((await send('/devices')).status).toBe(401);
    expect((await send('/devices/dev-a/revoke', { method: 'POST' })).status).toBe(401);
  });
});

describe('POST /devices/:id/revoke', () => {
  it('他の PC を解除すると、その PC の端末トークンは 401 の revoked で断られ、一覧には解除日つきで残る', async () => {
    const a = await join('dev-a');
    const b = await join('dev-b');
    const r = await revoke(a, 'dev-b');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { device: CloudDeviceOut };
    expect(body.device.id).toBe('dev-b');
    expect(body.device.revokedAt).toBeGreaterThan(0);
    const denied = await pull(b);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'revoked' });
    const after = await list(a);
    expect(after.find((d) => d.id === 'dev-b')?.revokedAt).toBe(body.device.revokedAt);
    // 解除した側はそのまま使える。
    expect((await pull(a)).status).toBe(200);
  });

  it('自分自身も解除できる（この PC の参加を解除）', async () => {
    const a = await join('dev-a');
    expect((await revoke(a, 'dev-a')).status).toBe(200);
    expect((await pull(a)).status).toBe(401);
  });

  it('違うトークンには、解除済みでも一律の unauthorized を返す', async () => {
    const a = await join('dev-a');
    await join('dev-b');
    await revoke(a, 'dev-b');
    const r = await send('/changes?since=0', { headers: auth('not-a-token') });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthorized' });
  });

  it('解除済みの PC は、もう一度解除しても解除日を変えない', async () => {
    const a = await join('dev-a');
    await join('dev-b');
    const first = (await (await revoke(a, 'dev-b')).json()) as { device: CloudDeviceOut };
    const second = await revoke(a, 'dev-b');
    expect(second.status).toBe(200);
    expect(((await second.json()) as { device: CloudDeviceOut }).device.revokedAt).toBe(first.device.revokedAt);
  });

  it('知らない PC は 404、形の違う ID は 400', async () => {
    const a = await join('dev-a');
    expect((await revoke(a, 'dev-zzz')).status).toBe(404);
    expect((await send('/devices/..%2Fx/revoke', { method: 'POST', headers: auth(a) })).status).toBe(400);
  });

  it('解除した PC が参加トークンで参加し直すと、解除が外れて参加日が新しくなる', async () => {
    const a = await join('dev-a');
    await join('dev-b');
    const before = (await list(a)).find((d) => d.id === 'dev-b')!;
    await revoke(a, 'dev-b');
    await new Promise((r) => setTimeout(r, 5));
    const b2 = await join('dev-b');
    expect((await pull(b2)).status).toBe(200);
    const after = (await list(a)).find((d) => d.id === 'dev-b')!;
    expect(after.revokedAt).toBeNull();
    expect(after.joinedAt).toBeGreaterThan(before.joinedAt);
  });

  it('解除していない PC が参加し直しても、参加日は最初のまま', async () => {
    const a = await join('dev-a');
    const before = (await list(a)).find((d) => d.id === 'dev-a')!;
    await new Promise((r) => setTimeout(r, 5));
    const a2 = await join('dev-a');
    expect((await list(a2)).find((d) => d.id === 'dev-a')!.joinedAt).toBe(before.joinedAt);
  });
});

