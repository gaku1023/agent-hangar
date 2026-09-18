import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-1';
const device = { id: 'dev-a', name: 'MacBook', platform: 'darwin' };

let cloud: CloudHarness;

const post = (body: unknown, init: RequestInit = {}) =>
  cloud.SELF.fetch('https://x/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });

const changes = (token?: string) =>
  cloud.SELF.fetch('https://x/changes?since=0', token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });

/**
 * 有効な参加用の秘密を D1 に入れ直す。
 * Worker の束縛は空のままにしてあるので、有効な秘密を決めるのはテストだけである。
 */
const seedSecret = async (secret: string): Promise<void> => {
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(secret) });
};

const join = async (body: unknown = { secret: SECRET, device }): Promise<{ deviceToken: string; deviceId: string }> =>
  (await (await post(body)).json()) as { deviceToken: string; deviceId: string };

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  await seedSecret(SECRET);
});

afterEach(async () => {
  await cloud.dispose();
});

describe('POST /join', () => {
  it('正しい秘密で端末トークンを発行し、D1 にはハッシュだけを置く', async () => {
    const r = await post({ secret: SECRET, device });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { deviceToken: string; deviceId: string };
    expect(body.deviceId).toBe('dev-a');
    expect(body.deviceToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const row = await cloud.env.DB.prepare('select id, name, platform, token_hash, last_pulled_seq from devices where id = ?')
      .bind('dev-a')
      .first<{ id: string; name: string; platform: string; token_hash: string; last_pulled_seq: number }>();
    expect(row?.name).toBe('MacBook');
    expect(row?.platform).toBe('darwin');
    expect(row?.last_pulled_seq).toBe(0);
    expect(row?.token_hash).toBe(await sha256Hex(body.deviceToken));
  });

  it('応答にも D1 にも、参加用の秘密と平文のトークンを残さない', async () => {
    const r = await post({ secret: SECRET, device });
    const text = await r.clone().text();
    expect(text).not.toContain(SECRET);
    const body = (await r.json()) as { deviceToken: string; deviceId: string };
    expect(Object.keys(body).sort()).toEqual(['deviceId', 'deviceToken']);
    const dump = JSON.stringify(
      (await cloud.env.DB.prepare('select * from devices').all<Record<string, unknown>>()).results,
    );
    expect(dump).not.toContain(body.deviceToken);
    expect(dump).not.toContain(SECRET);
    const secrets = JSON.stringify((await cloud.env.DB.prepare('select * from join_secrets').all<Record<string, unknown>>()).results);
    expect(secrets).not.toContain(SECRET);
  });

  it('同じ端末 ID で再参加するとトークンが差し替わる', async () => {
    const a = await join();
    const b = await join({ secret: SECRET, device: { ...device, name: 'MacBook 2' } });
    expect(b.deviceToken).not.toBe(a.deviceToken);
    const n = await cloud.env.DB.prepare('select count(*) c from devices').first<{ c: number }>();
    expect(n?.c).toBe(1);
    const row = await cloud.env.DB.prepare('select name from devices where id = ?').bind('dev-a').first<{ name: string }>();
    expect(row?.name).toBe('MacBook 2');
    expect((await changes(a.deviceToken)).status).toBe(401);
    expect((await changes(b.deviceToken)).status).not.toBe(401);
  });

  it('違う秘密と壊れた本文は拒む', async () => {
    expect((await post({ secret: 'nope', device })).status).toBe(403);
    expect((await post({ secret: SECRET })).status).toBe(400);
    expect((await post({ secret: SECRET, device: { id: '', name: 'x', platform: 'y' } })).status).toBe(400);
    expect((await post({ device })).status).toBe(400);
    const broken = await cloud.SELF.fetch('https://x/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(broken.status).toBe(400);
    const none = await cloud.env.DB.prepare('select count(*) c from devices').first<{ c: number }>();
    expect(none?.c).toBe(0);
  });

  it('revoke された秘密は使えない', async () => {
    await seedSecret('join-secret-2');
    expect((await post({ secret: SECRET, device })).status).toBe(403);
    expect((await post({ secret: 'join-secret-2', device })).status).toBe(201);
  });

  it('秘密が 1 つも無ければ 503', async () => {
    await cloud.env.DB.prepare('delete from join_secrets').run();
    expect((await post({ secret: SECRET, device })).status).toBe(503);
  });
});

describe('認証', () => {
  it('トークンが無いか違えば 401、あれば device が入る', async () => {
    expect((await changes()).status).toBe(401);
    expect((await changes('nope')).status).toBe(401);
    const { deviceToken } = await join();
    const r = await changes(deviceToken);
    expect(r.status).toBe(200);
  });

  it('形の違う authorization も一律に 401 で、理由を漏らさない', async () => {
    const { deviceToken } = await join();
    const heads: Record<string, string>[] = [
      { authorization: deviceToken },
      { authorization: `Basic ${deviceToken}` },
      { authorization: 'Bearer ' },
      { authorization: `Bearer ${deviceToken}x` },
    ];
    const bodies = new Set<string>();
    for (const headers of heads) {
      const r = await cloud.SELF.fetch('https://x/changes?since=0', { headers });
      expect(r.status).toBe(401);
      bodies.add(await r.text());
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toContain(deviceToken);
  });

  it('認証の要る道はすべて middleware の下にある', async () => {
    for (const path of ['/changes', '/changes/x', '/rows', '/files', '/files/x']) {
      expect((await cloud.SELF.fetch(`https://x${path}`)).status).toBe(401);
    }
  });
});
