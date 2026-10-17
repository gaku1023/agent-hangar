import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MOBILE_IMAGE_MAX_BYTES, MOBILE_IMAGES_PER_PHONE, type MobileJoinResponse } from '@agent-hangar/shared';
import { IMAGE_KEEP_MS, MAX_BLOB_BYTES, sweepOldImages } from '../src/mobileBlobs.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { addPcDevice, joinPhoneDevice, startCloud, type CloudHarness } from './harness.ts';

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (token: string, path: string, body?: unknown) =>
  send(path, { method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** PC の行を D1 へ直に置く（互換の版 9 で POST /join を消した）。 */
const joinPc = (id: string): Promise<string> => addPcDevice(cloud.env, id);

const joinPhone = (pcToken: string): Promise<MobileJoinResponse> => joinPhoneDevice(cloud, pcToken);

const bytes = (n: number, fill = 7): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(fill);
const putBlob = (token: string, id: string, n: number | string, body: Uint8Array<ArrayBuffer> | null = bytes(64)) =>
  // miniflare の dispatchFetch は本文の長さを付けずに流すので、実機と同じく明示する。
  send(`/m/blobs/${id}/${n}`, { method: 'PUT', headers: auth(token, { 'content-type': 'application/octet-stream', 'content-length': String(body?.byteLength ?? 0) }), ...(body ? { body } : {}) });
const getBlob = (token: string, id: string, n: number | string) => send(`/m/blobs/${id}/${n}`, { headers: auth(token) });
const launch = (phone: string, id: string, target: string) => post(phone, '/m/launches', { id, targetDevice: target, sealed: 'sealed-req', epoch: 1 });
const claim = (pc: string, id: string) => post(pc, `/m/launches/${id}/claim`);
const answer = (pc: string, id: string, ok = true) => post(pc, `/m/launches/${id}/answer`, { ok, sealedAnswer: 'sealed-ans' });
const keys = async (prefix: string) => (await cloud.env.BUCKET.list({ prefix })).objects.map((o) => o.key).sort();

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
});

afterEach(async () => {
  await cloud.dispose();
});

describe('PUT /m/blobs/:id/:n（スマホが封をした画像を置く）', () => {
  it('mobile/<自分>/<依頼>/<n> に本文そのままで置ける', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const body = Uint8Array.from({ length: 100 }, (_, i) => i);
    const r = await putBlob(phone.token, 'l-1', 2, body);
    expect(r.status).toBe(201);
    expect(await keys('mobile/')).toEqual([`mobile/${phone.deviceId}/l-1/2`]);
    const obj = await cloud.env.BUCKET.get(`mobile/${phone.deviceId}/l-1/2`);
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(body);
  });

  it('同じ番号への置き直しは上書きで、枚数は増えない', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect((await putBlob(phone.token, 'l-1', 0, bytes(10, 1))).status).toBe(201);
    expect((await putBlob(phone.token, 'l-1', 0, bytes(12, 2))).status).toBe(201);
    expect(await keys('mobile/')).toHaveLength(1);
    expect((await cloud.env.BUCKET.get(`mobile/${phone.deviceId}/l-1/0`))?.size).toBe(12);
  });

  it('n が 0〜3 の外、整数でない、依頼の ID の形が違うときは 400', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    for (const n of ['4', '-1', '1.5', 'a', '01']) expect((await putBlob(phone.token, 'l-1', n)).status, `n=${n}`).toBe(400);
    expect((await putBlob(phone.token, 'x'.repeat(65), 0)).status).toBe(400);
    expect((await putBlob(phone.token, 'a%2Fb', 0)).status).toBe(400);
    expect((await putBlob(phone.token, '.hidden', 0)).status).toBe(400);
    expect(await keys('mobile/')).toEqual([]);
  });

  it('64 字までの依頼の ID は通る', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect((await putBlob(phone.token, 'x'.repeat(64), 0)).status).toBe(201);
  });

  it('上限（5 MiB + 封の 28 バイト）まで通り、1 バイト超えたら 413、空の本文は 400', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect(MAX_BLOB_BYTES).toBe(MOBILE_IMAGE_MAX_BYTES + 28);
    expect((await putBlob(phone.token, 'l-1', 0, bytes(MAX_BLOB_BYTES))).status).toBe(201);
    const big = await putBlob(phone.token, 'l-1', 1, bytes(MAX_BLOB_BYTES + 1));
    expect(big.status).toBe(413);
    expect(await keys(`mobile/${phone.deviceId}/l-1/1`)).toEqual([]);
    expect((await putBlob(phone.token, 'l-1', 2, null)).status).toBe(400);
    expect((await send('/m/blobs/l-1/2', { method: 'PUT', headers: auth(phone.token), body: bytes(8) })).status).toBe(411);
    expect(await keys('mobile/')).toEqual([`mobile/${phone.deviceId}/l-1/0`]);
  });

  it('置いたままが 40 枚になったら、41 枚目は 429（置き直しは通る）', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    for (let i = 0; i < MOBILE_IMAGES_PER_PHONE; i++) {
      const r = await putBlob(phone.token, `l-${Math.floor(i / 4)}`, i % 4, bytes(16));
      expect(r.status, `${i}`).toBe(201);
    }
    const over = await putBlob(phone.token, 'l-99', 0, bytes(16));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'too many images' });
    expect(await keys('mobile/')).toHaveLength(MOBILE_IMAGES_PER_PHONE);
    expect((await putBlob(phone.token, 'l-0', 0, bytes(20))).status).toBe(201);
  });

  it('PC のトークンは 403、トークン無しは 401', async () => {
    const pc = await joinPc('pc-a');
    expect((await putBlob(pc, 'l-1', 0)).status).toBe(403);
    expect((await send('/m/blobs/l-1/0', { method: 'PUT', body: bytes(8) })).status).toBe(401);
    expect(await keys('mobile/')).toEqual([]);
  });

  it('スマホが書けるのは自分の下だけ（別のスマホの下には届かない）', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await putBlob(phone.token, 'l-1', 0);
    const second = await joinPhone(pc);
    await putBlob(second.token, 'l-1', 0);
    expect(await keys('mobile/')).toEqual([`mobile/${phone.deviceId}/l-1/0`, `mobile/${second.deviceId}/l-1/0`].sort());
  });

  it('今の files の口は変わらない（mobile/ の鍵は PC もスマホも読めない）', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await putBlob(phone.token, 'l-1', 0);
    const key = `mobile/${phone.deviceId}/l-1/0`;
    expect((await send(`/files/${key}`, { headers: auth(pc) })).status).toBe(400);
    expect((await send(`/files/${key}`, { headers: auth(phone.token) })).status).toBe(403);
  });
});

