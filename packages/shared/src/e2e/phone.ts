/**
 * スマホの接続の封（互換の版 9）。
 *
 * スマホは QR の券（ペアリングの券、`mobile_pairings` の行）から導いた鍵で、自分の公開鍵と名前を封じて `POST /m/join` に添える。
 * 券は 8 字の参加コードとは形が違うので、参加コードの正規化（joinCode.ts）を通さず、券の文字列の UTF-8 をそのまま HKDF に入れる。
 * AAD はスマホが名乗った ID で、Worker が封を別の ID の行に付け替えると PC は開けない。
 *
 * QR を表示している PC は券を知っているので、同じ関数で開き、スマホ用の鍵 `M[m]` をスマホの公開鍵に keybox で封じる。
 * keybox の形は PC の keybox（keybox.ts）と同じで、宛先はスマホの ID、中身は M の生の 32 バイトである。
 *
 * PC とスマホの両方から読むので、`globalThis.crypto.subtle` だけを使う。
 */

import { concatBytes, fromBase64Url, fromBase64UrlLen, toBase64Url, toHex, utf8 } from './bytes.ts';
import { hkdf, importAesKey } from './keys.ts';
import { openKeybox, sealKeybox } from './keybox.ts';
import { E2eOpenError } from './seal.ts';

const IV_LEN = 12;
const TAG_LEN = 16;

const JOIN_SALT = 'hangar-phone-join-v1';
const JOIN_INFO = 'hangar-phone-join-req-v1';

/** スマホ用の鍵 M の長さ（バイト）。 */
export const PHONE_KEY_LEN = 32;

/** スマホの参加リクエストの中身。X25519 の公開鍵（raw 32 バイトの base64url）と、PC の一覧に出す名前。 */
export type PhoneJoinBody = { pub: string; name: string };

/** 券の SHA-256 の hex。Worker の `mobile_pairings.code_hash` と同じ値で、PC は `GET /m/pairings/mine` の行と手元の券をこれで突き合わせる。 */
export async function phoneTicketHash(ticket: string): Promise<string> {
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(ticket))));
}

async function joinKey(ticket: string): Promise<CryptoKey> {
  return importAesKey(await hkdf(utf8.encode(ticket), utf8.encode(JOIN_SALT), JOIN_INFO, 32));
}

const joinAad = (deviceId: string): Uint8Array<ArrayBuffer> => utf8.encode(JSON.stringify(['phone-join', deviceId]));

/**
 * スマホの参加リクエストを券で封じる（スマホが呼ぶ）。
 * 戻りは base64url(iv(12) || AES-256-GCM) で、`MobileJoinRequest.sealed` にそのまま入れる。
 */
export async function sealPhoneJoinRequest(ticket: string, deviceId: string, body: PhoneJoinBody): Promise<string> {
  fromBase64UrlLen(body.pub, 32, 'スマホの公開鍵');
  const plain = utf8.encode(JSON.stringify({ pub: body.pub, name: body.name }));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: joinAad(deviceId) }, await joinKey(ticket), plain));
  return toBase64Url(concatBytes(iv, ct));
}

/** スマホの参加リクエストを開く（QR を表示した PC が呼ぶ）。券か ID が違う、壊れている、形が違うと E2eOpenError を投げる。 */
export async function openPhoneJoinRequest(ticket: string, deviceId: string, sealed: string): Promise<PhoneJoinBody> {
  const raw = fromBase64Url(sealed);
  if (!raw || raw.length < IV_LEN + TAG_LEN) throw new E2eOpenError();
  let v: Record<string, unknown> | null;
  try {
    const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, IV_LEN), additionalData: joinAad(deviceId) }, await joinKey(ticket), raw.slice(IV_LEN));
    v = JSON.parse(utf8.decode(new Uint8Array(plain))) as Record<string, unknown> | null;
  } catch {
    throw new E2eOpenError();
  }
  if (typeof v !== 'object' || v === null || typeof v.pub !== 'string' || fromBase64Url(v.pub)?.length !== 32 || typeof v.name !== 'string') throw new E2eOpenError();
  return { pub: v.pub, name: v.name };
}

/** スマホ用の鍵 M[epoch] をスマホの公開鍵に封じる（PC が呼び、`PUT /phone-keyboxes` に置く）。 */
export async function sealPhoneKeybox(phonePub: string, phoneId: string, epoch: number, phoneKey: Uint8Array): Promise<Uint8Array> {
  if (!(phoneKey instanceof Uint8Array) || phoneKey.length !== PHONE_KEY_LEN) throw new TypeError(`スマホ用の鍵の形が違います（${PHONE_KEY_LEN} バイト）`);
  return sealKeybox(phonePub, { epoch, recipient: phoneId }, phoneKey);
}

/**
 * `GET /m/keybox` の応答（`KeyboxOut`）をスマホの秘密鍵で開き、M の生の 32 バイトを返す（スマホが呼ぶ）。
 * 世代、宛先、鍵ペアのどれが違っても、中身が 32 バイトでなくても E2eOpenError を投げる。
 */
export async function openPhoneKeybox(priv: CryptoKey, pub: string, phoneId: string, box: { epoch: number; sealed: string }): Promise<Uint8Array> {
  const raw = typeof box.sealed === 'string' ? fromBase64Url(box.sealed) : null;
  if (!raw) throw new E2eOpenError();
  const out = await openKeybox(priv, pub, { epoch: box.epoch, recipient: phoneId }, raw);
  if (out.length !== PHONE_KEY_LEN) throw new E2eOpenError();
  return out;
}
