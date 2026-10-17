import { aadFeed, generateKeyPairNonExtractable, open, seal, sealPhoneKeybox, toBase64Url } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinError, UnpairedError } from './api.ts';
import { KEYBOX_GIVE_UP_MS, KEYBOX_POLL_MS, refreshPhoneKeys, waitPhoneKeys } from './keyring.ts';
import { clearPairing, loadPhoneKeys, savePhoneKey, type PhonePair } from './store.ts';
import { json, WORKER } from './test/pairText.ts';
import { makeKey } from './test/fixtures.ts';

const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };
let pair: PhonePair;
let fetchMock: ReturnType<typeof vi.fn>;

const mBytes = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(32));
const keyboxRes = async (epoch: number, m: Uint8Array, to: PhonePair = pair, id = 'phone-1'): Promise<Response> => json({ epoch, sealed: toBase64Url(await sealPhoneKeybox(to.pub, id, epoch, m)) });

/** 時計を進めるだけの sleep。 */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

beforeEach(async () => {
  await clearPairing();
  pair = await generateKeyPairNonExtractable();
  fetchMock = vi.fn(async () => json({ error: 'not found' }, 404));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('waitPhoneKeys（接続の後に keybox を待つ）', () => {
  it('間隔は 2 秒、最大 60 秒', () => {
    expect(KEYBOX_POLL_MS).toBe(2000);
    expect(KEYBOX_GIVE_UP_MS).toBe(60_000);
  });

  it('keybox が置かれるまで 2 秒ごとに GET /m/keybox を読み、置かれたら開いて M を手元に置く', async () => {
    const m = mBytes();
    let n = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${WORKER}/m/keybox`);
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
      n++;
      return n < 4 ? json({ error: 'not found' }, 404) : keyboxRes(2, m);
    });
    const c = clock();
    const ring = await waitPhoneKeys(pairing, pair, { now: c.now, sleep: c.sleep });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(c.slept).toEqual([2000, 2000, 2000]);
    expect([...ring.keys()]).toEqual([2]);
    const k = (await loadPhoneKeys()).get(2)!;
    expect(k.extractable).toBe(false);
    // 手元に置いた M は PC が封じた M と同じ鍵である。
    const pcKey = await globalThis.crypto.subtle.importKey('raw', m as BufferSource, 'AES-GCM', false, ['encrypt']);
    expect(await open(k, aadFeed('pc-1'), await seal(pcKey, aadFeed('pc-1'), { ok: 1 }))).toEqual({ ok: 1 });
  });

  it('60 秒たっても置かれなければ JoinError（keybox）で、それ以上は読まない', async () => {
    const c = clock();
    const err = await waitPhoneKeys(pairing, pair, { now: c.now, sleep: c.sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect((err as JoinError).reason).toBe('keybox');
    // 0 秒から 60 秒まで 2 秒ごと。
    expect(fetchMock).toHaveBeenCalledTimes(31);
    expect(c.now()).toBe(60_000);
    expect(c.slept.every((ms) => ms === 2000)).toBe(true);
  });

  it('通信の失敗と 5xx は待ち続ける', async () => {
    const m = mBytes();
    fetchMock
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(json({ error: 'boom' }, 500))
      .mockImplementation(async () => keyboxRes(1, m));
    const c = clock();
    const ring = await waitPhoneKeys(pairing, pair, { now: c.now, sleep: c.sleep });
    expect([...ring.keys()]).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('401 expired は UnpairedError（expired）で、待つのをやめる', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'expired' }, 401));
    const c = clock();
    const err = await waitPhoneKeys(pairing, pair, { now: c.now, sleep: c.sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnpairedError);
    expect((err as UnpairedError).reason).toBe('expired');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('refreshPhoneKeys（新しい世代の keybox を読み直す）', () => {
  it('新しい世代を手元の鍵に足す', async () => {
    await savePhoneKey(1, await makeKey());
    fetchMock.mockImplementation(async () => keyboxRes(2, mBytes()));
    const ring = await refreshPhoneKeys(pairing, pair);
    expect([...ring.keys()].sort()).toEqual([1, 2]);
    expect([...(await loadPhoneKeys()).keys()].sort()).toEqual([1, 2]);
  });

  it('keybox が無い（404）、開けないときは手元の鍵のまま', async () => {
    await savePhoneKey(1, await makeKey());
    expect([...(await refreshPhoneKeys(pairing, pair)).keys()]).toEqual([1]);
    const other = await generateKeyPairNonExtractable();
    fetchMock.mockImplementation(async () => keyboxRes(2, mBytes(), other));
    expect([...(await refreshPhoneKeys(pairing, pair)).keys()]).toEqual([1]);
  });

  it('401 は UnpairedError（本文の error を reason に）', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'revoked' }, 401));
    const err = await refreshPhoneKeys(pairing, pair).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnpairedError);
    expect((err as UnpairedError).reason).toBe('revoked');
  });
});
