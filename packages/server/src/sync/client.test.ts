import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CloudError, goneFloor, HttpCloudClient } from './client.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (c: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input), init: init ?? {} };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref(); });

/**
 * 終わらない本体。
 * 少しずつバイトを垂らし続けるので、undici の bodyTimeout は毎回振り出しに戻る。
 * 全体の締め切りが無いと永久に読み続けることになる。
 */
function dripStream(): ReadableStream<Uint8Array> {
  let stopped = false;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      await sleep(5);
      if (stopped) return;
      ctrl.enqueue(new TextEncoder().encode('{'));
    },
    cancel() { stopped = true; },
  });
}

/**
 * 要求ヘッダを形で比べるための覆い。
 * Bearer の値は伏せ字にするので、テストが落ちても端末トークンが差分に出ない。
 */
function headersOf(c: Call): Record<string, string> {
  const h = { ...((c.init.headers as Record<string, string> | undefined) ?? {}) };
  if (typeof h.authorization === 'string') h.authorization = 'Bearer ***';
  return h;
}

/** Bearer の中身は真偽だけを見る。こちらも失敗時に値が出ない。 */
function bearerIs(c: Call, token: string): boolean {
  return ((c.init.headers as Record<string, string> | undefined) ?? {}).authorization === `Bearer ${token}`;
}

