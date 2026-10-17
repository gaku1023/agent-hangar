import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOUD_HEADERS, MAX_SEALED_META_CHARS, isBlobKey, type SealedFileEntry } from '@agent-hangar/shared';
import { MAX_BODY_BYTES, validKey } from '../src/files.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { addPcDevice, startCloud, type CloudHarness } from './harness.ts';

let cloud: CloudHarness;
let tokA = '';
let tokB = '';

/** R2 の鍵名。本物は `b/<端末 ID>/<HMAC の base64url（43 字）>` なので、同じ形の作り物にする。 */
const blobKey = (device: string, name: string): string => `b/${device}/${`h${name}`.padEnd(43, '_')}`;
const KA = (name: string): string => blobKey('dev-a', name);
const KB = (name: string): string => blobKey('dev-b', name);

/** 封じたメタの代わり。Worker は開かないので、base64url の文字列なら何でもよい。 */
const SEALED_META = Buffer.from('sealed-meta').toString('base64url');

/** 既定は transcript 1 件分の見出しである。上書きしたい分だけ渡す。 */
const meta = (o: Record<string, string> = {}): Record<string, string> => ({
  [CLOUD_HEADERS.kind]: 'transcript',
  [CLOUD_HEADERS.size]: '3',
  [CLOUD_HEADERS.epoch]: '1',
  [CLOUD_HEADERS.meta]: SEALED_META,
  ...o,
});

const put = (tok: string, key: string, body: string, headers: Record<string, string> = meta()): Promise<Response> =>
  cloud.SELF.fetch(`https://x/files/${key}`, {
    method: 'PUT',
    // miniflare の dispatchFetch は本文の長さを付けずに流すので、端末と同じく明示する。
    headers: { authorization: `Bearer ${tok}`, 'content-length': String(new TextEncoder().encode(body).length), ...headers },
    body,
  });

const get = (tok: string, key: string): Promise<Response> => cloud.SELF.fetch(`https://x/files/${key}`, { headers: { authorization: `Bearer ${tok}` } });

type Listing = { files: SealedFileEntry[]; nextSeq: number; more: boolean };

const list = async (tok: string, since = 0, limit = 500): Promise<Listing> =>
  (await (await cloud.SELF.fetch(`https://x/files?since=${since}&limit=${limit}`, { headers: { authorization: `Bearer ${tok}` } })).json()) as Listing;

const keysInR2 = async (): Promise<string[]> => (await cloud.env.BUCKET.list()).objects.map((o) => o.key).sort();

/** 位置から中身が決まるバイト列。取り出した側で 1 バイトずつ突き合わせられる。 */
const patterned = (n: number): Uint8Array<ArrayBuffer> => {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = i % 251;
  return buf;
};

const expectPatterned = async (key: string, n: number): Promise<void> => {
  const g = await get(tokA, key);
  expect(g.headers.get('content-length')).toBe(String(n));
  const back = new Uint8Array(await g.arrayBuffer());
  expect(back.length).toBe(n);
  expect(back.every((v, i) => v === i % 251)).toBe(true);
};

/** n バイトの 0 を流す。同じ塊を使い回すので、記憶に載るのは 1 MiB だけである。 */
const zeros = (n: number): ReadableStream<Uint8Array> => {
  const block = new Uint8Array(1024 * 1024);
  let left = n;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (left <= 0) return ctrl.close();
      const k = Math.min(left, block.length);
      ctrl.enqueue(k === block.length ? block : block.subarray(0, k));
      left -= k;
    },
  });
};

/** 長さを名乗らない本文。fetch は content-length を付けず chunked で送る。 */
const chunked = (buf: Uint8Array, piece = 64 * 1024): ReadableStream<Uint8Array> => {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (at >= buf.length) return ctrl.close();
      ctrl.enqueue(buf.slice(at, at + piece));
      at += piece;
    },
  });
};

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  tokA = await addPcDevice(cloud.env, 'dev-a');
  tokB = await addPcDevice(cloud.env, 'dev-b');
});

