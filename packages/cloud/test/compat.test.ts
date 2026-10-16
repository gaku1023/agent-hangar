import { afterEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';
import { MIN_DEVICE_COMPAT } from '../src/compat.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex, VERSION } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

let cloud: CloudHarness | null = null;

/** Worker を起こし、表を用意する。下限を渡すと、その下限の Worker を起こす。 */
const boot = async (minDeviceCompat?: number): Promise<CloudHarness> => {
  resetSchemaCache();
  const c = await startCloud(minDeviceCompat === undefined ? {} : { minDeviceCompat });
  resetSchemaCache();
  await ensureSchema(c.env);
  cloud = c;
  return c;
};

/** 参加の口を通さずに、PC の行を D1 へ直に置き、その端末トークンを返す。 */
const addPc = async (c: CloudHarness, id: string): Promise<string> => {
  const token = `token-${id}`;
  await c.env.DB.prepare("insert into devices (id, kind, token_hash, joined_at) values (?, 'pc', ?, 1)").bind(id, await sha256Hex(token)).run();
  return token;
};

afterEach(async () => {
  await cloud?.dispose();
  cloud = null;
});

describe('互換の版（本番の下限）', () => {
  it('本番の下限は 9 である（E2E の作り直しで上げた）', () => {
    expect(MIN_DEVICE_COMPAT).toBe(9);
    expect(COMPAT_VERSION).toBe(9);
    // この版の端末は通す。下限を、束ねて配る端末の版より先へ上げない。
    expect(MIN_DEVICE_COMPAT).toBeLessThanOrEqual(COMPAT_VERSION);
  });

  it('版 8 の PC は 426 と下限で断る', async () => {
    const c = await boot();
    const v8 = { [COMPAT_HEADER]: '8' };
    for (const [method, url] of [['GET', 'https://x/changes?since=0'], ['POST', 'https://x/changes'], ['GET', 'https://x/devices'], ['POST', 'https://x/m/join']] as const) {
      const r = await c.RAW.fetch(url, { method, headers: v8 });
      expect(r.status, `${method} ${url}`).toBe(426);
      expect(await r.json(), `${method} ${url}`).toEqual({ error: 'upgrade required', minCompat: 9, compat: 9 });
    }
  });

  it('見出しの無い要求（版 0 の古い端末）は 426 と下限で断る', async () => {
    const c = await boot();
    const r = await c.RAW.fetch('https://x/changes?since=0');
    expect(r.status).toBe(426);
    expect(await r.json()).toEqual({ error: 'upgrade required', minCompat: MIN_DEVICE_COMPAT, compat: COMPAT_VERSION });
  });

  it('参加用の秘密で参加する古い口（POST /join）は無い', async () => {
    const c = await boot();
    const r = await c.SELF.fetch('https://x/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 's', device: { id: 'pc-a', name: 'pc-a', platform: 'darwin' } }) });
    expect(r.status).toBe(404);
  });

  it('/health は compat 9 と cloudId を返し、版を名乗らない相手にも答える', async () => {
    const c = await boot();
    const r = await c.RAW.fetch('https://x/health');
    expect(r.status).toBe(200);
    expect(r.headers.get(COMPAT_HEADER)).toBe('9');
    const body = (await r.json()) as { ok: boolean; version: string; compat: number; cloudId: string };
    const stored = await c.env.DB.prepare("select value from meta where key = 'cloud_id'").first<{ value: string }>();
    expect(body).toEqual({ ok: true, version: VERSION, compat: 9, cloudId: stored?.value });
    expect(typeof body.cloudId).toBe('string');
    // 2 回目も同じ値である。
    expect(((await (await c.RAW.fetch('https://x/health')).json()) as { cloudId: string }).cloudId).toBe(body.cloudId);
  });

  it('どの応答にも、見出しで Worker の版を載せる（断ったもの、無い経路を含む）', async () => {
    const c = await boot();
    const responses = [
      await c.RAW.fetch('https://x/health'),
      await c.SELF.fetch('https://x/changes?since=0'),
      await c.SELF.fetch('https://x/nope'),
      await c.RAW.fetch('https://x/changes?since=0'),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 404, 426]);
    for (const r of responses) expect(r.headers.get(COMPAT_HEADER), String(r.status)).toBe(String(COMPAT_VERSION));
  });

  it('R2 の本文をそのまま返す応答にも版を載せ、本文と長さは崩さない', async () => {
    const c = await boot();
    const token = await addPc(c, 'pc-a');
    await c.env.BUCKET.put('transcripts/pc-a/u1.jsonl.gz', 'abc');
    const g = await c.SELF.fetch('https://x/files/transcripts/pc-a/u1.jsonl.gz', { headers: { authorization: `Bearer ${token}` } });
    expect(g.status).toBe(200);
    expect(g.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
    expect(g.headers.get('content-length')).toBe('3');
    expect(await g.text()).toBe('abc');
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

  it('読めない版の見出しは版 0 として断る', async () => {
    const c = await boot(1);
    for (const v of ['abc', '-1', '1.5', '']) {
      const r = await c.SELF.fetch('https://x/changes?since=0', { headers: { [COMPAT_HEADER]: v } });
      expect(r.status, JSON.stringify(v)).toBe(426);
    }
  });

  it('下限と同じ版を名乗る要求は関所を通り、/health は版を問わずに通す', async () => {
    const c = await boot(1);
    // 関所を通った先の認証で 401 になる（426 ではない）。
    expect((await c.SELF.fetch('https://x/changes?since=0', { headers: { [COMPAT_HEADER]: '1' } })).status).toBe(401);
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
