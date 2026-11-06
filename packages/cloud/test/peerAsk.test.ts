import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveEpochKeys, MOBILE_IMAGE_MAX_BYTES, PEER_CHAT_BLOB_MAX_BYTES, PEER_CHAT_REPLY_SEALED_MAX, PEER_CHAT_SEALED_MAX, PEER_CHAT_WAIT_MAX_MS, randomEpochKey, sealPeerChatBlob } from '@agent-hangar/shared';
import { IMAGE_KEEP_MS, MAX_BLOB_BYTES, PEER_IMAGES_PER_PC, sweepOldImages } from '../src/mobileBlobs.ts';
import { MAX_PEER_ASK_BODY_BYTES, PEER_ASK_RATE } from '../src/peerAsk.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sweepOnce } from '../src/sweep.ts';
import { addPcDevice, joinPhoneDevice, startCloud, type CloudHarness } from './harness.ts';

/** 試験では、waitMs に足す余裕の 5 秒を短くする（bell の askTimeoutMs と同じ仕組み）。 */
const GRACE_MS = 300;
/** 封は不透明な文字列（`<世代>.<base64url>`）。Worker は開かない。 */
const SEALED = '1.c2VhbGVkLWNoYXQ';

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (token: string, path: string, body?: unknown) =>
  send(path, { method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const joinPc = (id: string): Promise<string> => addPcDevice(cloud.env, id);

type MfSocket = {
  accept(): void;
  send(m: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close', fn: (e: { code: number; reason: string }) => void): void;
};
type Bell = { send: (m: string) => void; next: (ms?: number) => Promise<string>; silent: (ms: number) => Promise<void>; close: () => void };

const openBell = async (token: string): Promise<Bell> => {
  const r = await send('/m/bell', { headers: { ...auth(token), upgrade: 'websocket' } });
  expect(r.status).toBe(101);
  const ws = (r as unknown as { webSocket: MfSocket | null }).webSocket!;
  ws.accept();
  const queue: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws.addEventListener('message', (e) => {
    const m = String(e.data);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = (ms = 3000) =>
    new Promise<string>((resolve, reject) => {
      const m = queue.shift();
      if (m !== undefined) return resolve(m);
      const t = setTimeout(() => reject(new Error('呼び鈴に何も届きませんでした')), ms);
      waiters.push((v) => {
        clearTimeout(t);
        resolve(v);
      });
    });
  const silent = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    expect(queue).toEqual([]);
  };
  return { send: (m) => ws.send(m), next, silent, close: () => ws.close(1000, 'bye') };
};

const askBody = (o: Record<string, unknown> = {}) => ({ askId: 'a-1', to: 'pc-b', sealed: SEALED, epoch: 1, waitMs: 0, ...o });
const peerAsk = (token: string, body: unknown) => post(token, '/peer/ask', body);

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud({ bindings: { BELL_ASK_TIMEOUT_MS: String(GRACE_MS) } });
  resetSchemaCache();
  await ensureSchema(cloud.env);
});

afterEach(async () => {
  await cloud.dispose();
});

describe('POST /peer/ask（PC から PC への会話の問い合わせ）', () => {
  it('宛先の呼び鈴に chat の枠が届き、宛先の chat-reply が頼んだ側の応答になる', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    const bell = await openBell(b);
    const pending = peerAsk(a, askBody({ epoch: 3, sealed: '3.c2VhbGVkLWNoYXQ' }));
    expect(JSON.parse(await bell.next())).toEqual({ t: 'chat', id: 'a-1', from: 'pc-a', epoch: 3, sealed: '3.c2VhbGVkLWNoYXQ' });
    bell.send(JSON.stringify({ t: 'chat-reply', id: 'a-1', from: 'pc-a', sealed: '3.cmVwbHk' }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sealed: '3.cmVwbHk' });
  });

  it('宛先がつないでいなければ、待たずにすぐ 409 offline', async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    const started = Date.now();
    const r = await peerAsk(a, askBody({ waitMs: 20_000 }));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: 'offline' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('待っている間に宛先が切れたら、待ち切らずに 409 offline', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    const bell = await openBell(b);
    const started = Date.now();
    const pending = peerAsk(a, askBody({ waitMs: 20_000 }));
    await bell.next();
    bell.close();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: 'offline' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('トークン無しは 401、スマホのトークンは 403（requireKind pc）', async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    const phone = await joinPhoneDevice(cloud, a);
    expect((await send('/peer/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(askBody()) })).status).toBe(401);
    expect((await peerAsk(phone.token, askBody())).status).toBe(403);
  });

  it('形の違う本文は 400（自分宛て、waitMs の上限超え、封の形、世代の食い違い、ID の形）', async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    const bad: Record<string, unknown>[] = [
      { to: 'pc-a' },
      { waitMs: PEER_CHAT_WAIT_MAX_MS + 1 },
      { waitMs: -1 },
      { waitMs: 1.5 },
      { sealed: 'not sealed' },
      { sealed: '' },
      { epoch: 2 },
      { epoch: 0 },
      { askId: '' },
      { askId: 'x'.repeat(65) },
      { askId: 'a/b' },
      { to: '' },
    ];
    for (const o of bad) expect((await peerAsk(a, askBody(o))).status, JSON.stringify(o)).toBe(400);
    expect((await send('/peer/ask', { method: 'POST', headers: auth(a, { 'content-type': 'application/json' }), body: '{' })).status).toBe(400);
  });

  it('本文が 96 KiB を超えたら 413、封が PEER_CHAT_SEALED_MAX を超えたら 400', async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    expect(MAX_PEER_ASK_BODY_BYTES).toBe(96 * 1024);
    const huge = await peerAsk(a, askBody({ sealed: `1.${'A'.repeat(MAX_PEER_ASK_BODY_BYTES)}` }));
    expect(huge.status).toBe(413);
    const over = await peerAsk(a, askBody({ sealed: `1.${'A'.repeat(PEER_CHAT_SEALED_MAX)}` }));
    expect(over.status).toBe(400);
  });

  it('1 PC あたり 1 分に 120 回まで。121 回目は 429 rate で、別の PC は数えない', async () => {
    const a = await joinPc('pc-a');
    const c = await joinPc('pc-c');
    await joinPc('pc-b');
    expect(PEER_ASK_RATE).toEqual({ max: 120, windowMs: 60_000 });
    for (let i = 0; i < PEER_ASK_RATE.max; i++) {
      const r = await peerAsk(a, askBody({ askId: `a-${i}` }));
      expect(r.status, `${i}`).toBe(409);
    }
    const r = await peerAsk(a, askBody({ askId: 'a-over' }));
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ reason: 'rate' });
    expect((await peerAsk(c, askBody({ askId: 'c-1' }))).status).toBe(409);
  });

  it('答えが無ければ waitMs + 余裕で 504、それより前には返らない', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    const bell = await openBell(b);
    const started = Date.now();
    const pending = peerAsk(a, askBody({ waitMs: 400 }));
    await bell.next();
    const r = await pending;
    expect(r.status).toBe(504);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400 + GRACE_MS - 50);
  });

  it('waitMs の途中で来た答えは、待ちの内なら返る', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    const bell = await openBell(b);
    const pending = peerAsk(a, askBody({ waitMs: 2_000 }));
    await bell.next();
    await new Promise((r) => setTimeout(r, 450));
    bell.send(JSON.stringify({ t: 'chat-reply', id: 'a-1', from: 'pc-a', sealed: '1.bGF0ZQ' }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sealed: '1.bGF0ZQ' });
  });

  it('答えが PEER_CHAT_REPLY_SEALED_MAX を超えたら 502', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    const bell = await openBell(b);
    const pending = peerAsk(a, askBody());
    await bell.next();
    bell.send(JSON.stringify({ t: 'chat-reply', id: 'a-1', from: 'pc-a', sealed: `1.${'A'.repeat(PEER_CHAT_REPLY_SEALED_MAX)}` }));
    const r = await pending;
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'reply too large' });
  });

  it('ほかの PC の chat-reply や、別の頼み手の from を名乗る答えは答えにならない', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    const x = await joinPc('pc-x');
    const bellB = await openBell(b);
    const bellX = await openBell(x);
    const pending = peerAsk(a, askBody());
    await bellB.next();
    await bellX.silent(50);
    bellX.send(JSON.stringify({ t: 'chat-reply', id: 'a-1', from: 'pc-a', sealed: '1.Zm9yZ2Vk' }));
    bellB.send(JSON.stringify({ t: 'chat-reply', id: 'a-1', from: 'pc-other', sealed: '1.Zm9yZ2Vk' }));
    bellB.send(JSON.stringify({ t: 'reply', id: 'a-1', sealed: '1.Zm9yZ2Vk' }));
    expect((await pending).status).toBe(504);
  });

  it('飛行中の同じ askId は 409 duplicate（宛先に二重に渡さない）', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    const bell = await openBell(b);
    const first = peerAsk(a, askBody({ waitMs: 2_000 }));
    await bell.next();
    const dup = await peerAsk(a, askBody({ waitMs: 2_000 }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ reason: 'duplicate' });
    await bell.silent(30);
    bell.send(JSON.stringify({ t: 'chat-reply', id: 'a-1', from: 'pc-a', sealed: SEALED }));
    expect((await first).status).toBe(200);
  });

  it('D1 に 1 行も増やさない（答えを返すところまで通しても、全部の表の行数が変わらない）', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    const bell = await openBell(b);
    const count = async () => {
      const tables = await cloud.env.DB.prepare("select name from sqlite_master where type = 'table'").all<{ name: string }>();
      const out: Record<string, number> = {};
      for (const { name } of tables.results) {
        if (name.startsWith('_cf') || name.startsWith('sqlite')) continue;
        out[name] = (await cloud.env.DB.prepare(`select count(*) n from "${name}"`).first<{ n: number }>())!.n;
      }
      return out;
    };
    const before = await count();
    const pending = peerAsk(a, askBody({ sealed: SEALED }));
    await bell.next();
    bell.send(JSON.stringify({ t: 'chat-reply', id: 'a-1', from: 'pc-a', sealed: '1.c2VjcmV0LXJlcGx5' }));
    expect((await pending).status).toBe(200);
    expect((await peerAsk(a, askBody({ askId: 'a-2', to: 'pc-none' }))).status).toBe(409);
    expect(await count()).toEqual(before);
  });
});