afterEach(async () => {
  await cloud.dispose();
});

/**
 * 本文を読まずに断る応答で、送る側の接続が途中で切れたか。
 * miniflare の undici が投げる TypeError は別の領域のものなので、instanceof ではなく文言で見分ける。
 * 応答の前に切れると "fetch failed"（原因は EPIPE か ECONNRESET）、応答の本文の途中で切れると "terminated" になる。
 * Windows では、包まれずに ECONNRESET の系の誤りそのものが届くこともある。
 */
function cutOff(e: unknown): boolean {
  const CODES = ['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET'];
  const err = e as { message?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  if (err?.message === 'terminated') return true;
  if (err?.message === 'fetch failed' && CODES.includes(String(err.cause?.code))) return true;
  return CODES.includes(String(err?.code));
}

describe('PUT と GET /files/<key>（封じたメタ）', () => {
  it('R2 に置き、索引に封じたメタを載せ、本体を取り出せる', async () => {
    const key = KA('u1');
    expect(isBlobKey(key)).toBe(true);
    const r = await put(tokA, key, 'abc', meta({ [CLOUD_HEADERS.epoch]: '4' }));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ seq: 1 });
    expect(await (await cloud.env.BUCKET.get(key))!.text()).toBe('abc');
    const l = await list(tokB);
    expect(l.files).toHaveLength(1);
    expect(l.files[0]).toEqual({
      seq: 1,
      key,
      kind: 'transcript',
      deviceId: 'dev-a',
      size: 3,
      storedSize: 3,
      epoch: 4,
      sealedMeta: SEALED_META,
      uploadedAt: expect.any(Number),
    });
    expect(l.files[0]!.uploadedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(l).toMatchObject({ nextSeq: 1, more: false });
    const g = await get(tokB, key);
    expect(g.status).toBe(200);
    expect(g.headers.get('content-length')).toBe('3');
    expect(await g.text()).toBe('abc');
  });

  it('パスも SHA-256 も平文で残さない（R2 の覚え書きにも D1 の列にも）', async () => {
    const key = KA('u1');
    await put(tokA, key, 'abc');
    const head = await cloud.env.BUCKET.head(key);
    expect(head!.customMetadata ?? {}).toEqual({});
    const row = await cloud.env.DB.prepare('select * from files').first<Record<string, unknown>>();
    expect(Object.keys(row!).sort()).toEqual(['device_id', 'epoch', 'key', 'kind', 'sealed_meta', 'seq', 'size', 'stored_size', 'uploaded_at']);
    // 封じたメタはバイト列の BLOB で持つ。
    expect(await cloud.env.DB.prepare('select typeof(sealed_meta) t, hex(sealed_meta) h from files').first()).toEqual({ t: 'blob', h: Buffer.from('sealed-meta').toString('hex').toUpperCase() });
  });

  it('同じ鍵を置き直すと新しい seq になり、古い索引は消える', async () => {
    const key = KA('u1');
    await put(tokA, key, 'abc');
    await put(tokA, key, 'abcd', meta({ [CLOUD_HEADERS.size]: '4', [CLOUD_HEADERS.meta]: 'bmV3' }));
    const l = await list(tokB);
    expect(l.files.map((f) => [f.seq, f.sealedMeta, f.storedSize])).toEqual([[2, 'bmV3', 4]]);
    expect((await list(tokB, 1)).files.map((f) => f.seq)).toEqual([2]);
    expect(await (await cloud.env.BUCKET.get(key))!.text()).toBe('abcd');
  });

  it('一覧は自端末の分も返し、limit と more を持つ', async () => {
    for (let i = 0; i < 3; i++) await put(tokA, KA(`u${i}`), 'x', meta({ [CLOUD_HEADERS.size]: '1' }));
    const r = await list(tokA, 0, 2);
    expect(r.files.map((f) => f.seq)).toEqual([1, 2]);
    expect(r).toMatchObject({ nextSeq: 2, more: true });
    const r2 = await list(tokA, 2, 2);
    expect(r2.files.map((f) => f.seq)).toEqual([3]);
    expect(r2).toMatchObject({ nextSeq: 3, more: false });
  });

  it('config も同じ形の鍵で置ける', async () => {
    expect((await put(tokA, KA('c1'), 'x', meta({ [CLOUD_HEADERS.kind]: 'config', [CLOUD_HEADERS.size]: '1' }))).status).toBe(201);
    expect((await list(tokB)).files.map((f) => [f.key, f.kind])).toEqual([[KA('c1'), 'config']]);
  });

  it('長さの分かっている本文は、1 つの部分を超えてもそのまま預け、そのまま取り出せる', async () => {
    const n = 9 * 1024 * 1024 + 7; // かつて multipart に切り替えていた 8 MiB を超え、端数も出る大きさ
    const buf = patterned(n);
    const key = KA('big');
    const r = await cloud.SELF.fetch(`https://x/files/${key}`, {
      method: 'PUT',
      // miniflare の dispatchFetch はバイト列の本文でも長さを付けずに流すので、端末と同じく明示する。
      headers: { authorization: `Bearer ${tokA}`, ...meta({ [CLOUD_HEADERS.size]: String(n) }), 'content-length': String(n) },
      body: buf,
    });
    expect(r.status).toBe(201);
    expect((await list(tokA)).files.map((f) => f.storedSize)).toEqual([n]);
    await expectPatterned(key, n);
    // 分けずに 1 回の put で置いた印である（multipart の etag は「-部分の数」で終わる）。
    // Worker が本文を JS で読んで切り分けていないことを、外から見える形で確かめる。
    expect((await cloud.env.BUCKET.head(key))!.etag).not.toContain('-');
  });

  it('長さを名乗らない本文は、411 で断り、R2 にも索引にも残さない', async () => {
    const buf = patterned(256 * 1024);
    // 413 と同じく、Worker は本文を読まずに断る。Windows では送る側がまだ書いている途中に接続が切れ、ECONNRESET で投げることがある。
    let status: number | null = null;
    let body: unknown = null;
    try {
      const r = await cloud.SELF.fetch(`https://x/files/${KA('u1')}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${tokA}`, ...meta({ [CLOUD_HEADERS.size]: String(buf.length) }) },
        body: chunked(buf),
        duplex: 'half',
      } as RequestInit);
      status = r.status;
      body = await r.json();
    } catch (e) {
      if (!cutOff(e)) throw e;
    }
    if (status !== null) expect(status).toBe(411);
    if (body !== null) expect(body).toEqual({ error: 'length required' });
    expect(await keysInR2()).toEqual([]);
    expect((await list(tokA)).files).toEqual([]);
  });

  it('上限を超える長さを名乗った本文は、読む前に 413 で断り、R2 にも索引にも残さない', async () => {
    const key = KA('huge');
    // Worker は本文を読まずに断って接続を閉じる。送る側がまだ本文を書いている途中だと、書き込みが EPIPE で倒れ、
    // 応答を受け取る前か、応答の本文を読む途中で、fetch が "terminated" で投げることがある。
    // macOS では全体の試験の負荷で時々、Windows では毎回そうなる。どこまで読めたかにかかわらず、断ったこと自体は下の「残さない」で確かめられる。
    let status: number | null = null;
    let body: unknown = null;
    try {
      const r = await cloud.SELF.fetch(`https://x/files/${key}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${tokA}`, ...meta(), 'content-length': String(MAX_BODY_BYTES + 1) },
        // 名乗った長さどおりに流す（食い違うと送る側の undici が先に倒れる）。中身は 1 つの塊を使い回す。
        body: zeros(MAX_BODY_BYTES + 1),
        duplex: 'half',
      } as RequestInit);
      status = r.status;
      body = await r.json();
    } catch (e) {
      if (!cutOff(e)) throw e;
    }
    if (status !== null) expect(status).toBe(413);
    if (body !== null) expect(body).toEqual({ error: 'too large' });
    expect(await keysInR2()).toEqual([]);
    expect((await list(tokA)).files).toEqual([]);
  });

  it('無い鍵は 404。/files に本文を消す経路は無い', async () => {
    expect((await get(tokA, KA('nope'))).status).toBe(404);
    await put(tokA, KA('u1'), 'abc');
    const d = await cloud.SELF.fetch(`https://x/files/${KA('u1')}`, { method: 'DELETE', headers: { authorization: `Bearer ${tokA}` } });
    expect(d.status).toBe(404);
    expect(await keysInR2()).toEqual([KA('u1')]);
  });
});