describe('HttpCloudClient', () => {
  it('Bearer を付け、URL の末尾のスラッシュを整える', async () => {
    const { fetch, calls } = fakeFetch(() => json({ ok: true, version: '0.4.0' }));
    const c = new HttpCloudClient({ url: 'https://h.example.workers.dev/', token: 'tok', fetch });
    expect(await c.health()).toEqual({ ok: true, version: '0.4.0' });
    expect(calls[0]!.url).toBe('https://h.example.workers.dev/health');
    expect(headersOf(calls[0]!).authorization).toBe('Bearer ***');
    expect(bearerIs(calls[0]!, 'tok')).toBe(true);
    // 伏せ字の検査が素通りでないことを確かめる。
    expect(bearerIs(calls[0]!, 'other')).toBe(false);
  });

  it('pushChanges と pullChanges と snapshot', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.includes('/rows')
        ? json({ changes: [], nextAfter: null, seq: 7 })
        : c.init.method === 'POST'
          ? json({ seq: 3, accepted: 1, skipped: 0 })
          : json({ changes: [], nextSeq: 3, more: false }),
    );
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    const ch = { tableName: 'projects' as const, rowId: 'p1', op: 'upsert' as const, payload: { id: 'p1' }, updatedAt: 1 };
    expect(await c.pushChanges([ch])).toEqual({ seq: 3, accepted: 1, skipped: 0 });
    expect(calls[0]!.url).toBe('https://h/changes');
    expect(calls[0]!.init.method).toBe('POST');
    expect(headersOf(calls[0]!)['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ changes: [ch] });
    await c.pullChanges(5, 100);
    expect(calls[1]!.url).toBe('https://h/changes?since=5&limit=100');
    await c.snapshot('projects:p1', 50);
    expect(calls[2]!.url).toBe('https://h/rows?after=projects%3Ap1&limit=50');
    await c.snapshot(null, 50);
    expect(calls[3]!.url).toBe('https://h/rows?after=&limit=50');
  });

  it('listFiles と deleteFile', async () => {
    const { fetch, calls } = fakeFetch((c) => (c.init.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ files: [], nextSeq: 4, more: false })));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    expect(await c.listFiles(4, 500)).toEqual({ files: [], nextSeq: 4, more: false });
    expect(calls[0]!.url).toBe('https://h/files?since=4&limit=500');
    await c.deleteFile('transcripts/d/u.jsonl.gz');
    expect(calls[1]!.url).toBe('https://h/files/transcripts/d/u.jsonl.gz');
    expect(calls[1]!.init.method).toBe('DELETE');
    expect(bearerIs(calls[1]!, 't')).toBe(true);
  });

  it('putFile はヘッダとストリーム本文を送り、getFile は Readable を返す', async () => {
    let uploaded = '';
    const { fetch, calls } = fakeFetch(async (c) => {
      if (c.init.method === 'PUT') {
        uploaded = await new Response(c.init.body as ReadableStream).text();
        // 応答に余計な項目があっても seq だけを返す。
        return json({ seq: 9, echoed: uploaded }, 201);
      }
      return new Response('payload', { status: 200 });
    });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    const r = await c.putFile(
      { key: 'transcripts/d/u.jsonl.gz', path: 'projects/-x/u.jsonl', kind: 'transcript', sha256: 'a'.repeat(64), size: 3, mtime: 5, encrypted: true },
      Readable.from([Buffer.from('ab'), Buffer.from('c')]),
    );
    expect(r).toEqual({ seq: 9 });
    expect(uploaded).toBe('abc');
    const h = headersOf(calls[0]!);
    expect(calls[0]!.url).toBe('https://h/files/transcripts/d/u.jsonl.gz');
    expect(h['x-hangar-path']).toBe('projects/-x/u.jsonl');
    expect(h['x-hangar-kind']).toBe('transcript');
    expect(h['x-hangar-sha256']).toBe('a'.repeat(64));
    expect(h['x-hangar-size']).toBe('3');
    expect(h['x-hangar-mtime']).toBe('5');
    expect(h['x-hangar-encrypted']).toBe('1');
    expect(h['content-type']).toBe('application/octet-stream');
    expect((calls[0]!.init as { duplex?: string }).duplex).toBe('half');
    const body = await c.getFile('transcripts/d/u.jsonl.gz');
    let text = '';
    for await (const ch of body) text += ch;
    expect(text).toBe('payload');
  });

  it('2xx 以外は CloudError、接続失敗は status 0', async () => {
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(() => new Response('unauthorized', { status: 401 })).fetch });
    await expect(c.health()).rejects.toMatchObject({ status: 401, message: expect.stringContaining('unauthorized') });
    const down = new HttpCloudClient({ url: 'https://h', token: 't', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(down.health()).rejects.toBeInstanceOf(CloudError);
    await expect(down.health()).rejects.toMatchObject({ status: 0 });
  });

  it('本文は 200 字で切り、空なら状態番号だけを載せる', async () => {
    const long = new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(() => new Response('x'.repeat(500), { status: 500 })).fetch });
    await expect(long.health()).rejects.toMatchObject({ status: 500, message: 'x'.repeat(200) });
    const empty = new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(() => new Response('', { status: 502 })).fetch });
    await expect(empty.health()).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
  });

  it('client を書き出してもトークンが読めない', () => {
    // フェーズ 3 の安全監査の宿題。うっかり console.log(client) しても端末トークンが出ないようにする。
    const secret = 'device-token-must-not-leak';
    const c = new HttpCloudClient({ url: 'https://h', token: secret, fetch: fakeFetch(() => json({})).fetch });
    expect(JSON.stringify(c)).not.toContain(secret);
    expect(inspect(c, { depth: 5 })).not.toContain(secret);
    expect(String(Object.values(c))).not.toContain(secret);
  });

  it('goneFloor は 410 の { error: gone, floor } だけを読む', async () => {
    const gone = new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(() => json({ error: 'gone', floor: 12 }, 410)).fetch });
    const e = await gone.pullChanges(3, 500).catch((x: unknown) => x);
    expect(goneFloor(e)).toBe(12);
    expect(goneFloor(new CloudError(410, 'nonsense'))).toBe(null);
    expect(goneFloor(new CloudError(404, JSON.stringify({ error: 'gone', floor: 1 })))).toBe(null);
    expect(goneFloor(new Error('boom'))).toBe(null);
  });

  it('GET には content-type を付けない', async () => {
    const { fetch, calls } = fakeFetch(() => json({ ok: true, version: '1' }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await c.health();
    expect(headersOf(calls[0]!)['content-type']).toBeUndefined();
  });

  it('鍵の形が違えば fetch に出る前に 400 で断る', async () => {
    const { fetch, calls } = fakeFetch(() => json({ seq: 1 }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await expect(c.getFile('other/u1')).rejects.toMatchObject({ status: 400 });
    await expect(c.getFile('transcripts/d/../e/u1')).rejects.toMatchObject({ status: 400 });
    await expect(c.getFile('transcripts/d/u 1.gz')).rejects.toMatchObject({ status: 400 });
    await expect(c.deleteFile('transcripts/d/u?x=1')).rejects.toMatchObject({ status: 400 });
    await expect(c.putFile({ key: 'config/../x', path: 'x', kind: 'config', sha256: 'a'.repeat(64), size: 1, mtime: 1, encrypted: false }, Readable.from([Buffer.from('x')]))).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it('2xx の本文が読めなければ CloudError(0) にする', async () => {
    const broken = () => new Response(new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode('{"a"')); ctrl.error(new Error('接続が切れた')); } }), { status: 200 });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(broken).fetch });
    const e1 = await c.health().catch((x: unknown) => x);
    expect(e1).toBeInstanceOf(CloudError);
    expect(e1).toMatchObject({ status: 0 });
    const html = new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(() => new Response('<html>Cloudflare</html>', { status: 200 })).fetch });
    const e2 = await html.health().catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(CloudError);
    expect(e2).toMatchObject({ status: 0 });
  });

  it('getFile の本体が途中で切れたら CloudError(0) にする', async () => {
    const broken = () => new Response(new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode('ab')); ctrl.error(new Error('接続が切れた')); } }), { status: 200 });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(broken).fetch });
    const body = await c.getFile('transcripts/d/u.jsonl.gz');
    const e = await (async () => { for await (const _ of body) { /* 読み切る */ } })().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ status: 0 });
  });

  it('応答が返らない要求は時間切れで CloudError(0) にする', async () => {
    const { fetch, calls } = fakeFetch(() => new Promise<Response>(() => {}));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', timeoutMs: 20, fetch });
    const e = await c.pullChanges(0, 500).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ status: 0 });
    expect((e as CloudError).message).toContain('timeout');
    // fetch にも signal を渡すので、本物の undici は socket ごと切れる。
    const signal = (calls[0]!.init as { signal?: AbortSignal }).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(true);
  });

  it('本文が垂れ続けるだけの応答も時間切れで切る', async () => {
    const drip = () => new Response(dripStream(), { status: 200 });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', timeoutMs: 30, fetch: fakeFetch(drip).fetch });
    const e = await c.listFiles(0, 500).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ status: 0 });
    expect((e as CloudError).message).toContain('timeout');
  });

  it('putFile と getFile は転送用の長い時間切れを使う', async () => {
    const hang = new HttpCloudClient({ url: 'https://h', token: 't', transferTimeoutMs: 20, fetch: fakeFetch(() => new Promise<Response>(() => {})).fetch });
    const up = await hang.putFile({ key: 'transcripts/d/u.jsonl.gz', path: 'p/u.jsonl', kind: 'transcript', sha256: 'a'.repeat(64), size: 1, mtime: 1, encrypted: true }, Readable.from([Buffer.from('x')])).catch((x: unknown) => x);
    expect(up).toMatchObject({ status: 0 });
    expect((up as CloudError).message).toContain('timeout');
    const c = new HttpCloudClient({ url: 'https://h', token: 't', transferTimeoutMs: 30, fetch: fakeFetch(() => new Response(dripStream(), { status: 200 })).fetch });
    const body = await c.getFile('transcripts/d/u.jsonl.gz');
    const e = await (async () => { for await (const _ of body) { /* 垂れ続ける */ } })().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ status: 0 });
    expect((e as CloudError).message).toContain('timeout');
  });

  it('時間切れは小さい応答と転送で別に持てる', async () => {
    // 小さい応答の時間切れを短くしても、転送はその値に引きずられない。
    const c = new HttpCloudClient({ url: 'https://h', token: 't', timeoutMs: 15, transferTimeoutMs: 2000, fetch: fakeFetch(async () => { await sleep(60); return json({ seq: 1 }, 201); }).fetch });
    await expect(c.health()).rejects.toMatchObject({ status: 0 });
    expect(await c.putFile({ key: 'transcripts/d/u.jsonl.gz', path: 'p/u.jsonl', kind: 'transcript', sha256: 'a'.repeat(64), size: 1, mtime: 1, encrypted: true }, Readable.from([Buffer.from('x')]))).toEqual({ seq: 1 });
  });

  it('無事に終わった要求は見張りのタイマーを残さない', async () => {
    // 5 分のタイマーが残ると vitest が終われない。終わった要求の分だけ増えていないことを見る。
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(() => json({ ok: true, version: '1' })).fetch });
    await c.health();
    const body = await new HttpCloudClient({ url: 'https://h', token: 't', fetch: fakeFetch(() => new Response('ab', { status: 200 })).fetch }).getFile('transcripts/d/u.jsonl.gz');
    let text = '';
    for await (const ch of body) text += ch;
    expect(text).toBe('ab');
    expect(timers()).toBe(before);
  });
});
