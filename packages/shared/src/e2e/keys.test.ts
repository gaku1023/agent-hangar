import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from './bytes.ts';
import { PURPOSE_INFO, deriveEpochKeys, deriveSubkeyBytes, generateKeyPair, generateKeyPairNonExtractable, importPrivate, importPublic, randomEpochKey, type Purpose } from './keys.ts';

const PURPOSES: Purpose[] = ['row', 'index', 'fp', 'file', 'roster'];

async function ecdh(priv: CryptoKey, pub: string): Promise<string> {
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'X25519', public: await importPublic(pub) }, priv, 256);
  return toBase64Url(new Uint8Array(bits));
}

describe('世代鍵と用途の鍵', () => {
  it('info は hangar-e2e-v2/<用途>', () => {
    for (const p of PURPOSES) expect(PURPOSE_INFO[p]).toBe(`hangar-e2e-v2/${p}`);
  });

  it('randomEpochKey は 32 バイトで毎回違う', () => {
    const a = randomEpochKey();
    expect(fromBase64Url(a)?.length).toBe(32);
    expect(randomEpochKey()).not.toBe(a);
  });

  it('HKDF の用途ごとに別の鍵になる', async () => {
    const k = randomEpochKey();
    const raws = await Promise.all(PURPOSES.map(async (p) => toBase64Url(await deriveSubkeyBytes(k, p))));
    for (const r of raws) expect(fromBase64Url(r)?.length).toBe(32);
    expect(new Set(raws).size).toBe(5);
  });

  it('同じ世代鍵からは同じ用途の鍵', async () => {
    const k = randomEpochKey();
    for (const p of PURPOSES) expect(toBase64Url(await deriveSubkeyBytes(k, p))).toBe(toBase64Url(await deriveSubkeyBytes(k, p)));
    const other = randomEpochKey();
    expect(toBase64Url(await deriveSubkeyBytes(k, 'row'))).not.toBe(toBase64Url(await deriveSubkeyBytes(other, 'row')));
  });

  it('deriveEpochKeys は世代の番号と用途の鍵を返し、fileBytes は /file の生バイト', async () => {
    const k = randomEpochKey();
    const ek = await deriveEpochKeys(3, k);
    expect(ek.epoch).toBe(3);
    expect(toBase64Url(ek.fileBytes)).toBe(toBase64Url(await deriveSubkeyBytes(k, 'file')));
    expect(ek.row.algorithm.name).toBe('AES-GCM');
    expect(ek.roster.algorithm.name).toBe('AES-GCM');
    expect(ek.index.algorithm.name).toBe('HMAC');
    expect(ek.fp.algorithm.name).toBe('HMAC');
    expect(ek.row.extractable).toBe(false);
  });

  it('世代鍵の形が違えば断る', async () => {
    await expect(deriveSubkeyBytes('短い', 'row')).rejects.toThrow();
    await expect(deriveSubkeyBytes(toBase64Url(new Uint8Array(16)), 'row')).rejects.toThrow();
  });
});

describe('X25519 の鍵ペア', () => {
  it('generateKeyPair の raw を import し直して ECDH が一致する', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    expect(fromBase64Url(a.pub)?.length).toBe(32);
    expect(fromBase64Url(a.priv)?.length).toBe(32);
    const ab = await ecdh(await importPrivate(a.priv), b.pub);
    const ba = await ecdh(await importPrivate(b.priv), a.pub);
    expect(ab).toBe(ba);
  });

  it('importPrivate は既定で取り出せない鍵、true なら取り出せる鍵', async () => {
    const a = await generateKeyPair();
    expect((await importPrivate(a.priv)).extractable).toBe(false);
    expect((await importPrivate(a.priv, true)).extractable).toBe(true);
  });

  it('取り出せない鍵ペア（スマホ用）も ECDH が一致する', async () => {
    const phone = await generateKeyPairNonExtractable();
    const pc = await generateKeyPair();
    expect(phone.key.extractable).toBe(false);
    expect(fromBase64Url(phone.pub)?.length).toBe(32);
    expect(await ecdh(phone.key, pc.pub)).toBe(await ecdh(await importPrivate(pc.priv), phone.pub));
  });

  it('長さの違う鍵は import で断る', async () => {
    await expect(importPublic(toBase64Url(new Uint8Array(31)))).rejects.toThrow();
    await expect(importPrivate(toBase64Url(new Uint8Array(33)))).rejects.toThrow();
    await expect(importPublic('不正な文字')).rejects.toThrow();
  });
});