describe('GET /m/blobs/:id/:n（宛先の PC が読む）と答えでの削除', () => {
  const setup = async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    const body = Uint8Array.from({ length: 50 }, (_, i) => i * 3);
    expect((await putBlob(phone.token, 'l-1', 0, body)).status).toBe(201);
    expect((await launch(phone.token, 'l-1', 'pc-a')).status).toBe(201);
    return { pcA, pcB, phone, body };
  };

  it('受け取った（claimed）自分宛ての依頼の画像だけ、本文そのままで読める', async () => {
    const { pcA, body } = await setup();
    expect((await claim(pcA, 'l-1')).status).toBe(200);
    const r = await getBlob(pcA, 'l-1', 0);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(body);
  });

  it('受け取る前（pending）は 404', async () => {
    const { pcA } = await setup();
    expect((await getBlob(pcA, 'l-1', 0)).status).toBe(404);
  });

  it('置いていない番号、無い依頼は 404', async () => {
    const { pcA } = await setup();
    await claim(pcA, 'l-1');
    expect((await getBlob(pcA, 'l-1', 3)).status).toBe(404);
    expect((await getBlob(pcA, 'l-none', 0)).status).toBe(404);
  });

  it('宛先でないほかの PC は 404、スマホは 403、トークン無しは 401', async () => {
    const { pcA, pcB, phone } = await setup();
    await claim(pcA, 'l-1');
    expect((await getBlob(pcB, 'l-1', 0)).status).toBe(404);
    expect((await getBlob(phone.token, 'l-1', 0)).status).toBe(403);
    expect((await send('/m/blobs/l-1/0')).status).toBe(401);
  });

  it('n と依頼の ID の形が違えば 400', async () => {
    const { pcA } = await setup();
    await claim(pcA, 'l-1');
    expect((await getBlob(pcA, 'l-1', 4)).status).toBe(400);
    expect((await getBlob(pcA, 'a%2Fb', 0)).status).toBe(400);
  });

  it('PC の答え（started）でその依頼の画像が消え、その後は 404。別の依頼の画像は残る', async () => {
    const { pcA, phone } = await setup();
    await putBlob(phone.token, 'l-1', 1);
    await putBlob(phone.token, 'l-2', 0);
    await claim(pcA, 'l-1');
    expect((await answer(pcA, 'l-1')).status).toBe(200);
    expect(await keys(`mobile/${phone.deviceId}/l-1/`)).toEqual([]);
    expect(await keys('mobile/')).toEqual([`mobile/${phone.deviceId}/l-2/0`]);
    expect((await getBlob(pcA, 'l-1', 0)).status).toBe(404);
  });

  it('PC の答え（failed）でも消える', async () => {
    const { pcA, phone } = await setup();
    await claim(pcA, 'l-1');
    expect((await answer(pcA, 'l-1', false)).status).toBe(200);
    expect(await keys(`mobile/${phone.deviceId}/`)).toEqual([]);
  });

  it('答えが通らなかったとき（受け取っていない、宛先でない）は消さない', async () => {
    const { pcA, pcB, phone } = await setup();
    expect((await answer(pcA, 'l-1')).status).toBe(409);
    await claim(pcA, 'l-1');
    expect((await answer(pcB, 'l-1')).status).toBe(409);
    expect(await keys(`mobile/${phone.deviceId}/`)).toEqual([`mobile/${phone.deviceId}/l-1/0`]);
  });

  it('画像の無い依頼の答えも、今までどおり 200', async () => {
    const pcA = await joinPc('pc-a');
    const phone = await joinPhone(pcA);
    expect((await launch(phone.token, 'l-3', 'pc-a')).status).toBe(201);
    await claim(pcA, 'l-3');
    expect((await answer(pcA, 'l-3')).status).toBe(200);
  });
});

