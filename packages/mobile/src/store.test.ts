import { aadFeed, open, seal } from '@agent-hangar/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPairing, loadKey, loadPairing, saveKey, savePairing } from './store.ts';
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

describe('key (IndexedDB)', () => {
  it('saveKey した鍵を loadKey で取り出して開封に使え、exportKey は失敗する', async () => {
    const key = await makeKey();
    const sealed = await seal(key, aadFeed('pc-1'), { hello: 'world' });
    await saveKey(key);
    const back = await loadKey();
    expect(back).not.toBeNull();
    expect(back!.extractable).toBe(false);
    expect(await open(back!, aadFeed('pc-1'), sealed)).toEqual({ hello: 'world' });
    await expect(globalThis.crypto.subtle.exportKey('raw', back!)).rejects.toThrow();
  });

  it('IndexedDB が無いとき loadKey は null', async () => {
    const idb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
    try {
      expect(await loadKey()).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true });
    }
  });
});