describe('/peer/blobs（PC から PC への画像）', () => {
  const bytes = (n: number, fill = 7): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(fill);
  const putBlob = (token: string, askId: string, n: number | string, to: string | null, body: Uint8Array<ArrayBuffer> | null = bytes(64)) =>
    send(`/peer/blobs/${askId}/${n}${to === null ? '' : `?to=${encodeURIComponent(to)}`}`, {
      method: 'PUT',
      headers: auth(token, { 'content-type': 'application/octet-stream', 'content-length': String(body?.byteLength ?? 0) }),
      ...(body ? { body } : {}),
    });
  const getBlob = (token: string, askId: string, n: number | string, from: string | null) =>
    send(`/peer/blobs/${askId}/${n}${from === null ? '' : `?from=${encodeURIComponent(from)}`}`, { headers: auth(token) });
  const keys = async (prefix: string) => (await cloud.env.BUCKET.list({ prefix })).objects.map((o) => o.key).sort();

  it('送り手が置き、宛先だけが同じバイト列を読める', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    const body = Uint8Array.from({ length: 100 }, (_, i) => i);
    expect((await putBlob(a, 'a-1', 2, 'pc-b', body)).status).toBe(201);
    const r = await getBlob(b, 'a-1', 2, 'pc-a');
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(body);
  });

  it('宛先でない PC と送り手自身は読めず（404）、中身は R2 に封のまま 1 つだけ置かれる', async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    const x = await joinPc('pc-x');
    expect((await putBlob(a, 'a-1', 0, 'pc-b')).status).toBe(201);
    expect((await getBlob(x, 'a-1', 0, 'pc-a')).status).toBe(404);
    expect((await getBlob(a, 'a-1', 0, 'pc-a')).status).toBe(404);
    expect((await keys('')).filter((k) => k.includes('a-1'))).toHaveLength(1);
  });

  it('スマホのトークンは置くのも読むのも 403、トークン無しは 401', async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    const phone = await joinPhoneDevice(cloud, a);
    expect((await putBlob(phone.token, 'a-1', 0, 'pc-b')).status).toBe(403);
    expect((await getBlob(phone.token, 'a-1', 0, 'pc-a')).status).toBe(403);
    expect((await send('/peer/blobs/a-1/0?from=pc-a')).status).toBe(401);
  });

  it('n、askId、to、from の形が違えば 400（to が無い、自分宛て、スラッシュ、先頭のドットを含む）', async () => {
    const a = await joinPc('pc-a');
    const b = await joinPc('pc-b');
    for (const n of ['4', '-1', '1.5', 'a', '01']) expect((await putBlob(a, 'a-1', n, 'pc-b')).status, `n=${n}`).toBe(400);
    expect((await putBlob(a, 'x'.repeat(65), 0, 'pc-b')).status).toBe(400);
    expect((await putBlob(a, '.hidden', 0, 'pc-b')).status).toBe(400);
    expect((await putBlob(a, 'a-1', 0, null)).status).toBe(400);
    expect((await putBlob(a, 'a-1', 0, 'pc-a')).status).toBe(400);
    expect((await putBlob(a, 'a-1', 0, '../x')).status).toBe(400);
    expect((await getBlob(b, 'a-1', 0, null)).status).toBe(400);
    expect((await getBlob(b, 'a-1', 9, 'pc-a')).status).toBe(400);
    expect(await keys('')).toEqual([]);
  });

  it('上限は 5 MiB + 封の 32 バイト（世代 4、IV 12、タグ 16）。最大の画像の封は置け、超える名乗りは 413、長さの無い本文は 411', async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    expect(PEER_CHAT_BLOB_MAX_BYTES).toBe(MOBILE_IMAGE_MAX_BYTES + 32);
    // スマホの上限（28 バイト）は変えない。
    expect(MAX_BLOB_BYTES).toBe(MOBILE_IMAGE_MAX_BYTES + 28);
    // 実際に封じた最大の画像（sealPeerChatBlob）の大きさで置く。
    const keys = await deriveEpochKeys(1, randomEpochKey());
    const ring = { current: () => keys, at: () => keys };
    const sealedMax = await sealPeerChatBlob(ring, { requestId: 'a-1', from: 'pc-a', to: 'pc-b' }, 0, new Uint8Array(MOBILE_IMAGE_MAX_BYTES));
    expect(sealedMax.byteLength).toBe(PEER_CHAT_BLOB_MAX_BYTES);
    expect(sealedMax.byteLength).toBeGreaterThan(MAX_BLOB_BYTES);
    expect((await putBlob(a, 'a-1', 0, 'pc-b', sealedMax as Uint8Array<ArrayBuffer>)).status).toBe(201);
    const big = await send('/peer/blobs/a-1/1?to=pc-b', {
      method: 'PUT',
      headers: auth(a, { 'content-type': 'application/octet-stream', 'content-length': String(PEER_CHAT_BLOB_MAX_BYTES + 1) }),
      body: new ReadableStream({ start: (c) => c.enqueue(bytes(16)) }),
      duplex: 'half',
    } as RequestInit);
    expect(big.status).toBe(413);
    expect((await send('/peer/blobs/a-1/2?to=pc-b', { method: 'PUT', headers: auth(a), body: bytes(8) })).status).toBe(411);
    expect((await putBlob(a, 'a-1', 3, 'pc-b', null)).status).toBe(400);
  });

  it(`置いたままが ${PEER_IMAGES_PER_PC} 枚になったら新しい鍵は 429、置き直しは通る`, async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    for (let i = 0; i < PEER_IMAGES_PER_PC; i++) {
      expect((await putBlob(a, `a-${Math.floor(i / 4)}`, i % 4, 'pc-b', bytes(8))).status, `${i}`).toBe(201);
    }
    expect((await putBlob(a, 'a-over', 0, 'pc-b', bytes(8))).status).toBe(429);
    expect((await putBlob(a, 'a-0', 0, 'pc-b', bytes(9))).status).toBe(201);
  });

  it('24 時間より古い画像は、送り手の掃除でも定期の掃除（sweepOnce）でも消える。新しいものは残る', async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    expect((await putBlob(a, 'a-1', 0, 'pc-b')).status).toBe(201);
    const t0 = Date.now();
    expect(await sweepOldImages(cloud.env.BUCKET, 'pc-a', t0 + IMAGE_KEEP_MS - 60_000)).toBe(0);
    expect(await sweepOldImages(cloud.env.BUCKET, 'pc-a', t0 + IMAGE_KEEP_MS + 60_000)).toBe(1);
    expect((await putBlob(a, 'a-2', 0, 'pc-b')).status).toBe(201);
    expect((await keys('')).length).toBe(1);
    await sweepOnce(cloud.env, t0 + IMAGE_KEEP_MS + 120_000);
    expect(await keys('')).toEqual([]);
  });

  it('スマホの画像の口（/m/blobs）とは混ざらない（PC のトークンは /m/blobs に置けない）', async () => {
    const a = await joinPc('pc-a');
    await joinPc('pc-b');
    const phone = await joinPhoneDevice(cloud, a);
    expect((await putBlob(a, 'l-1', 0, 'pc-b')).status).toBe(201);
    const r = await send('/m/blobs/l-1/0', { method: 'PUT', headers: auth(phone.token, { 'content-type': 'application/octet-stream', 'content-length': '4' }), body: bytes(4) });
    expect(r.status).toBe(201);
    expect(await keys('')).toHaveLength(2);
    expect((await send('/m/blobs/l-1/1', { method: 'PUT', headers: auth(a, { 'content-length': '4' }), body: bytes(4) })).status).toBe(403);
  });
});
