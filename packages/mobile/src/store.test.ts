import { aadFeed, generatePhoneKeyPair, open, seal } from '@agent-hangar/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPairing, currentKey, KEEP_EPOCHS, loadPairing, loadPhoneKeys, loadPhonePair, savePairing, savePhoneKey, savePhonePair } from './store.ts';
import { makeKey } from './test/fixtures.ts';

const pairing = { url: 'https://hangar.example.workers.dev', token: 'tok-1', deviceId: 'phone-1' };

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('pairing (localStorage)', () => {
  it('保存して読み戻せる。消すと null', () => {
    savePairing(pairing);
    expect(loadPairing()).toEqual(pairing);
    clearPairing();
    expect(loadPairing()).toBeNull();
  });

  it('localStorage が投げても loadPairing は null を返す', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadPairing()).toBeNull();
  });

  it('localStorage が投げても savePairing と clearPairing は投げない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => savePairing(pairing)).not.toThrow();
    expect(() => clearPairing()).not.toThrow();
  });

  it('形の違う値は null', () => {
    localStorage.setItem('hangar.mobile.pairing', '{"url":1}');
    expect(loadPairing()).toBeNull();
    localStorage.setItem('hangar.mobile.pairing', 'not json');
    expect(loadPairing()).toBeNull();
  });
});

describe('鍵ペア（IndexedDB）', () => {
  it('秘密鍵は取り出せない CryptoKey のまま置かれ、読み戻しても exportKey できない', async () => {
    const pair = await generatePhoneKeyPair();
    await savePhonePair(pair);
    const back = await loadPhonePair();
    expect(back).not.toBeNull();
    expect(back!.pub).toBe(pair.pub);
    expect(back!.key).toBeInstanceOf(CryptoKey);
    expect(back!.key.extractable).toBe(false);
    // WebKit は X25519 の CryptoKey を IndexedDB から読み戻せない（bug 312279）ので、スマホの鍵ペアは P-256 にしてある。
    expect(back!.key.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' });
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', back!.key)).rejects.toThrow();
    await expect(globalThis.crypto.subtle.exportKey('jwk', back!.key)).rejects.toThrow();
    // localStorage には鍵の値も公開鍵も置かない。
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!)).not.toContain(pair.pub);
  });

  it('IndexedDB が無いとき loadPhonePair は null、loadPhoneKeys は空、savePhonePair は投げる', async () => {
    const idb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
    try {
      expect(await loadPhonePair()).toBeNull();
      expect((await loadPhoneKeys()).size).toBe(0);
      await expect(savePhonePair(await generatePhoneKeyPair())).rejects.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true });
    }
  });

  it('clearPairing は鍵ペアとスマホ用の鍵も消す', async () => {
    savePairing(pairing);
    await savePhonePair(await generatePhoneKeyPair());
    await savePhoneKey(1, await makeKey());
    await clearPairing();
    expect(await loadPhonePair()).toBeNull();
    expect((await loadPhoneKeys()).size).toBe(0);
  });
});

describe('スマホ用の鍵 M（IndexedDB、世代つき）', () => {
  it('世代ごとに置き、読み戻した鍵で開け、exportKey できない', async () => {
    await clearPairing();
    const k1 = await makeKey();
    const k2 = await makeKey();
    const sealed = await seal(k2, aadFeed('pc-1'), { hello: 'world' });
    await savePhoneKey(1, k1);
    const ring = await savePhoneKey(2, k2);
    expect([...ring.keys()].sort()).toEqual([1, 2]);
    const back = await loadPhoneKeys();
    expect([...back.keys()].sort()).toEqual([1, 2]);
    expect(back.get(2)!.extractable).toBe(false);
    expect(await open(back.get(2)!, aadFeed('pc-1'), sealed)).toEqual({ hello: 'world' });
    await expect(globalThis.crypto.subtle.exportKey('raw', back.get(2)!)).rejects.toThrow();
    expect(currentKey(back)).toEqual({ epoch: 2, key: back.get(2) });
  });

  it(`新しいほうから ${KEEP_EPOCHS} 世代だけ残す`, async () => {
    await clearPairing();
    let ring = await loadPhoneKeys();
    for (let e = 1; e <= KEEP_EPOCHS + 2; e++) ring = await savePhoneKey(e, await makeKey());
    expect([...ring.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: KEEP_EPOCHS }, (_, i) => i + 3));
    expect([...(await loadPhoneKeys()).keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: KEEP_EPOCHS }, (_, i) => i + 3));
  });

  it('鍵が無ければ currentKey は null', () => {
    expect(currentKey(new Map())).toBeNull();
  });
});
