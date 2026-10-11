import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudDeviceOut, CloudDevicesResponse } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { touchDevice } from '../src/seen.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-1';

let cloud: CloudHarness;

/** Cloudflare の端が付ける見出しと request.cf を真似る。値は試験用の作り物である。 */
type Origin = { ip?: string; cf?: Record<string, unknown> };

const send = (path: string, init: RequestInit & { origin?: Origin } = {}) => {
  const { origin, ...rest } = init;
  const headers = { ...((rest.headers as Record<string, string> | undefined) ?? {}) };
  if (origin?.ip) headers['cf-connecting-ip'] = origin.ip;
  return cloud.SELF.fetch(`https://x${path}`, { ...rest, headers, ...(origin?.cf ? { cf: origin.cf } : {}) } as RequestInit);
};

const join = async (id: string, name = id, platform = 'darwin', origin?: Origin): Promise<string> => {
  const r = await send('/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET, device: { id, name, platform } }), origin });
  expect(r.status).toBe(201);
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

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
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
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

describe('最後に同期した IP と場所', () => {
  it('参加と同期のたびに、CF-Connecting-IP と request.cf の city、region、country を写す', async () => {
    const a = await join('dev-a', 'a', 'darwin', { ip: '192.0.2.10', cf: { city: 'Chiba', region: 'Chiba', country: 'JP' } });
    let me = (await list(a)).find((d) => d.id === 'dev-a')!;
    expect([me.lastIp, me.lastCity, me.lastRegion, me.lastCountry]).toEqual(['192.0.2.10', 'Chiba', 'Chiba', 'JP']);
    // 同期の要求（ここでは pull）で、最後の 1 件に置き換わる。
    expect((await pull(a, { ip: '198.51.100.7', cf: { city: 'Osaka', region: 'Osaka', country: 'JP' } })).status).toBe(200);
    me = (await list(a)).find((d) => d.id === 'dev-a')!;
    expect([me.lastIp, me.lastCity, me.lastRegion, me.lastCountry]).toEqual(['198.51.100.7', 'Osaka', 'Osaka', 'JP']);
  });

  it('IP の無い要求では、前の値を消さない', async () => {
    // miniflare は CF-Connecting-IP を必ず足すので、端を通らない要求は書く文を直に走らせて確かめる。
    const a = await join('dev-a', 'a', 'darwin', { ip: '192.0.2.10', cf: { city: 'Chiba', region: 'Chiba', country: 'JP' } });
    await touchDevice(cloud.env.DB, 'dev-a', Date.now(), { ip: null, city: null, region: null, country: null }).run();
    const me = (await list(a)).find((d) => d.id === 'dev-a')!;
    expect(me.lastIp).toBe('192.0.2.10');
    expect(me.lastCity).toBe('Chiba');
  });

  it('push でも更新する', async () => {
    const a = await join('dev-a', 'a', 'darwin', { ip: '192.0.2.10' });
    const r = await send('/changes', {
      method: 'POST',
      headers: { ...auth(a), 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [] }),
      origin: { ip: '203.0.113.5', cf: { city: 'Seattle', region: 'Washington', country: 'US' } },
    });
    expect(r.status).toBe(200);
    const me = (await list(a)).find((d) => d.id === 'dev-a')!;
    expect(me.lastIp).toBe('203.0.113.5');
    expect(me.lastCountry).toBe('US');
    expect(me.lastCity).toBe('Seattle');
  });

  it('長すぎる値と制御文字は切って入れる', async () => {
    const a = await join('dev-a', 'a', 'darwin', { ip: 'x'.repeat(300), cf: { city: 'A\u0000B', country: 'J'.repeat(300) } });
    const me = (await list(a)).find((d) => d.id === 'dev-a')!;
    expect(me.lastIp!.length).toBeLessThanOrEqual(64);
    expect(me.lastCity).toBe('AB');
    expect(me.lastCountry!.length).toBeLessThanOrEqual(64);
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

describe('スキーマの足し方', () => {
  it('列の無い古い devices に、起動のたびの用意で列を足す（2 回目は何もしない）', async () => {
    // 版 4 までの Worker が作った devices を真似る。
    await cloud.env.DB.prepare('drop table devices').run();
    await cloud.env.DB.prepare('create table devices (id text primary key, name text not null, platform text not null, token_hash text not null unique, joined_at integer not null, last_seen_at integer, last_pulled_seq integer not null default 0)').run();
    await cloud.env.DB.prepare("insert into devices (id, name, platform, token_hash, joined_at) values ('old', 'old', 'darwin', 'h', 1)").run();
    resetSchemaCache();
    await ensureSchema(cloud.env);
    resetSchemaCache();
    await ensureSchema(cloud.env);
    const cols = (await cloud.env.DB.prepare('pragma table_info(devices)').all<{ name: string }>()).results.map((c) => c.name);
    for (const c of ['revoked_at', 'last_ip', 'last_city', 'last_region', 'last_country']) expect(cols).toContain(c);
    const old = await cloud.env.DB.prepare("select revoked_at from devices where id = 'old'").first<{ revoked_at: number | null }>();
    expect(old?.revoked_at).toBeNull();
  });
});
