/**
 * 受け箱の封：Worker が受けた webhook の荷物を、受け箱の X25519 公開鍵に封じる形（#563）。
 *
 * PC は受け箱ごとに鍵の対を作り、公開鍵だけを Worker に渡す。
 * Worker は届いた本文と見出しをこの公開鍵で封じてから置き、中身を読まない。
 * 開けるのは秘密鍵を持つ PC だけである。
 *
 * 封は `<版>.<base64url>` の文字列で、版は INBOX_SEAL_VERSION（今は 1）。
 * base64url の中身は `使い捨ての公開鍵(32) || sealJson の形（版 0x02、iv、AES-256-GCM、大きければ gzip）` である。
 * 鍵は `HKDF(ECDH, salt = 使い捨ての公開鍵 || 受け箱の公開鍵, info = INBOX_INFO)` で、keybox と同じ組み方にする。
 * AAD は `["inbox", inboxId]` の JSON で、別の受け箱の荷物と取り違えると開けない。
 * 封じるたびに使い捨ての鍵ペアを作るので、同じ荷物でも封は毎回違う。
 *
 * Worker（workerd）と PC（Node）の両方から読むので、`globalThis.crypto.subtle` だけを使う。
 */

import { concatBytes, fromBase64Url, fromBase64UrlLen, toBase64Url } from './bytes.ts';
import { ecdhBits, generateKeyPair, hkdf, importAesKey, importPrivate } from './keys.ts';
import { E2eOpenError, openJson, sealJson } from './seal.ts';

export const INBOX_INFO = 'hangar-inbox-v1';

/** 封の文字列の頭の版。 */
export const INBOX_SEAL_VERSION = '1';

/** 荷物に残す見出し（小文字）。これ以外の見出しは封じない。 */
export const INBOX_HEADER_NAMES = ['x-github-event', 'x-github-delivery', 'x-hub-signature-256', 'content-type'] as const;

/** 受け箱に届いた荷物。receivedAt は Worker が受けた時刻（ミリ秒）、body は届いた本文そのもの。 */
export type InboxParcel = { receivedAt: number; headers: Record<string, string>; body: string };

const PUB_LEN = 32;

const ALLOWED = new Set<string>(INBOX_HEADER_NAMES);

const aadString = (inboxId: string): string => JSON.stringify(['inbox', inboxId]);

/** 見出しの名前を小文字にし、決まった名前で値が文字列のものだけを残す。 */
function pickHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (ALLOWED.has(lower) && typeof value === 'string') out[lower] = value;
  }
  return out;
}

async function parcelKey(shared: Uint8Array, ephPub: Uint8Array, inboxPub: Uint8Array): Promise<CryptoKey> {
  return importAesKey(await hkdf(shared, concatBytes(ephPub, inboxPub), INBOX_INFO, 32));
}

/** 秘密鍵（raw の 32 バイト）から公開鍵の raw を求める。 */
async function publicOf(priv: string): Promise<Uint8Array> {
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', await importPrivate(priv, true));
  return fromBase64UrlLen(jwk.x ?? '', PUB_LEN, '受け箱の公開鍵');
}

/** 受け箱の鍵の対を作る。どちらも raw の 32 バイトの base64url。 */
export async function generateInboxKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const { pub, priv } = await generateKeyPair();
  return { publicKey: pub, privateKey: priv };
}

/** 荷物を受け箱の公開鍵に封じる。見出しは小文字にし、INBOX_HEADER_NAMES の 4 つだけを残す。 */
export async function sealToInbox(publicKey: string, inboxId: string, value: InboxParcel): Promise<string> {
  const inboxPub = fromBase64UrlLen(publicKey, PUB_LEN, '受け箱の公開鍵');
  const eph = (await globalThis.crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', eph.publicKey));
  const key = await parcelKey(await ecdhBits(eph.privateKey, inboxPub), ephPub, inboxPub);
  const parcel: InboxParcel = { receivedAt: value.receivedAt, headers: pickHeaders(value.headers), body: value.body };
  const sealed = await sealJson(key, aadString(inboxId), parcel);
  return `${INBOX_SEAL_VERSION}.${toBase64Url(concatBytes(ephPub, sealed))}`;
}

/** 受け箱の秘密鍵で荷物を開く。鍵、受け箱、中身、形のどれが違っても E2eOpenError を投げる。 */
export async function openFromInbox(privateKey: string, inboxId: string, sealed: string): Promise<InboxParcel> {
  if (typeof sealed !== 'string') throw new E2eOpenError();
  const dot = sealed.indexOf('.');
  if (dot < 0 || sealed.slice(0, dot) !== INBOX_SEAL_VERSION) throw new E2eOpenError();
  const bytes = fromBase64Url(sealed.slice(dot + 1));
  if (!bytes || bytes.length <= PUB_LEN) throw new E2eOpenError();
  let v: unknown;
  try {
    const ephPub = bytes.slice(0, PUB_LEN);
    const key = await parcelKey(await ecdhBits(await importPrivate(privateKey), ephPub), ephPub, await publicOf(privateKey));
    v = await openJson(key, aadString(inboxId), bytes.slice(PUB_LEN));
  } catch {
    throw new E2eOpenError();
  }
  const p = v as Partial<Record<keyof InboxParcel, unknown>> | null;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new E2eOpenError();
  const { receivedAt, headers, body } = p;
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || typeof body !== 'string') throw new E2eOpenError();
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) throw new E2eOpenError();
  if (Object.values(headers).some((h) => typeof h !== 'string')) throw new E2eOpenError();
  return { receivedAt, headers: pickHeaders(headers as Record<string, unknown>), body };
}
