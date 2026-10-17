import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION, isBlobKey, type SealedFileIn } from '@agent-hangar/shared';
import { CloudError, CompatError, HttpCloudClient, isFetchableKey, LimitError, MAX_PUT_BODY_BYTES, MIN_WORKER_COMPAT, RevokedError } from './client.ts';

/** 線の上の R2 の鍵名（互換の版 9）と、封じたメタの形。中身は形の合う作り物である。 */
const BK = `b/d/${'A'.repeat(43)}`;
const wmeta = (over: Partial<SealedFileIn> = {}): SealedFileIn => ({ key: BK, kind: 'transcript', size: 3, epoch: 1, sealedMeta: 'c2VhbGVkLW1ldGE', ...over });

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

/** Bearer の中身は真偽だけを表示。こちらも失敗時に値が出ない。 */
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
    // 線の client は封じた行をそのまま運ぶ。封じて開くのは SealedCloudClient（sealedClient.test.ts）。
    const ch = { k: 'k'.repeat(43), op: 'upsert' as const, updatedAt: 1, epoch: 1, sealed: 'AgAB' };
    expect(await c.pushChanges([ch])).toEqual({ seq: 3, accepted: 1, skipped: 0 });
    expect(calls[0]!.url).toBe('https://h/changes');
    expect(calls[0]!.init.method).toBe('POST');
    expect(headersOf(calls[0]!)['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ changes: [ch] });
    await c.pullChanges(5, 100);
    expect(calls[1]!.url).toBe('https://h/changes?since=5&limit=100');
    await c.snapshot('a-b_c', 50);
    expect(calls[2]!.url).toBe('https://h/rows?after=a-b_c&limit=50');
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
    const r = await c.putFile(wmeta(), Readable.from([Buffer.from('ab'), Buffer.from('c')]));
    expect(r).toEqual({ seq: 9 });
    expect(uploaded).toBe('abc');
    const h = headersOf(calls[0]!);
    expect(calls[0]!.url).toBe(`https://h/files/${BK}`);
    expect(h['x-hangar-kind']).toBe('transcript');
    expect(h['x-hangar-size']).toBe('3');
    expect(h['x-hangar-epoch']).toBe('1');
    expect(h['x-hangar-meta']).toBe('c2VhbGVkLW1ldGE');
    // パス、平文の指紋、mtime は封じたメタの中にあり、見出しには載せない。
    for (const name of ['x-hangar-path', 'x-hangar-sha256', 'x-hangar-mtime', 'x-hangar-encrypted']) expect(h[name], name).toBeUndefined();
    expect(h['content-type']).toBe('application/octet-stream');
    expect((calls[0]!.init as { duplex?: string }).duplex).toBe('half');
    const body = await c.getFile(BK);
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
    // 書くのは R2 の鍵名（`b/<端末>/<HMAC>`）だけ。パスを平文で持つ版 8 までの鍵名には書かない。
    await expect(c.putFile(wmeta({ key: 'config/../x' }), Readable.from([Buffer.from('x')]))).rejects.toMatchObject({ status: 400 });
    await expect(c.putFile(wmeta({ key: 'transcripts/d/u.jsonl.gz' }), Readable.from([Buffer.from('x')]))).rejects.toMatchObject({ status: 400 });
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
    const up = await hang.putFile(wmeta(), Readable.from([Buffer.from('x')])).catch((x: unknown) => x);
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
    expect(await c.putFile(wmeta(), Readable.from([Buffer.from('x')]))).toEqual({ seq: 1 });
  });

  it('無事に終わった要求は見張りのタイマーを残さない', async () => {
    // 5 分のタイマーが残ると vitest が終われない。終わった要求の分だけ増えていないことを表示。
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

  it('版 8 までの鍵名（日本語と空白を含む）も読むときは通し、URL では断片ごとに符号化する', async () => {
    // hangar cloud teardown が、作り直しの前の Worker から本文を降ろすのに使う。
    const key = 'config/skills/日本語 メモ/SKILL.md';
    const { fetch, calls } = fakeFetch(() => new Response('body', { status: 200 }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    let text = '';
    for await (const ch of await c.getFile(key)) text += ch;
    expect(text).toBe('body');
    expect(calls[0]!.url).toBe('https://h/files/config/skills/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%A1%E3%83%A2/SKILL.md');
    // 断片ごとの復号で元の鍵に戻る（Worker の受け取りと同じ）。
    expect(new URL(calls[0]!.url).pathname.slice('/files/'.length).split('/').map(decodeURIComponent).join('/')).toBe(key);
  });

  it('鍵の検査は、書くときは R2 の鍵名だけ、読むときは版 8 までの鍵名も通す', async () => {
    const { fetch, calls } = fakeFetch(() => json({ seq: 1 }, 201));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    for (const key of [BK, 'config/skills/日本語 メモ/SKILL.md', 'config/memory/🐕.md', 'transcripts/d/u 1.jsonl.gz']) {
      expect(isFetchableKey(key), key).toBe(true);
      await expect(c.getFile(key)).resolves.toBeDefined();
    }
    expect(calls).toHaveLength(4);
    for (const key of ['other/u1', 'transcripts/d/../e/u1', 'transcripts//u1', 'config/', 'transcripts/d/u\u0000.gz', `${BK}/x`]) {
      expect(isFetchableKey(key), key).toBe(false);
      await expect(c.getFile(key), key).rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toHaveLength(4);
    expect(isBlobKey('transcripts/d/u.jsonl.gz')).toBe(false);
  });

  describe('putFile は長さを決めてから送る', () => {
    const fileMeta = wmeta();
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
    await c.putFile(wmeta(), Readable.from([Buffer.from('x')]));
    let got = 0;
    for await (const chunk of await c.getFile(BK)) got += (chunk as Buffer).length;
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
    // 利用者が選んだ言い回し：クラウドが拒否したことと、更新してほしいことを言う。
    expect((e as Error).message).toContain('クラウドと同期できません');
    expect((e as Error).message).toContain('この PC の hangar を更新してください');
  });

  it('426 の本文が読めなくても、この PC の hangar を上げるよう伝える', async () => {
    const { fetch } = fakeFetch(() => new Response('upgrade', { status: 426 }));
    const e = await new HttpCloudClient({ url: 'https://h', token: 't', fetch }).listFiles(0, 10).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: 'CompatError', upgrade: 'device', need: null });
    expect((e as Error).message).toContain('この PC の hangar');
    expect((e as Error).message).toContain('それより新しいバージョン');
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

  it('Worker が最後に名乗った版を覚える。まだ話していなければ null で、Cloudflare の端の応答（版の見出し無し）では上書きしない', async () => {
    let status = 200;
    const { fetch } = fakeFetch(() => (status === 200 ? new Response(JSON.stringify({ changes: [], nextSeq: 0, more: false }), { status: 200, headers: { [COMPAT_HEADER]: '10' } }) : new Response('edge', { status })), { stamp: false });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    expect(c.lastWorkerCompat()).toBeNull();
    await c.pullChanges(0, 10);
    expect(c.lastWorkerCompat()).toBe(10);
    status = 403;
    await c.pullChanges(0, 10).catch(() => {});
    expect(c.lastWorkerCompat()).toBe(10);
  });

  it('この PC が Worker に求める下限は 9 で、版の見出しを返さない Worker（版 0）の 2xx は Worker を上げるよう断る', async () => {
    expect(MIN_WORKER_COMPAT).toBe(9);
    const { fetch } = fakeFetch(() => json({ changes: [], nextSeq: 4, more: false }), { stamp: false });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await expect(c.pullChanges(0, 10)).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker', have: 0, need: 9 });
    await expect(c.usage()).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker' });
  });

  it.each([1, 5, 8])('版 %i の Worker（版 1 は session_notes を知らない、版 5 は変更ログを持つ、版 8 は行を平文で持つ）も、Worker を上げるよう断る', async (old) => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ changes: [], nextSeq: 4, more: false }), { status: 200, headers: { [COMPAT_HEADER]: String(old) } }), { stamp: false });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await expect(c.pullChanges(0, 10)).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker', have: old, need: 9 });
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

describe('PC の一覧と解除', () => {
  const device = { id: 'dev-b', kind: 'pc', joinedAt: 1, lastSeenAt: 2, revokedAt: null, expiresAt: null };

  it('getRoster は GET /roster を読み、まだ無ければ（404）null を返す。ほかの失敗は投げる', async () => {
    const f = fakeFetch(() => json({ version: 3, sealed: 'abc' }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    expect(await c.getRoster()).toEqual({ version: 3, sealed: 'abc' });
    expect(f.calls[0]!.url).toBe('https://w.example/roster');
    const none = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'not found' }, 404)).fetch });
    expect(await none.getRoster()).toBeNull();
    const broken = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'boom' }, 500)).fetch });
    await expect(broken.getRoster()).rejects.toMatchObject({ status: 500 });
  });

  it('putRoster は PUT /roster に版と世代と封じた名簿を送り、409 は投げずに今の版を返す', async () => {
    const f = fakeFetch(() => json({ version: 4 }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    expect(await c.putRoster({ ifVersion: 3, epoch: 2, sealed: 'abc' })).toEqual({ ok: true, version: 4 });
    expect(f.calls[0]!.url).toBe('https://w.example/roster');
    expect(f.calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ ifVersion: 3, epoch: 2, sealed: 'abc' });
    expect(headersOf(f.calls[0]!)['content-type']).toBe('application/json');
    const taken = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ version: 7 }, 409)).fetch });
    expect(await taken.putRoster({ ifVersion: 3, epoch: 2, sealed: 'abc' })).toEqual({ ok: false, version: 7 });
    const broken = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'boom' }, 500)).fetch });
    await expect(broken.putRoster({ ifVersion: 3, epoch: 2, sealed: 'abc' })).rejects.toMatchObject({ status: 500 });
  });

  it('getKeyboxes は GET /keyboxes で自分宛ての箱を読む', async () => {
    const f = fakeFetch(() => json({ boxes: [{ epoch: 2, sealed: 'xyz' }] }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    expect(await c.getKeyboxes()).toEqual({ boxes: [{ epoch: 2, sealed: 'xyz' }] });
    expect(f.calls[0]!.url).toBe('https://w.example/keyboxes');
  });

  it('deleteBlobs は DELETE /blobs に鍵を送り、形の違う鍵と 50 件を超える数は送らない', async () => {
    const key = `b/dev-a/${'A'.repeat(43)}`;
    const f = fakeFetch(() => json({ deleted: [key], refused: [] }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    expect(await c.deleteBlobs([key])).toEqual({ deleted: [key], refused: [] });
    expect(f.calls[0]!.url).toBe('https://w.example/blobs');
    expect(f.calls[0]!.init.method).toBe('DELETE');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ keys: [key] });
    await expect(c.deleteBlobs(['transcripts/dev-a/x.jsonl.gz'])).rejects.toMatchObject({ status: 400 });
    await expect(c.deleteBlobs(Array.from({ length: 51 }, () => key))).rejects.toMatchObject({ status: 400 });
    await expect(c.deleteBlobs([])).rejects.toMatchObject({ status: 400 });
    expect(f.calls).toHaveLength(1);
  });

  it('listDevices は GET /devices を Bearer 付きで叩いて一覧を返す', async () => {
    const f = fakeFetch(() => json({ devices: [device] }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    expect(await c.listDevices()).toEqual([device]);
    expect(f.calls[0]!.url).toBe('https://w.example/devices');
    expect(headersOf(f.calls[0]!).authorization).toBe('Bearer ***');
  });

  it('revokeDevice は POST /devices/<id>/revoke を叩き、ID は URL の断片として符号化する', async () => {
    const f = fakeFetch(() => json({ device: { ...device, revokedAt: 9 } }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    expect((await c.revokeDevice('dev-b')).revokedAt).toBe(9);
    expect(f.calls[0]!.url).toBe('https://w.example/devices/dev-b/revoke');
    expect(f.calls[0]!.init.method).toBe('POST');
  });

  it('putMobileFeed は PUT /m/feed に { sealed } を JSON で送る', async () => {
    const f = fakeFetch(() => json({ ok: true, updatedAt: 1 }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    await c.putMobileFeed('sealed-text');
    expect(f.calls[0]!.url).toBe('https://w.example/m/feed');
    expect(f.calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ sealed: 'sealed-text' });
    expect(headersOf(f.calls[0]!)['content-type']).toBe('application/json');
  });

  it('createPairing は POST /m/pairings を送り、券と期限を返す。429 は CloudError(429) で投げる', async () => {
    const f = fakeFetch(() => json({ code: 'c0de', expiresAt: 5 }, 201));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    expect(await c.createPairing()).toEqual({ code: 'c0de', expiresAt: 5 });
    expect(f.calls[0]!.url).toBe('https://w.example/m/pairings');
    expect(f.calls[0]!.init.method).toBe('POST');
    const limited = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'rate limited' }, 429)).fetch });
    await expect(limited.createPairing()).rejects.toMatchObject({ status: 429 });
  });

  it('claimLaunch は POST /m/launches/:id/claim を送り、200 は true、409 は false、他の失敗は投げる', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    expect(await c.claimLaunch('l 1/x')).toBe(true);
    expect(f.calls[0]!.url).toBe('https://w.example/m/launches/l%201%2Fx/claim');
    expect(f.calls[0]!.init.method).toBe('POST');
    const taken = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'conflict' }, 409)).fetch });
    expect(await taken.claimLaunch('l1')).toBe(false);
    const broken = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'boom' }, 500)).fetch });
    await expect(broken.claimLaunch('l1')).rejects.toMatchObject({ status: 500 });
  });

  it('answerLaunch は POST /m/launches/:id/answer に ok と封じた答えを送る。409 は投げる', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    await c.answerLaunch('l1', false, 'sealed-answer');
    expect(f.calls[0]!.url).toBe('https://w.example/m/launches/l1/answer');
    expect(f.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ ok: false, sealedAnswer: 'sealed-answer' });
    expect(headersOf(f.calls[0]!)['content-type']).toBe('application/json');
    const taken = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'conflict' }, 409)).fetch });
    await expect(taken.answerLaunch('l1', true, 's')).rejects.toMatchObject({ status: 409 });
  });

  it('getMobileBlob は GET /m/blobs/<依頼>/<番号> のバイト列をそのまま返す。404 と形の違う ID は投げる', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const f = fakeFetch(() => new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'x-hangar-compat': String(COMPAT_VERSION) } }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    expect([...await c.getMobileBlob('l-1.x', 2)]).toEqual([...bytes]);
    expect(f.calls[0]!.url).toBe('https://w.example/m/blobs/l-1.x/2');
    expect(f.calls[0]!.init.method ?? 'GET').toBe('GET');
    const missing = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'not found' }, 404)).fetch });
    await expect(missing.getMobileBlob('l1', 0)).rejects.toMatchObject({ status: 404 });
    const bad = fakeFetch(() => json({}));
    const c2 = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: bad.fetch });
    await expect(c2.getMobileBlob('../x', 0)).rejects.toBeInstanceOf(CloudError);
    await expect(c2.getMobileBlob('l1', 4)).rejects.toBeInstanceOf(CloudError);
    await expect(c2.getMobileBlob('l1', -1)).rejects.toBeInstanceOf(CloudError);
    expect(bad.calls).toHaveLength(0);
  });

  it('deleteMobileFeed は DELETE /m/feed を送る', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    await c.deleteMobileFeed();
    expect(f.calls[0]!.url).toBe('https://w.example/m/feed');
    expect(f.calls[0]!.init.method).toBe('DELETE');
    const broken = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'boom' }, 500)).fetch });
    await expect(broken.deleteMobileFeed()).rejects.toMatchObject({ status: 500 });
  });

  it('形の違う ID は送る前に断る', async () => {
    const f = fakeFetch(() => json({}));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: f.fetch });
    await expect(c.revokeDevice('../x')).rejects.toBeInstanceOf(CloudError);
    expect(f.calls).toHaveLength(0);
  });

  it('401 の { error: revoked } は RevokedError にする。他の 401 は今までどおりの CloudError', async () => {
    const revoked = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'revoked' }, 401)).fetch });
    const e = await revoked.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RevokedError);
    expect((e as RevokedError).status).toBe(401);
    const other = new HttpCloudClient({ url: 'https://w.example', token: 'tok', fetch: fakeFetch(() => json({ error: 'unauthorized' }, 401)).fetch });
    const e2 = await other.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(CloudError);
    expect(e2).not.toBeInstanceOf(RevokedError);
  });
});

