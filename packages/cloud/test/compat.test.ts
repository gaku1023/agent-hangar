import { afterEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';
import { MIN_DEVICE_COMPAT } from '../src/compat.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex, VERSION } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-compat';
const device = { id: 'dev-a', name: 'dev-a', platform: 'darwin' };
const joinInit = (headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ secret: SECRET, device }),
});

let cloud: CloudHarness | null = null;

/** Worker を起こし、参加用の秘密を入れる。下限を渡すと、その下限の Worker を起こす。 */
const boot = async (minDeviceCompat?: number): Promise<CloudHarness> => {
  resetSchemaCache();
  const c = await startCloud(minDeviceCompat === undefined ? {} : { minDeviceCompat });
  resetSchemaCache();
  await ensureSchema({ ...c.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  cloud = c;
  return c;
};

afterEach(async () => {
  await cloud?.dispose();
  cloud = null;
});

describe('互換の版（本番の下限）', () => {
  it('本番の下限は 1 である（段 1 の PR 6 で上げた）', () => {
    expect(MIN_DEVICE_COMPAT).toBe(1);
  });

  it('/health は Worker の版を返し、版を名乗らない相手にも答える', async () => {
    const c = await boot();
    const r = await c.RAW.fetch('https://x/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: VERSION, compat: COMPAT_VERSION });
  });

  it('どの応答にも、見出しで Worker の版を載せる（断ったもの、無い経路を含む）', async () => {
    const c = await boot();
    const responses = [
      await c.RAW.fetch('https://x/health'),
      await c.SELF.fetch('https://x/changes?since=0'),
      await c.SELF.fetch('https://x/nope'),
      await c.SELF.fetch('https://x/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      await c.RAW.fetch('https://x/changes?since=0'),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 404, 400, 426]);
    for (const r of responses) expect(r.headers.get(COMPAT_HEADER), String(r.status)).toBe(String(COMPAT_VERSION));
  });

  it('R2 の本文をそのまま返す応答にも版を載せ、本文と長さは崩さない', async () => {
    const c = await boot();
    const { deviceToken } = (await (await c.SELF.fetch('https://x/join', joinInit())).json()) as { deviceToken: string };
    await c.env.BUCKET.put('transcripts/dev-a/u1.jsonl.gz', 'abc');
    const g = await c.SELF.fetch('https://x/files/transcripts/dev-a/u1.jsonl.gz', { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(g.status).toBe(200);
    expect(g.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
    expect(g.headers.get('content-length')).toBe('3');
    expect(await g.text()).toBe('abc');
  });

  it('見出しの無い要求（版 0 の古い端末）は、参加も含めて 426 と下限で断る', async () => {
    const c = await boot();
    const j = await c.RAW.fetch('https://x/join', joinInit());
    expect(j.status).toBe(426);
    expect(await j.json()).toEqual({ error: 'upgrade required', minCompat: 1, compat: COMPAT_VERSION });
    expect((await c.RAW.fetch('https://x/changes?since=0')).status).toBe(426);
  });
});

describe('互換の版（下限を上げた Worker）', () => {
  it('見出しの無い要求には、認証より先に 426 と下限を返す', async () => {
    const c = await boot(1);
    const r = await c.RAW.fetch('https://x/changes?since=0');
    expect(r.status).toBe(426);
    expect(r.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
    expect(await r.json()).toEqual({ error: 'upgrade required', minCompat: 1, compat: COMPAT_VERSION });
  });

  it('参加も、版の古い端末なら断る', async () => {
    const c = await boot(1);
    const r = await c.RAW.fetch('https://x/join', joinInit());
    expect(r.status).toBe(426);
    expect(await r.json()).toMatchObject({ minCompat: 1 });
  });

  it('読めない版の見出しは版 0 として断る', async () => {
    const c = await boot(1);
    for (const v of ['abc', '-1', '1.5', '']) {
      const r = await c.SELF.fetch('https://x/changes?since=0', { headers: { [COMPAT_HEADER]: v } });
      expect(r.status, JSON.stringify(v)).toBe(426);
    }
  });

  it('下限と同じ版を名乗る要求は通し、/health は版を問わずに通す', async () => {
    const c = await boot(1);
    const j = await c.SELF.fetch('https://x/join', joinInit());
    expect(j.status).toBe(201);
    const { deviceToken } = (await j.json()) as { deviceToken: string };
    expect((await c.SELF.fetch('https://x/changes?since=0', { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(200);
    const h = await c.RAW.fetch('https://x/health');
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ compat: COMPAT_VERSION });
  });

  it('断る要求では、スキーマの用意も走らせない（D1 に触らない）', async () => {
    resetSchemaCache();
    const c = await startCloud({ minDeviceCompat: 1 });
    cloud = c;
    expect((await c.RAW.fetch('https://x/changes?since=0')).status).toBe(426);
    const t = await c.env.DB.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'devices'").first<{ n: number }>();
    expect(t?.n).toBe(0);
  });
});
