import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION, decodeHeaderText, isHeaderSafe } from '@agent-hangar/shared';
import { CloudError, CompatError, goneFloor, HttpCloudClient, isValidFileKey, LimitError, MAX_PUT_BODY_BYTES, MIN_WORKER_COMPAT } from './client.ts';

type Call = { url: string; init: RequestInit };

/**
 * Worker の立て替え。
 * いまの Worker の真似として、版の見出しの無い応答にはこの PC と同じ版を足す（この PC が Worker に求める下限は 1 である）。
 * 版を試す試験は stamp: false を渡し、見出しを足さない（版 0 の古い Worker や、Cloudflare の端の真似）。
 */
function fakeFetch(handler: (c: Call) => Response | Promise<Response>, o: { stamp?: boolean } = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input), init: init ?? {} };
    // undici と同じ検査をここで通す。
    // 見出しの値は ByteString しか運べず、非 ASCII は送る前に TypeError になる。
    // URL も同じで、組み立てた文字列がそのまま要求になるわけではない。
    new Headers(c.init.headers as Record<string, string> | undefined);
    new URL(c.url);
    calls.push(c);
    const res = await handler(c);
    if (o.stamp !== false && !res.headers.has(COMPAT_HEADER)) res.headers.set(COMPAT_HEADER, String(COMPAT_VERSION));
    return res;
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

  it('listFiles', async () => {
    const { fetch, calls } = fakeFetch(() => json({ files: [], nextSeq: 4, more: false }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    expect(await c.listFiles(4, 500)).toEqual({ files: [], nextSeq: 4, more: false });
    expect(calls[0]!.url).toBe('https://h/files?since=4&limit=500');
    expect(bearerIs(calls[0]!, 't')).toBe(true);
  });

  it('本文と設定を消す口は無い（Worker に DELETE の経路が無い）', () => {
    expect('deleteFile' in HttpCloudClient.prototype).toBe(false);
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
    await expect(c.getFile('transcripts/d/u\u0000.gz')).rejects.toMatchObject({ status: 400 });
    await expect(c.putFile({ key: 'config/../x', path: 'x', kind: 'config', sha256: 'a'.repeat(64), size: 1, mtime: 1, encrypted: false }, Readable.from([Buffer.from('x')]))).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
    // 空白と `?` は Worker が通すので、端末も通して URL の側で符号化する。
    await c.getFile('transcripts/d/u 1?x.gz');
    expect(calls[0]!.url).toBe('https://h/files/transcripts/d/u%201%3Fx.gz');
    expect(new URL(calls[0]!.url).search).toBe('');
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

  it('日本語と空白を含む path を見出しに載せられる形で送る', async () => {
    // 符号化しないと undici が送る前に TypeError を投げる。Worker では直せない。
    const path = 'projects/-Users-me-作業/メモ 1.jsonl';
    const { fetch, calls } = fakeFetch(() => json({ seq: 1 }, 201));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    expect(await c.putFile({ key: 'transcripts/d/u.jsonl.gz', path, kind: 'transcript', sha256: 'a'.repeat(64), size: 3, mtime: 5, encrypted: true }, Readable.from([Buffer.from('abc')]))).toEqual({ seq: 1 });
    const wire = headersOf(calls[0]!)['x-hangar-path']!;
    expect(isHeaderSafe(wire)).toBe(true);
    expect(wire).toBe('projects/-Users-me-%E4%BD%9C%E6%A5%AD/%E3%83%A1%E3%83%A2%201.jsonl');
    // Worker は同じ物差しで復号する。
    expect(decodeHeaderText(wire)).toBe(path);
  });

  it('日本語と空白を含む鍵を通し、URL では断片ごとに符号化する', async () => {
    const key = 'config/skills/日本語 メモ/SKILL.md';
    const { fetch, calls } = fakeFetch((c) => (c.init.method === 'PUT' ? json({ seq: 2 }, 201) : new Response('body', { status: 200 })));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await c.putFile({ key, path: 'skills/日本語 メモ/SKILL.md', kind: 'config', sha256: 'b'.repeat(64), size: 1, mtime: 1, encrypted: true }, Readable.from([Buffer.from('x')]));
    const expected = 'https://h/files/config/skills/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%A1%E3%83%A2/SKILL.md';
    expect(calls[0]!.url).toBe(expected);
    let text = '';
    for await (const ch of await c.getFile(key)) text += ch;
    expect(text).toBe('body');
    expect(calls[1]!.url).toBe(expected);
    // 断片ごとの復号で元の鍵に戻る（Worker の受け取りと同じ）。
    expect(new URL(calls[0]!.url).pathname.slice('/files/'.length).split('/').map(decodeURIComponent).join('/')).toBe(key);
  });

  it('鍵の検査は Worker と同じ物差しにする', async () => {
    const { fetch, calls } = fakeFetch(() => json({ seq: 1 }, 201));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    // 端末の側だけが厳しいと、Worker が受け取れる鍵を送る前に落とす。
    for (const key of ['config/skills/日本語 メモ/SKILL.md', 'config/memory/🐕.md', 'transcripts/d/u 1.jsonl.gz']) {
      expect(isValidFileKey(key), key).toBe(true);
      await expect(c.getFile(key)).resolves.toBeDefined();
    }
    expect(calls).toHaveLength(3);
    for (const key of ['other/u1', 'transcripts/d/../e/u1', 'transcripts//u1', 'config/', 'transcripts/d/u\u0000.gz']) {
      await expect(c.getFile(key), key).rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toHaveLength(3);
  });

  it('見出しに載せられない path は送る前に 400 で断る', async () => {
    const { fetch, calls } = fakeFetch(() => json({ seq: 1 }, 201));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    const meta = (path: string) => ({ key: 'transcripts/d/u.jsonl.gz', path, kind: 'transcript' as const, sha256: 'a'.repeat(64), size: 1, mtime: 1, encrypted: true });
    for (const path of ['../../etc/passwd', '/etc/passwd', 'a/../b', '', 'a\u0000b', '\ud800']) {
      await expect(c.putFile(meta(path), Readable.from([Buffer.from('x')])), path).rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toHaveLength(0);
  });

  describe('putFile は長さを決めてから送る', () => {
    const fileMeta = { key: 'transcripts/d/u.jsonl.gz', path: 'projects/-x/u.jsonl', kind: 'transcript' as const, sha256: 'a'.repeat(64), size: 3, mtime: 5, encrypted: true };
    let spoolDir = '';
    beforeEach(() => { spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-client-test-')); });
    afterEach(() => { fs.rmSync(spoolDir, { recursive: true, force: true }); });

    it('content-length を付けて送る。Worker はそれを見て本文を JS で読まずに R2 へ渡す', async () => {
      let uploaded = Buffer.alloc(0);
      const { fetch, calls } = fakeFetch(async (c) => {
        uploaded = Buffer.from(await new Response(c.init.body as ReadableStream).arrayBuffer());
        return json({ seq: 1 }, 201);
      });
      const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, spoolDir });
      const pieces = [Buffer.alloc(70_000, 1), Buffer.alloc(3, 2), Buffer.alloc(200_000, 3)];
      await c.putFile(fileMeta, Readable.from(pieces));
      expect(headersOf(calls[0]!)['content-length']).toBe(String(270_003));
      expect(uploaded.equals(Buffer.concat(pieces))).toBe(true);
    });

    it('書き出した一時ファイルは、通っても断られても残さない', async () => {
      const ok = new HttpCloudClient({ url: 'https://h', token: 't', spoolDir, fetch: fakeFetch(() => json({ seq: 1 }, 201)).fetch });
      await ok.putFile(fileMeta, Readable.from([Buffer.from('abc')]));
      expect(fs.readdirSync(spoolDir)).toEqual([]);
      const ng = new HttpCloudClient({ url: 'https://h', token: 't', spoolDir, fetch: fakeFetch(() => new Response('boom', { status: 500 })).fetch });
      await expect(ng.putFile(fileMeta, Readable.from([Buffer.from('abc')]))).rejects.toMatchObject({ status: 500 });
      expect(fs.readdirSync(spoolDir)).toEqual([]);
    });

    it('本文の流れが途中で倒れたら送らずに CloudError(0) にし、一時ファイルも残さない', async () => {
      const { fetch, calls } = fakeFetch(() => json({ seq: 1 }, 201));
      const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, spoolDir });
      const broken = Readable.from((async function* () { yield Buffer.from('ab'); throw new Error('gzip broke'); })());
      await expect(c.putFile(fileMeta, broken)).rejects.toMatchObject({ status: 0, message: 'gzip broke' });
      expect(calls).toHaveLength(0);
      expect(fs.readdirSync(spoolDir)).toEqual([]);
    });

    it('上限を超える本文は送らずに 413 で断る（Worker と同じ答え）', async () => {
      const { fetch, calls } = fakeFetch(() => json({ seq: 1 }, 201));
      const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, spoolDir, maxBodyBytes: 10 });
      const e = await c.putFile(fileMeta, Readable.from([Buffer.alloc(6), Buffer.alloc(5)])).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CloudError);
      expect(e).toMatchObject({ status: 413 });
      expect(JSON.parse((e as CloudError).message)).toEqual({ error: 'too large' });
      expect(calls).toHaveLength(0);
      expect(fs.readdirSync(spoolDir)).toEqual([]);
      // 上限ちょうどは通す。
      await c.putFile(fileMeta, Readable.from([Buffer.alloc(10)]));
      expect(calls).toHaveLength(1);
    });

    it('一時ファイルを置けなければ CloudError(0) にし、送らない', async () => {
      const { fetch, calls } = fakeFetch(() => json({ seq: 1 }, 201));
      const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, spoolDir: path.join(spoolDir, 'missing') });
      const e = await c.putFile(fileMeta, Readable.from([Buffer.from('abc')])).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CloudError);
      expect(e).toMatchObject({ status: 0 });
      expect(calls).toHaveLength(0);
    });

    it('本文の流れが止まったら、書き出しの途中でも転送の時間切れで切り、一時ファイルを残さない', async () => {
      const { fetch, calls } = fakeFetch(() => json({ seq: 1 }, 201));
      const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, spoolDir, transferTimeoutMs: 30 });
      const stalled = new Readable({ read() { /* 何も流さず、終わりもしない */ } });
      stalled.push(Buffer.from('ab'));
      const e = await c.putFile(fileMeta, stalled).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CloudError);
      expect(e).toMatchObject({ status: 0 });
      expect((e as CloudError).message).toContain('timeout');
      expect(stalled.destroyed).toBe(true);
      expect(calls).toHaveLength(0);
      expect(fs.readdirSync(spoolDir)).toEqual([]);
    });

    it('上限は Worker と同じ値である', () => {
      const src = fs.readFileSync(new URL('../../../cloud/src/files.ts', import.meta.url), 'utf8');
      const m = /export const MAX_BODY_BYTES = ([0-9*\s]+);/.exec(src);
      expect(m).not.toBeNull();
      expect(MAX_PUT_BODY_BYTES).toBe(m![1]!.split('*').reduce((a, b) => a * Number(b.trim()), 1));
    });
  });
});

