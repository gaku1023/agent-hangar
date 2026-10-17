/**
 * keybox：鍵を受け取る相手の X25519 公開鍵に、使い捨ての鍵ペアで鍵を封じる形。
 *
 * `sealed = 使い捨ての公開鍵(32) || iv(12) || AES-256-GCM(鍵, 中身)` で、
 * 鍵は `HKDF(ECDH, salt = 使い捨ての公開鍵 || 相手の公開鍵, info = KEYBOX_INFO)` である。
 * AAD は世代の番号と相手の ID（PC の ID か recovery）で、別の世代や別の相手の keybox と取り違えると開けない。
 */

import { concatBytes, fromBase64Url, fromBase64UrlLen, utf8 } from './bytes.ts';
import { ecdhBits, hkdf, importAesKey } from './keys.ts';
import { E2eOpenError } from './seal.ts';

export const KEYBOX_INFO = 'hangar-keybox-v1';

const PUB_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export type KeyboxAad = { epoch: number; recipient: string };

const aadBytes = (a: KeyboxAad): Uint8Array<ArrayBuffer> => utf8.encode(JSON.stringify(['keybox', a.epoch, a.recipient]));

async function boxKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Promise<CryptoKey> {
  return importAesKey(await hkdf(shared, concatBytes(ephPub, recipientPub), KEYBOX_INFO, 32));
}

/** 相手の公開鍵に中身を封じる。 */
export async function sealKeybox(recipientPub: string, aad: KeyboxAad, content: Uint8Array): Promise<Uint8Array> {
  const recipient = fromBase64UrlLen(recipientPub, PUB_LEN, '相手の公開鍵');
  const eph = (await globalThis.crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', eph.publicKey));
  const key = await boxKey(await ecdhBits(eph.privateKey, recipient), ephPub, recipient);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadBytes(aad) }, key, content as BufferSource));
  return concatBytes(ephPub, iv, ct);
}

/** 自分の秘密鍵で keybox を開く。myPub は自分の公開鍵（HKDF の salt に入る）。 */
export async function openKeybox(myPriv: CryptoKey, myPub: string, aad: KeyboxAad, sealed: Uint8Array): Promise<Uint8Array> {
  if (!(sealed instanceof Uint8Array) || sealed.length < PUB_LEN + IV_LEN + TAG_LEN) throw new E2eOpenError();
  try {
    const me = fromBase64UrlLen(myPub, PUB_LEN, '自分の公開鍵');
    const ephPub = sealed.slice(0, PUB_LEN);
    const key = await boxKey(await ecdhBits(myPriv, ephPub), ephPub, me);
    const iv = sealed.slice(PUB_LEN, PUB_LEN + IV_LEN);
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aadBytes(aad) }, key, sealed.slice(PUB_LEN + IV_LEN)));
  } catch {
    throw new E2eOpenError();
  }
}

/**
 * 世代鍵の keybox の中身。世代 1 から n までの鍵の一覧で、キーは世代の番号の文字列、値は base64url の 32 バイト。
 * 新しく参加した PC も、過去の世代で封じた行とファイルを開ける。
 */
export type EpochList = { epochs: Record<string, string> };

export function encodeEpochList(list: EpochList): Uint8Array {
  return utf8.encode(JSON.stringify({ epochs: list.epochs }));
}

/** 一覧を読む。形が違えば E2eOpenError を投げる。 */
export function decodeEpochList(bytes: Uint8Array): EpochList {
  let v: unknown;
  try {
    v = JSON.parse(utf8.decode(bytes));
  } catch {
    throw new E2eOpenError();
  }
  const epochs = (v as { epochs?: unknown } | null)?.epochs;
  if (typeof epochs !== 'object' || epochs === null || Array.isArray(epochs)) throw new E2eOpenError();
  const out: Record<string, string> = {};
  for (const [n, key] of Object.entries(epochs)) {
    if (!/^[1-9][0-9]{0,8}$/.test(n) || typeof key !== 'string' || fromBase64Url(key)?.length !== 32) throw new E2eOpenError();
    out[n] = key;
  }
  return { epochs: out };
}