describe('GET /files?since=', () => {
  it('でたらめに大きい since を nextSeq にそのまま返さない', async () => {
    // 返すと、端末が一度でも壊れた since を控えた時点で一覧が永久に空になる。
    // `/changes`（packages/cloud/src/changes.ts）は既にこの形で、ここだけが非対称だった。
    await put(tokA, KA('u1'), 'abc');
    expect(await list(tokB, 999_999)).toEqual({ files: [], nextSeq: 1, more: false });
  });

  it('桁あふれした since は 0 として読む（数えられない値で読み位置を固めない）', async () => {
    await put(tokA, KA('u1'), 'abc');
    for (const since of ['1e21', 'Infinity', '-1', 'abc', '1.5']) {
      const r = (await (await cloud.SELF.fetch(`https://x/files?since=${since}`, { headers: { authorization: `Bearer ${tokB}` } })).json()) as Listing;
      expect([since, r.files.map((f) => f.seq), r.nextSeq]).toEqual([since, [1], 1]);
    }
  });

  it('索引が空なら nextSeq は 0 である', async () => {
    expect(await list(tokB, 5)).toEqual({ files: [], nextSeq: 0, more: false });
  });
});

describe('鍵と見出しの検査', () => {
  it('b/ の形でない鍵は 400 で、R2 にも索引にも残らない（平文の鍵名は受けない）', async () => {
    for (const key of [
      'transcripts/dev-a/u1.jsonl.gz',
      'config/dev-a/skills/a.md',
      'b/dev-a',
      'b/dev-a/short',
      `b/dev-a/${'h'.padEnd(44, '_')}`,
      `b/dev-a/${'h'.padEnd(42, '_')}=`,
      `b/dev.a/${'h'.padEnd(43, '_')}`,
      `b/dev-a/x/${'h'.padEnd(43, '_')}`,
    ])
      expect([key, (await put(tokA, key, 'x')).status]).toEqual([key, 400]);
    expect(await keysInR2()).toEqual([]);
    expect((await list(tokA)).files).toEqual([]);
  });

  it('見出しが欠けていたり形が違えば 400', async () => {
    const key = KA('u1');
    const bad: [string, Record<string, string>][] = [
      ['kind', meta({ [CLOUD_HEADERS.kind]: 'video' })],
      ['size -1', meta({ [CLOUD_HEADERS.size]: '-1' })],
      ['size 1.5', meta({ [CLOUD_HEADERS.size]: '1.5' })],
      ['epoch 0', meta({ [CLOUD_HEADERS.epoch]: '0' })],
      ['epoch x', meta({ [CLOUD_HEADERS.epoch]: 'x' })],
      ['meta empty', meta({ [CLOUD_HEADERS.meta]: '' })],
      ['meta base64', meta({ [CLOUD_HEADERS.meta]: 'a+b/c=' })],
      ['meta long', meta({ [CLOUD_HEADERS.meta]: 'A'.repeat(MAX_SEALED_META_CHARS + 1) })],
    ];
    for (const [name, h] of bad) expect([name, (await put(tokA, key, 'x', h)).status]).toEqual([name, 400]);
    for (const drop of [CLOUD_HEADERS.kind, CLOUD_HEADERS.size, CLOUD_HEADERS.epoch, CLOUD_HEADERS.meta]) {
      const h = meta();
      delete h[drop];
      expect([drop, (await put(tokA, key, 'x', h)).status]).toEqual([drop, 400]);
    }
    expect(await keysInR2()).toEqual([]);
  });

  it('上限いっぱいの封じたメタは通る', async () => {
    expect((await put(tokA, KA('u1'), 'x', meta({ [CLOUD_HEADERS.meta]: 'A'.repeat(MAX_SEALED_META_CHARS) }))).status).toBe(201);
  });
});