describe('端末トークンの読み直し', () => {
  const pathOf = (c: Call): string => new URL(c.url).pathname;
  /** 決まったトークンだけを通す Worker の真似。違えば実物の認証と同じ 401 の unauthorized を返す。 */
  const acceptOnly = (token: string, ok: () => Response = () => json({ changes: [], nextSeq: 0, more: false })) => fakeFetch((c) => (bearerIs(c, token) ? ok() : json({ error: 'unauthorized' }, 401)));

  it('401 の unauthorized を受けたら読み直し、トークンが変わっていれば 1 度だけ試し直して、以後もそのトークンで話す', async () => {
    const f = acceptOnly('new');
    let reads = 0;
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'old', fetch: f.fetch, reloadCredentials: () => { reads++; return { url: 'https://w.example', token: 'new' }; } });
    await expect(c.pullChanges(0, 10)).resolves.toMatchObject({ nextSeq: 0 });
    expect(f.calls.map((x) => bearerIs(x, 'new'))).toEqual([false, true]);
    await c.pullChanges(0, 10);
    expect(f.calls).toHaveLength(3);
    expect(bearerIs(f.calls[2]!, 'new')).toBe(true);
    expect(reads).toBe(1);
  });

  it('読み直しても同じトークンなら、試し直さずに今までどおりの CloudError にする', async () => {
    const f = acceptOnly('new');
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'old', fetch: f.fetch, reloadCredentials: () => ({ url: 'https://w.example', token: 'old' }) });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).not.toBeInstanceOf(RevokedError);
    expect((e as CloudError).status).toBe(401);
    expect(f.calls).toHaveLength(1);
  });

  it('読み直しが無い、null を返す、投げるときも、今までどおりの CloudError にする', async () => {
    for (const reloadCredentials of [undefined, () => null, () => { throw new Error('boom'); }]) {
      const f = acceptOnly('new');
      const c = new HttpCloudClient({ url: 'https://w.example', token: 'old', fetch: f.fetch, ...(reloadCredentials ? { reloadCredentials } : {}) });
      await expect(c.pullChanges(0, 10)).rejects.toMatchObject({ name: 'CloudError', status: 401 });
      expect(f.calls).toHaveLength(1);
    }
  });

  it('試し直しも断られたら、そこで止める（読み直しのたびに違うトークンが出ても繰り返さない）', async () => {
    const f = acceptOnly('never');
    let n = 0;
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'old', fetch: f.fetch, reloadCredentials: () => ({ url: 'https://w.example', token: `t${++n}` }) });
    await expect(c.pullChanges(0, 10)).rejects.toMatchObject({ status: 401 });
    expect(f.calls).toHaveLength(2);
  });

  it('同時に断られた要求は、先に差し替えた組で試し直す（後から読み直して同じ組だと見ても、失敗にしない）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let waiting = 0;
    const f = fakeFetch(async (c) => {
      if (bearerIs(c, 'new')) return json({ changes: [], nextSeq: 0, more: false });
      // 2 つとも古いトークンで出てから、そろって断る。
      if (++waiting === 2) release();
      await gate;
      return json({ error: 'unauthorized' }, 401);
    });
    let reads = 0;
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'old', fetch: f.fetch, reloadCredentials: () => { reads++; return { url: 'https://w.example', token: 'new' }; } });
    await expect(Promise.all([c.pullChanges(0, 10), c.listFiles(0, 10)])).resolves.toHaveLength(2);
    expect(f.calls.filter((x) => bearerIs(x, 'new'))).toHaveLength(2);
    expect(reads).toBe(1);
  });

  it('解除（revoked）は読み直さない', async () => {
    const f = fakeFetch(() => json({ error: 'revoked' }, 401));
    let reads = 0;
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'old', fetch: f.fetch, reloadCredentials: () => { reads++; return { url: 'https://w.example', token: 'new' }; } });
    await expect(c.pullChanges(0, 10)).rejects.toBeInstanceOf(RevokedError);
    expect(reads).toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it('putFile の試し直しは本文を最初から送り直す', async () => {
    const bodies: string[] = [];
    const f = fakeFetch(async (c) => {
      bodies.push(await new Response(c.init.body as BodyInit).text());
      return bearerIs(c, 'new') ? json({ seq: 9 }, 201) : json({ error: 'unauthorized' }, 401);
    });
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'old', fetch: f.fetch, reloadCredentials: () => ({ url: 'https://w.example', token: 'new' }) });
    const r = await c.putFile(wmeta({ size: 5 }), Readable.from([Buffer.from('hello')]));
    expect(r).toEqual({ seq: 9 });
    expect(bodies).toEqual(['hello', 'hello']);
    expect(pathOf(f.calls[1]!)).toBe(`/files/${BK}`);
  });
});

