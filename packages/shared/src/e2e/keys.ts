/**
 * E2E の鍵（X25519 の鍵ペア、世代鍵、世代鍵から導く用途の鍵）。
 *
 * PC とスマホの両方から読むので、`globalThis.crypto.subtle` だけを使う。
 * 鍵はどれも base64url の生バイトで持つ（X25519 は 32 バイト、世代鍵は 32 バイト）。
 * WebCrypto は X25519 の秘密鍵を raw で出し入れできないので、pkcs8 の決まった前置きを付け外しする。
 */

import { concatBytes, fromBase64UrlLen, toBase64Url, utf8 } from './bytes.ts';

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

/** X25519 の鍵ペア。どちらも raw の 32 バイトの base64url。 */
export type KeyPairRaw = { pub: string; priv: string };

/** X25519 の秘密鍵の pkcs8 の前置き（RFC 8410）。後ろに raw の 32 バイトが続く。 */
const PKCS8_X25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

const X25519 = { name: 'X25519' } as const;

async function exportPub(key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle().exportKey('raw', key)));
}

/** 取り出せる鍵ペアを作り、raw の値で返す（PC 用。`cloud.json` に置く）。 */
export async function generateKeyPair(): Promise<KeyPairRaw> {
  const pair = (await subtle().generateKey(X25519, true, ['deriveBits'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
  if (pkcs8.length !== PKCS8_X25519_PREFIX.length + 32) throw new Error('X25519 の秘密鍵の形が想定と違います');
  return { pub: await exportPub(pair.publicKey), priv: toBase64Url(pkcs8.subarray(PKCS8_X25519_PREFIX.length)) };
}

/** 秘密鍵を取り出せない鍵ペアを作る（スマホ用。IndexedDB に CryptoKey のまま置く）。 */
export async function generateKeyPairNonExtractable(): Promise<{ pub: string; key: CryptoKey }> {
  const pair = (await subtle().generateKey(X25519, false, ['deriveBits'])) as CryptoKeyPair;
  return { pub: await exportPub(pair.publicKey), key: pair.privateKey };
}

/** raw の秘密鍵を CryptoKey にする。既定では取り出せない鍵にする。 */
export async function importPrivate(priv: string, extractable = false): Promise<CryptoKey> {
  const raw = fromBase64UrlLen(priv, 32, 'X25519 の秘密鍵');
  return subtle().importKey('pkcs8', concatBytes(PKCS8_X25519_PREFIX, raw), X25519, extractable, ['deriveBits']);
}

/** raw の公開鍵を CryptoKey にする。 */
export async function importPublic(pub: string): Promise<CryptoKey> {
  return subtle().importKey('raw', fromBase64UrlLen(pub, 32, 'X25519 の公開鍵'), X25519, true, []);
}

/** ECDH の共有の秘密（32 バイト）。 */
export async function ecdhBits(priv: CryptoKey, pub: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const pubKey = typeof pub === 'string' ? await importPublic(pub) : await subtle().importKey('raw', pub as BufferSource, X25519, true, []);
  return new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: pubKey }, priv, 256));
}

/** HKDF-SHA256 で長さ len バイトを導く。 */
export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, len: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await subtle().importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: utf8.encode(info) }, base, len * 8);
  return new Uint8Array(bits);
}

/** AES-256-GCM の鍵にする。取り出せない鍵にする。 */
export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** HMAC-SHA256 の鍵にする。取り出せない鍵にする。 */
export async function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** 世代鍵（32 バイトの乱数）を作る。 */
export function randomEpochKey(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** 世代鍵から導く用途。 */
export type Purpose = 'row' | 'index' | 'fp' | 'file' | 'roster';

/** 用途ごとの HKDF の info。値を変えると、過去に封じたものが開けなくなる。 */
export const PURPOSE_INFO: Record<Purpose, string> = {
  row: 'hangar-e2e-v2/row',
  index: 'hangar-e2e-v2/index',
  fp: 'hangar-e2e-v2/fp',
  file: 'hangar-e2e-v2/file',
  roster: 'hangar-e2e-v2/roster',
};

/** 世代鍵から用途の鍵の生の 32 バイトを導く（salt は空）。 */
export async function deriveSubkeyBytes(epochKey: string, purpose: Purpose): Promise<Uint8Array> {
  return hkdf(fromBase64UrlLen(epochKey, 32, '世代鍵'), new Uint8Array(0), PURPOSE_INFO[purpose], 32);
}

/**
 * 1 つの世代の用途の鍵。
 * row と roster は AES-256-GCM、index と fp は HMAC-SHA256 の鍵。
 * fileBytes は R2 の本文の鍵の生バイトで、サーバの node:crypto のストリーム暗号に渡す。
 */
export type EpochKeys = { epoch: number; row: CryptoKey; index: CryptoKey; fp: CryptoKey; roster: CryptoKey; fileBytes: Uint8Array };

export async function deriveEpochKeys(epoch: number, epochKey: string): Promise<EpochKeys> {
  const [row, index, fp, roster, fileBytes] = await Promise.all([
    deriveSubkeyBytes(epochKey, 'row').then(importAesKey),
    deriveSubkeyBytes(epochKey, 'index').then(importHmacKey),
    deriveSubkeyBytes(epochKey, 'fp').then(importHmacKey),
    deriveSubkeyBytes(epochKey, 'roster').then(importAesKey),
    deriveSubkeyBytes(epochKey, 'file'),
  ]);
  return { epoch, row, index, fp, roster, fileBytes };
}