describe('usage', () => {
  it('GET /usage を Bearer 付きで叩いて返す', async () => {
    const { fetch, calls } = fakeFetch(() => json({ configured: false }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'dev-token', fetch });
    expect(await c.usage()).toEqual({ configured: false });
    expect(calls[0]!.url).toBe('https://w.example/usage');
    expect(bearerIs(calls[0]!, 'dev-token')).toBe(true);
  });
  it('404 は読み替えずに CloudError のまま投げる（/usage の無い古い Worker は、版の下限で先に断る）', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'not found' }, 404));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 't', fetch });
    await expect(c.usage()).rejects.toMatchObject({ name: 'CloudError', status: 404 });
  });
  it('それ以外の失敗は CloudError のまま投げる', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'internal error' }, 500));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 't', fetch });
    await expect(c.usage()).rejects.toMatchObject({ name: 'CloudError', status: 500 });
  });
});

describe('互換の版', () => {
  /** どの経路にも、形の合う応答を返す。 */
  const anyRoute = (c: Call): Response =>
    c.init.method === 'PUT' ? json({ seq: 1 }, 201)
      : /\/files\/./.test(new URL(c.url).pathname) ? new Response('payload')
        : json({ ok: true, version: '1', changes: [], nextAfter: null, seq: 0, nextSeq: 0, more: false, files: [], configured: false });

  it('Worker へのすべての要求に、この PC の版を見出しで載せる', async () => {
    const { fetch, calls } = fakeFetch(anyRoute);
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await c.health();
    await c.pushChanges([]);
    await c.pullChanges(0, 10);
    await c.snapshot(null, 10);
    await c.listFiles(0, 10);
    await c.putFile({ key: 'transcripts/d/u.jsonl.gz', path: 'projects/-x/u.jsonl', kind: 'transcript', sha256: 'a'.repeat(64), size: 1, mtime: 1, encrypted: true }, Readable.from([Buffer.from('x')]));
    let got = 0;
    for await (const chunk of await c.getFile('transcripts/d/u.jsonl.gz')) got += (chunk as Buffer).length;
    expect(got).toBe('payload'.length);
    await c.usage();
    expect(calls).toHaveLength(8);
    for (const call of calls) expect(headersOf(call)[COMPAT_HEADER], call.url).toBe(String(COMPAT_VERSION));
    // 端末トークンは変わらず最後に載る。
    expect(bearerIs(calls[0]!, 't')).toBe(true);
  });

  it('426 は CompatError にし、この PC の hangar を上げるよう伝え、本文の下限を載せる', async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ error: 'upgrade required', minCompat: 2, compat: 2 }), { status: 426, headers: { 'content-type': 'application/json', [COMPAT_HEADER]: '2' } }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CompatError);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ name: 'CompatError', status: 426, upgrade: 'device', have: COMPAT_VERSION, need: 2 });
    expect((e as Error).message).toContain('この PC の hangar');
    expect((e as Error).message).toContain('2 以上');
  });

  it('426 の本文が読めなくても、この PC の hangar を上げるよう伝える', async () => {
    const { fetch } = fakeFetch(() => new Response('upgrade', { status: 426 }));
    const e = await new HttpCloudClient({ url: 'https://h', token: 't', fetch }).listFiles(0, 10).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: 'CompatError', upgrade: 'device', need: null });
    expect((e as Error).message).toContain('この PC の hangar');
    expect((e as Error).message).toContain('それより新しい版');
  });

  it('Worker の版がこの PC の下限より古ければ、通った応答でも CompatError にして Worker を上げるよう伝える', async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ changes: [], nextSeq: 0, more: false }), { status: 200, headers: { [COMPAT_HEADER]: '1' } }), { stamp: false });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, minWorkerCompat: 2 });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: 'CompatError', status: 426, upgrade: 'worker', have: 1, need: 2 });
    expect((e as Error).message).toContain('Worker');
    expect((e as Error).message).toContain('2 以上');
    expect((e as Error).message).toContain('今すぐ同期');
  });

  it('この PC が Worker に求める下限は 1 で、版の見出しを返さない Worker（版 0）の 2xx は Worker を上げるよう断る', async () => {
    expect(MIN_WORKER_COMPAT).toBe(1);
    const { fetch } = fakeFetch(() => json({ changes: [], nextSeq: 4, more: false }), { stamp: false });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await expect(c.pullChanges(0, 10)).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker', have: 0, need: 1 });
    await expect(c.usage()).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker' });
  });

  // Cloudflare の端は、Worker を通さずに 4xx と 5xx を返すことがある（WAF の 403、本文が大きすぎるときの 413、CPU の超過、日の上限など）。
  // どれも版の見出しを持たないが、Worker の版を語らないので、下限を上げていても版の不一致にはしない。
  it.each([503, 429, 408, 403, 404, 400, 413])('Worker を通らずに端が返した %i（版の見出しなし）は、版の不一致にせず、その status の CloudError にする', async (status) => {
    const { fetch } = fakeFetch(() => new Response('<html>edge</html>', { status, headers: { 'content-type': 'text/html' } }), { stamp: false });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, minWorkerCompat: 1 });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).not.toBeInstanceOf(CompatError);
    expect(e).toMatchObject({ status });
  });
});