describe('書き込みの前の版の確かめ', () => {
  const pathOf = (c: Call): string => `${c.init.method ?? 'GET'} ${new URL(c.url).pathname}`;
  const worker = (compat: number) => fakeFetch((c) => {
    const p = new URL(c.url).pathname;
    const h = { [COMPAT_HEADER]: String(compat), 'content-type': 'application/json' };
    if (p === '/health') return new Response(JSON.stringify({ ok: true, version: 'x', compat }), { status: 200, headers: h });
    if (p === '/changes' && c.init.method === 'POST') return new Response(JSON.stringify({ seq: 1, accepted: 1, skipped: 0 }), { status: 200, headers: h });
    if (p.startsWith('/files/')) return new Response(JSON.stringify({ seq: 2 }), { status: 201, headers: h });
    return new Response(JSON.stringify({ changes: [], nextSeq: 0, more: false }), { status: 200, headers: h });
  }, { stamp: false });
  const meta = wmeta({ size: 1 });

  it('版を知る前の push と putFile は、先に GET /health で版を確かめ、下限に届かなければ書かずに CompatError にする', async () => {
    const f = worker(5);
    const c = new HttpCloudClient({ url: 'https://w.example', token: 't', fetch: f.fetch, checkWorkerBeforeWrite: true });
    await expect(c.pushChanges([])).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker', have: 5, need: MIN_WORKER_COMPAT });
    await expect(c.putFile(meta, Readable.from([Buffer.from('a')]))).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker' });
    expect(f.calls.map(pathOf)).toEqual(['GET /health', 'GET /health']);
  });

  it('届いていれば書く。版を知った後は確かめ直さず、同時の書き込みは 1 回の確かめを分け合う', async () => {
    const f = worker(COMPAT_VERSION);
    const c = new HttpCloudClient({ url: 'https://w.example', token: 't', fetch: f.fetch, checkWorkerBeforeWrite: true });
    await Promise.all([c.pushChanges([]), c.putFile(meta, Readable.from([Buffer.from('a')]))]);
    await c.pushChanges([]);
    const seen = f.calls.map(pathOf);
    expect(seen.filter((p) => p === 'GET /health')).toHaveLength(1);
    expect(seen[0]).toBe('GET /health');
    expect(seen.filter((p) => p === 'POST /changes')).toHaveLength(2);
    expect(seen.filter((p) => p === `PUT /files/${BK}`)).toHaveLength(1);
  });

  it('pull で版を知っていれば確かめない。読むだけの要求は確かめない', async () => {
    const f = worker(COMPAT_VERSION);
    const c = new HttpCloudClient({ url: 'https://w.example', token: 't', fetch: f.fetch, checkWorkerBeforeWrite: true });
    await c.pullChanges(0, 10);
    await c.pushChanges([]);
    expect(f.calls.map(pathOf)).toEqual(['GET /changes', 'POST /changes']);
  });

  it('既定では確かめない', async () => {
    const f = worker(COMPAT_VERSION);
    const c = new HttpCloudClient({ url: 'https://w.example', token: 't', fetch: f.fetch });
    await c.pushChanges([]);
    expect(f.calls.map(pathOf)).toEqual(['POST /changes']);
  });
});

