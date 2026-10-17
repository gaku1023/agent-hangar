import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

let cloud: CloudHarness;

const changes = (token?: string) =>
  cloud.SELF.fetch('https://x/changes?since=0', token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });

/** 参加の口を通さずに、PC の行を D1 へ直に置き、その端末トークンを返す。 */
const addPc = async (id: string): Promise<string> => {
  const token = `token-${id}-0123456789`;
  await cloud.env.DB.prepare("insert into devices (id, kind, token_hash, joined_at) values (?, 'pc', ?, 1)").bind(id, await sha256Hex(token)).run();
  return token;
};

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
});

afterEach(async () => {
  await cloud.dispose();
});

describe('認証', () => {
  it('トークンが無いか違えば 401、合えば認証を通る', async () => {
    expect((await changes()).status).toBe(401);
    expect((await changes('nope')).status).toBe(401);
    const token = await addPc('pc-a');
    expect((await cloud.SELF.fetch('https://x/devices', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('形の違う authorization も一律に 401 で、理由を漏らさない', async () => {
    const token = await addPc('pc-a');
    const heads: Record<string, string>[] = [
      { authorization: token },
      { authorization: `Basic ${token}` },
      { authorization: 'Bearer ' },
      { authorization: `Bearer ${token}x` },
    ];
    const bodies = new Set<string>();
    for (const headers of heads) {
      const r = await cloud.SELF.fetch('https://x/changes?since=0', { headers });
      expect(r.status).toBe(401);
      bodies.add(await r.text());
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toContain(token);
  });

  it('期限（expires_at）を過ぎたトークンは 401 で expired を返す', async () => {
    const token = await addPc('pc-a');
    await cloud.env.DB.prepare('update devices set expires_at = ? where id = ?').bind(Date.now() - 1, 'pc-a').run();
    const r = await changes(token);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'expired' });
    await cloud.env.DB.prepare('update devices set expires_at = ? where id = ?').bind(Date.now() + 60_000, 'pc-a').run();
    expect((await cloud.SELF.fetch('https://x/devices', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('認証の要る道はすべて middleware の下にある', async () => {
    for (const path of ['/changes', '/changes/x', '/rows', '/files', '/files/x', '/blobs', '/devices', '/devices/x/revoke', '/join-codes', '/join-codes/mine', '/join-codes/x/approve']) {
      expect((await cloud.SELF.fetch(`https://x${path}`)).status).toBe(401);
    }
  });
});