describe('古い画像の掃除', () => {
  it('24 時間より古いものだけ、そのスマホの下で消す（sweepOldImages は uploaded を見る）', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const second = await joinPhone(pc);
    await putBlob(phone.token, 'l-1', 0);
    await putBlob(phone.token, 'l-1', 1);
    await putBlob(second.token, 'l-1', 0);
    const now = Date.now();
    // 24 時間たつ前の時刻から見れば、何も消えない。
    expect(await sweepOldImages(cloud.env.BUCKET, phone.deviceId, now + IMAGE_KEEP_MS - 60_000)).toBe(0);
    expect(await keys('mobile/')).toHaveLength(3);
    // 24 時間を過ぎた時刻から見れば、そのスマホの分だけ消える。
    expect(await sweepOldImages(cloud.env.BUCKET, phone.deviceId, now + IMAGE_KEEP_MS + 60_000)).toBe(2);
    expect(await keys('mobile/')).toEqual([`mobile/${second.deviceId}/l-1/0`]);
  });

  it('置くときと依頼を出すときも掃除は走るが、新しい画像は消えない', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await putBlob(phone.token, 'l-1', 0);
    await putBlob(phone.token, 'l-1', 1);
    expect((await launch(phone.token, 'l-1', 'pc-a')).status).toBe(201);
    expect(await keys('mobile/')).toHaveLength(2);
  });
});

describe('DELETE /m/feed（PC が自分の受信箱の素を消す）', () => {
  const putFeed = (token: string, sealed = 'sealed-feed') => send('/m/feed', { method: 'PUT', headers: auth(token, { 'content-type': 'application/json' }), body: JSON.stringify({ sealed, epoch: 1 }) });
  const feedRows = async () => (await cloud.env.DB.prepare('select device_id from mobile_feeds order by device_id').all<{ device_id: string }>()).results.map((r) => r.device_id);

  it('自分の行だけが消え、ほかの PC の行は残る', async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    await putFeed(pcA);
    await putFeed(pcB);
    expect(await feedRows()).toEqual(['pc-a', 'pc-b']);
    const r = await send('/m/feed', { method: 'DELETE', headers: auth(pcA) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(await feedRows()).toEqual(['pc-b']);
  });

  it('行が無くても 200（二度叩いてよい）', async () => {
    const pc = await joinPc('pc-a');
    expect((await send('/m/feed', { method: 'DELETE', headers: auth(pc) })).status).toBe(200);
    expect((await send('/m/feed', { method: 'DELETE', headers: auth(pc) })).status).toBe(200);
  });

  it('スマホのトークンは 403、トークン無しは 401', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    await putFeed(pc);
    expect((await send('/m/feed', { method: 'DELETE', headers: auth(phone.token) })).status).toBe(403);
    expect((await send('/m/feed', { method: 'DELETE' })).status).toBe(401);
    expect(await feedRows()).toEqual(['pc-a']);
  });
});