describe('端末の境目', () => {
  it('b/<他人>/ への PUT は 403 で、読むのは誰でもよい', async () => {
    await put(tokA, KA('u1'), 'abc');
    expect((await put(tokB, KA('u1'), 'evil')).status).toBe(403);
    expect((await put(tokB, KA('new'), 'evil')).status).toBe(403);
    // 断られた書き込みは R2 にも索引にも入っていない。
    expect(await keysInR2()).toEqual([KA('u1')]);
    expect(await (await cloud.env.BUCKET.get(KA('u1')))!.text()).toBe('abc');
    expect((await list(tokB)).files.map((f) => f.seq)).toEqual([1]);
    expect(await (await get(tokB, KA('u1'))).text()).toBe('abc');
    // 自分の下には書ける。
    expect((await put(tokB, KB('u1'), 'mine')).status).toBe(201);
  });

  it('「..」で他端末の接頭辞へ抜けられない', async () => {
    // 「..」は URL の側で畳まれて `b/dev-b/...` として届く。そこで権限に当たって断られる。
    const tail = 'h'.padEnd(43, '_');
    for (const key of [`b/dev-a/../dev-b/${tail}`, `b/dev-a/%2e%2e/dev-b/${tail}`])
      expect([key, (await put(tokA, key, 'x')).status]).toEqual([key, 403]);
    expect(await keysInR2()).toEqual([]);
  });

  it('validKey は鍵の形と自端末の接頭辞を見る', () => {
    expect(validKey(KA('u1'), 'dev-a', 'PUT')).toBe(true);
    expect(validKey(KA('u1'), 'dev-b', 'PUT')).toBe(false);
    expect(validKey(KA('u1'), 'dev-b', 'GET')).toBe(true);
    // 前方一致だけで見ると、dev-a が dev-ab の下に書けてしまう。
    expect(validKey(blobKey('dev-ab', 'u1'), 'dev-a', 'PUT')).toBe(false);
    expect(validKey('transcripts/dev-a/u1.jsonl.gz', 'dev-a', 'GET')).toBe(false);
  });

  it('認証が無ければ files と blobs のどの経路も 401', async () => {
    for (const init of [
      { method: 'GET', path: 'https://x/files?since=0' },
      { method: 'GET', path: `https://x/files/${KA('u1')}` },
      { method: 'PUT', path: `https://x/files/${KA('u1')}` },
      { method: 'DELETE', path: 'https://x/blobs' },
    ]) {
      const r = await cloud.SELF.fetch(init.path, { method: init.method, headers: meta(), body: init.method === 'PUT' ? 'x' : undefined });
      expect([init.path, r.status]).toEqual([init.path, 401]);
    }
    expect(await keysInR2()).toEqual([]);
  });
});

describe('例外の覆い', () => {
  it('中で倒れても文言を外に出さず、秘密も漏らさない', async () => {
    await put(tokA, KA('u1'), 'abc'); // ここでスキーマの用意が済む
    await cloud.env.DB.prepare('drop table files').run();
    const r = await put(tokA, KA('u2'), 'abc');
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toContain('files');
    expect(text).not.toContain('no such table');
    expect(text).not.toContain(tokA);
  });
});
