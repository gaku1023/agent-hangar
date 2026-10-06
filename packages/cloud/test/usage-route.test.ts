import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const fixture = (n: string) => fs.readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8');
const SECRET = 'join-secret-1';
let cloud: CloudHarness;
afterEach(async () => { await cloud.dispose(); });

async function joined(o: Parameters<typeof startCloud>[0] = {}): Promise<string> {
  resetSchemaCache();
  cloud = await startCloud(o);
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  const r = await cloud.SELF.fetch('https://x/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET, device: { id: 'dev-a', name: 'Mac', platform: 'darwin' } }) });
  return ((await r.json()) as { deviceToken: string }).deviceToken;
}

const outbound = (req: Request): Response => {
  const p = new URL(req.url).pathname;
  const body = p.endsWith('/graphql') ? fixture('graphql-today') : p.endsWith('/subscriptions') ? fixture('subscriptions') : p.endsWith('/billable-usage') ? fixture('billable-usage') : '{}';
  return new Response(body, { headers: { 'content-type': 'application/json' } });
};

describe('GET /usage', () => {
  it('端末トークンが無ければ 401', async () => {
    await joined();
    expect((await cloud.SELF.fetch('https://x/usage')).status).toBe(401);
  });

  it('トークンの secret が無ければ configured: false で、外へは出ない', async () => {
    let out = 0;
    const token = await joined({ outbound: () => { out++; return new Response('{}'); } });
    const r = await cloud.SELF.fetch('https://x/usage', { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ configured: false });
    expect(out).toBe(0);
  });

  it('secret があれば三つをまとめて返し、D1 には 1 行も書かない', async () => {
    const token = await joined({ bindings: { USAGE_API_TOKEN: 'tok', CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' }, outbound });
    const count = async () => {
      const t = await cloud.env.DB.prepare("select (select count(*) from meta) m, (select coalesce(sum(last_seen_at), 0) from devices) d").first<{ m: number; d: number }>();
      return t;
    };
    const before = await count();
    const r = await cloud.SELF.fetch('https://x/usage', { headers: { authorization: `Bearer ${token}` } });
    const body = (await r.json()) as { configured: boolean; plan: { items: { id: string }[] }; month: { services: unknown[] } };
    expect(body.configured).toBe(true);
    expect(body.plan.items[0]!.id).toBe('r2_paid');
    expect(body.month.services).toHaveLength(3);
    expect(await count()).toEqual(before);
  });

  it('応答に API トークンを載せない', async () => {
    const token = await joined({ bindings: { USAGE_API_TOKEN: 'tok-should-not-leak', CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' }, outbound });
    const text = await (await cloud.SELF.fetch('https://x/usage', { headers: { authorization: `Bearer ${token}` } })).text();
    expect(text).not.toContain('tok-should-not-leak');
  });
});
