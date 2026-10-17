import { aadImage, COMPAT_HEADER, MOBILE_BELL_MIN_WORKER_COMPAT, MOBILE_IMAGE_MAX_BYTES, openBytes } from '@agent-hangar/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitSize, ImageError, imageFailureText, IMAGE_LONG_EDGE, IMAGE_QUALITY, putImage, rejectImage, useAttachments, type PutImage, type Shrink } from './images.ts';
import { at1, makeKey } from './test/fixtures.ts';
import { WORKER } from './test/pairText.ts';

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
let key: CryptoKey;

beforeEach(async () => {
  key = await makeKey();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('fitSize', () => {
  it('長い辺を 2048 px に収め、縦横の比を保つ', () => {
    expect(IMAGE_LONG_EDGE).toBe(2048);
    expect(IMAGE_QUALITY).toBe(0.85);
    expect(fitSize(4032, 3024)).toEqual({ w: 2048, h: 1536 });
    expect(fitSize(3024, 4032)).toEqual({ w: 1536, h: 2048 });
    expect(fitSize(1000, 500)).toEqual({ w: 1000, h: 500 });
    expect(fitSize(5000, 3)).toEqual({ w: 2048, h: 1 });
  });
});

describe('rejectImage', () => {
  it('5 枚目と、縮めた後で 5 MB を超えるものを断る（試作の文言）', () => {
    expect(rejectImage({ count: 3 })).toBeNull();
    expect(rejectImage({ count: 4 })).toBe('4 枚までです。1 枚削除してから追加してください。');
    expect(rejectImage({ count: 0, name: 'IMG_1.jpg', bytes: MOBILE_IMAGE_MAX_BYTES })).toBeNull();
    expect(rejectImage({ count: 0, name: 'IMG_1.jpg', bytes: Math.round(8.5 * 1024 * 1024) })).toBe('IMG_1.jpg は添付できません。1 枚 5 MB までです（8.5 MB）');
  });
});

describe('imageFailureText', () => {
  it('分からない失敗は番号を句点の前に、理由のある失敗は理由の文を続ける', () => {
    expect(imageFailureText(new ImageError('server', 500), '画像を送信できませんでした', 'もう一度送信してください。')).toBe('画像を送信できませんでした（500）。もう一度送信してください。');
    expect(imageFailureText(new ImageError('network'), '画像を送信できませんでした', 'もう一度送信してください。')).toBe('画像を送信できませんでした。通信を確認してください。もう一度送信してください。');
    expect(imageFailureText(new ImageError('too-many', 429), 'x', '')).toBe('x。クラウドに保存している画像が上限の 40 枚に達しています。PC が受信すると消えます。');
    expect(imageFailureText(new ImageError('unpaired', 401), 'x', '')).toBe('x。このスマホの接続は解除されています。');
    expect(imageFailureText(new ImageError('unpaired', 401, 'expired'), 'x', '')).toBe('x。このスマホの接続は期限が切れています。');
  });
});

/** XMLHttpRequest の代わり。送った中身を持ち、呼び手が応答を決める。 */
class FakeXhr {
  /** send が呼ばれたら、待っている試験へ渡す。waitFor の見回りは使わない（古い値を拾い、重いと取り違える）。 */
  static waiters: Array<(x: FakeXhr) => void> = [];
  /** 次に送られる XHR を待つ。putImage を呼ぶ前に作る。 */
  static nextSend(): Promise<FakeXhr> {
    return new Promise((resolve) => FakeXhr.waiters.push(resolve));
  }
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  open(m: string, u: string): void {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k.toLowerCase()] = v;
  }
  send(b: unknown): void {
    this.body = b;
    for (const w of FakeXhr.waiters.splice(0)) w(this);
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  compat: string | null = null;
  getResponseHeader(k: string): string | null {
    return k.toLowerCase() === COMPAT_HEADER ? this.compat : null;
  }
  respond(status: number, body: unknown = {}, compat: number | null = null): void {
    this.status = status;
    this.compat = compat === null ? null : String(compat);
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const xhr = (): XMLHttpRequest => new FakeXhr() as unknown as XMLHttpRequest;

async function sentOf(x: FakeXhr): Promise<Uint8Array> {
  expect(x.body).toBeInstanceOf(Blob);
  return new Uint8Array(await (x.body as Blob).arrayBuffer());
}

describe('putImage', () => {
  beforeEach(() => {
    FakeXhr.waiters = [];
  });

  it('aadImage(依頼, 番号) で封じ、XMLHttpRequest で PUT /m/blobs/<依頼>/<番号> に Blob を送る（進みを渡す）', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const pct: number[] = [];
    const sent = FakeXhr.nextSend();
    const p = putImage(pairing, at1(key), 'L-1', 2, data, { xhr, onProgress: (n) => pct.push(n) });
    const x = await sent;
    expect(x.method).toBe('PUT');
    expect(x.url).toBe(`${WORKER}/m/blobs/L-1/2`);
    expect(x.headers.authorization).toBe('Bearer tok-1');
    expect(x.headers[COMPAT_HEADER]).toBeTruthy();
    const sealed = await sentOf(x);
    expect(Array.from(await openBytes(key, aadImage('L-1', 2), sealed))).toEqual([1, 2, 3, 4, 5]);
    x.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    x.respond(201, { ok: true });
    await p;
    expect(pct).toEqual([50, 100]);
  });

  it('断りの理由を分ける', async () => {
    const reasonOf = async (status: number, body: unknown, compat: number | null = null): Promise<string> => {
      const sent = FakeXhr.nextSend();
      const p = putImage(pairing, at1(key), 'L-1', 0, new Uint8Array([1]), { xhr });
      (await sent).respond(status, body, compat);
      try {
        await p;
        return 'ok';
      } catch (e) {
        expect(e).toBeInstanceOf(ImageError);
        return (e as ImageError).reason;
      }
    };
    expect(await reasonOf(413, { error: 'payload too large' })).toBe('too-large');
    expect(await reasonOf(429, { error: 'too many images' })).toBe('too-many');
    expect(await reasonOf(429, { error: 'rate limited' })).toBe('rate-limited');
    expect(await reasonOf(401, {})).toBe('unpaired');
    {
      const sent = FakeXhr.nextSend();
      const p = putImage(pairing, at1(key), 'L-1', 0, new Uint8Array([1]), { xhr });
      (await sent).respond(401, { error: 'expired' }, null);
      await expect(p).rejects.toMatchObject({ reason: 'unpaired', unpairedReason: 'expired' });
    }
    expect(await reasonOf(400, { error: 'invalid key' })).toBe('server');
    // 画像の口の無い古い Worker（rc.1 も JSON の 404 を返す）は、版の見出しで見分ける。
    expect(await reasonOf(404, { error: 'not found' }, MOBILE_BELL_MIN_WORKER_COMPAT - 1)).toBe('unsupported');
    expect(await reasonOf(201, { ok: true }, MOBILE_BELL_MIN_WORKER_COMPAT - 1)).toBe('unsupported');
    expect(await reasonOf(201, { ok: true }, MOBILE_BELL_MIN_WORKER_COMPAT)).toBe('ok');
  });

  it('通信が切れたら network、外したら aborted', async () => {
    const sent = FakeXhr.nextSend();
    const p = putImage(pairing, at1(key), 'L-1', 0, new Uint8Array([1]), { xhr });
    (await sent).onerror?.();
    await expect(p).rejects.toMatchObject({ reason: 'network' });
    const ac = new AbortController();
    const sent2 = FakeXhr.nextSend();
    const q = putImage(pairing, at1(key), 'L-1', 0, new Uint8Array([1]), { xhr, signal: ac.signal });
    const x2 = await sent2;
    ac.abort();
    await expect(q).rejects.toMatchObject({ reason: 'aborted' });
    expect(x2.aborted).toBe(true);
  });
});

describe('useAttachments', () => {
  type Put = { launchId: string; n: number; data: Uint8Array; onProgress?: (n: number) => void; resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal };
  let puts: Put[];
  let put: PutImage;
  let shrink: Shrink;
  let urls: string[];
  let revoked: string[];

  beforeEach(() => {
    puts = [];
    urls = [];
    revoked = [];
    put = vi.fn((_p, _k, launchId, n, data, o) => new Promise<void>((resolve, reject) => puts.push({ launchId, n, data, onProgress: o?.onProgress, signal: o?.signal, resolve, reject })));
    shrink = vi.fn(async (f: Blob) => ({ data: new Uint8Array(await f.arrayBuffer()), mime: 'image/jpeg' as const }));
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: vi.fn(() => {
        const u = `blob:x/${urls.length}`;
        urls.push(u);
        return u;
      }),
      revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
    }));
  });

  const file = (name: string, size = 10): File => new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
  const hook = () => renderHook(() => useAttachments({ pairing, key: at1(key), launchId: 'L-1', put, shrink }));

  it('縮めてサムネイルを作り、依頼の ID と空いた番号で置く。進みと済みを持つ', async () => {
    const { result } = hook();
    await act(() => result.current.add([file('a.jpg'), file('b.jpg')]));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(shrink).toHaveBeenCalledTimes(2);
    expect(puts.map((p) => [p.launchId, p.n])).toEqual([
      ['L-1', 0],
      ['L-1', 1],
    ]);
    expect(result.current.items.map((i) => [i.url, i.state])).toEqual([
      ['blob:x/0', 'up'],
      ['blob:x/1', 'up'],
    ]);
    act(() => puts[0]!.onProgress?.(40));
    expect(result.current.items[0]!.pct).toBe(40);
    await act(async () => puts[0]!.resolve());
    expect(result.current.items[0]!.state).toBe('done');
    expect(result.current.busy).toBe(true);
    await act(async () => puts[1]!.resolve());
    expect(result.current.busy).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(result.current.ready.map((r) => [r.n, r.mime, r.data.length])).toEqual([
      [0, 'image/jpeg', 10],
      [1, 'image/jpeg', 10],
    ]);
  });

  it('5 枚目と 5 MB を超えるものは断って知らせる', async () => {
    shrink = vi.fn(async (f: Blob) => ({ data: new Uint8Array(f.size), mime: 'image/jpeg' as const }));
    const { result } = hook();
    const big = file('big.jpg', MOBILE_IMAGE_MAX_BYTES + 1);
    await act(() => result.current.add([big]));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.notice).toMatch(/big\.jpg は添付できません。1 枚 5 MB までです/);
    await act(() => result.current.add([file('1'), file('2'), file('3'), file('4'), file('5')]));
    expect(result.current.items).toHaveLength(4);
    expect(result.current.notice).toBe('4 枚までです。1 枚削除してから追加してください。');
  });

  it('失敗したものは送り直せ、×で外すと送るのをやめてサムネイルを放す。外した番号は次に使う', async () => {
    const { result } = hook();
    await act(() => result.current.add([file('a'), file('b')]));
    await waitFor(() => expect(puts).toHaveLength(2));
    await act(async () => puts[0]!.reject(new ImageError('network')));
    expect(result.current.items[0]!.state).toBe('fail');
    expect(result.current.failed).toBe(true);
    expect(result.current.notice).toMatch(/タップすると、もう一度送信します/);
    act(() => result.current.retry(result.current.items[0]!.id));
    await waitFor(() => expect(puts).toHaveLength(3));
    expect(puts[2]!.n).toBe(0);
    expect(result.current.items[0]!.state).toBe('up');
    const second = result.current.items[1]!;
    act(() => result.current.remove(second.id));
    expect(puts[1]!.signal?.aborted).toBe(true);
    await act(async () => puts[1]!.reject(new ImageError('aborted')));
    expect(result.current.items).toHaveLength(1);
    expect(revoked).toContain(second.url);
    await act(() => result.current.add([file('c')]));
    await waitFor(() => expect(puts).toHaveLength(4));
    expect(puts[3]!.n).toBe(1);
  });

  it('画面を閉じると送るのをやめ、サムネイルを全部放す', async () => {
    const { result, unmount } = hook();
    await act(() => result.current.add([file('a')]));
    await waitFor(() => expect(puts).toHaveLength(1));
    unmount();
    expect(puts[0]!.signal?.aborted).toBe(true);
    expect(revoked).toEqual(['blob:x/0']);
  });
});