describe('上限の失敗', () => {
  it('Worker の 429 と上限の本文は LimitError にする', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'limit', limit: 'd1-write', resetAt: 1 }, 429));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await expect(c.pushChanges([])).rejects.toMatchObject({ name: 'LimitError', limit: 'd1-write', status: 429 });
  });

  it('本文に D1 の上限のメッセージがあれば、状態番号と形を問わずに LimitError にする', async () => {
    const cases = [
      [500, '{"error":"D1_ERROR: free tier daily row read limit"}', 'd1-read'],
      [503, 'D1_ERROR: free tier daily row write limit', 'd1-write'],
    ] as const;
    for (const [status, body, limit] of cases) {
      const { fetch } = fakeFetch(() => new Response(body, { status }));
      const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
      await expect(c.pullChanges(0, 10)).rejects.toMatchObject({ name: 'LimitError', limit, status });
    }
  });

  it('JSON でなく 1027 を含む頁は、200 字より後ろにあっても LimitError にする', async () => {
    const page = `<html>${'x'.repeat(300)}<p>error code: 1027</p></html>`;
    const { fetch } = fakeFetch(() => new Response(page, { status: 429 }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await expect(c.listFiles(0, 10)).rejects.toMatchObject({ name: 'LimitError', limit: 'requests', status: 429 });
  });

  it('上限は版の検査より先に見る。版の見出しの無い 4xx の 1027 を、Worker が古いと取り違えない', async () => {
    const { fetch } = fakeFetch(() => new Response('error code: 1027', { status: 403 }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, minWorkerCompat: 1 });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LimitError);
    expect(e).not.toBeInstanceOf(CompatError);
  });

  it('上限でない失敗は今までどおりの CloudError で、本文の先頭 200 字を運ぶ', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'internal error' }, 500));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).not.toBeInstanceOf(LimitError);
    expect(e).toMatchObject({ status: 500, message: '{"error":"internal error"}' });
  });
});