describe('HttpCloudClient.bellTarget（呼び鈴のつなぎ先）', () => {
  it('https は wss、http は ws にして /m/bell を足し、Bearer と互換の版の見出しを付ける', () => {
    const { fetch } = fakeFetch(() => json({ ok: true }));
    const a = new HttpCloudClient({ url: 'https://h.example.workers.dev/', token: 'tok', fetch }).bellTarget();
    expect(a.url).toBe('wss://h.example.workers.dev/m/bell');
    expect(a.headers.authorization).toBe('Bearer tok');
    expect(a.headers[COMPAT_HEADER]).toBe(String(COMPAT_VERSION));
    expect(new HttpCloudClient({ url: 'http://127.0.0.1:8787', token: 'tok', fetch }).bellTarget().url).toBe('ws://127.0.0.1:8787/m/bell');
  });

  it('トークンを読み直して差し替えたら、つなぎ先の見出しも新しいトークンになる', async () => {
    const { fetch } = fakeFetch((c) => (((c.init.headers as Record<string, string>).authorization === 'Bearer new') ? json({ changes: [], nextSeq: 0, more: false }) : json({ error: 'unauthorized' }, 401)));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 'old', fetch, reloadCredentials: () => ({ url: 'https://w2.example', token: 'new' }) });
    expect(c.bellTarget().headers.authorization).toBe('Bearer old');
    await c.pullChanges(0, 10);
    expect(c.bellTarget()).toMatchObject({ url: 'wss://w2.example/m/bell', headers: { authorization: 'Bearer new' } });
  });
});
