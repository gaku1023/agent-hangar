/**
 * 参加コード：参加済みの PC が発行する 8 文字のコード（5 分、1 回限り）と、そこから導く値。
 *
 * 字種は読み違えやすい 0 O 1 I L U を除いた 30 字で、表示は `XXXX-XXXX` にする。
 * D1 には正規化したコードの SHA-256 だけを置く。
 * 確認コードと参加リクエストの封の鍵は、正規化したコード（8 字、大文字、区切りなし）の UTF-8 から HKDF で導く。
 */

import { concatBytes, fromBase64Url, fromBase64UrlLen, toBase64Url, toHex, utf8 } from './bytes.ts';
import { hkdf, importAesKey } from './keys.ts';
import { E2eOpenError } from './seal.ts';

const IV_LEN = 12;
const TAG_LEN = 16;

export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const JOIN_CODE_LEN = 8;

const SAS_INFO = 'hangar-join-sas-v1';
const REQ_SALT = 'hangar-join-v1';
const REQ_INFO = 'hangar-join-req-v1';

/** 参加コードを作る。表示の形 `XXXX-XXXX` で返す。 */
export function generateJoinCode(): string {
  const n = JOIN_CODE_ALPHABET.length;
  // 偏りを出さないよう、30 の倍数に収まらないバイトは捨てて引き直す。
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < JOIN_CODE_LEN) {
    for (const b of globalThis.crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < JOIN_CODE_LEN) out += JOIN_CODE_ALPHABET[b % n];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * 入力されたコードを正規化する。
 * 全角を半角にし、大文字にし、ハイフンの類と空白を捨てる。
 * 8 字で字種の中なら返し、そうでなければ null を返す。
 */
export function normalizeJoinCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const s = input
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s\-‐-―−ーｰ]/g, '');
  if (s.length !== JOIN_CODE_LEN) return null;
  for (const ch of s) if (!JOIN_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

function mustNormalize(code: string): string {
  const n = normalizeJoinCode(code);
  if (n === null) throw new TypeError('参加コードの形が違います');
  return n;
}

/** 正規化したコードの SHA-256 の hex。D1 に置くのはこれだけ。 */
export async function joinCodeHash(code: string): Promise<string> {
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(mustNormalize(code)))));
}

/**
 * 確認コード（6 桁の数字）。
 * `HKDF(コード, salt = 新しい PC の公開鍵の raw 32 バイト, info = hangar-join-sas-v1)` の 4 バイトを uint32 として 10^6 で割った余りを 0 埋めする。
 * 表示の区切り（`123 456`）は画面で付ける。
 */
export async function deriveSas(code: string, newPcPub: string): Promise<string> {
  const pub = fromBase64UrlLen(newPcPub, 32, '新しい PC の公開鍵');
  const b = await hkdf(utf8.encode(mustNormalize(code)), pub, SAS_INFO, 4);
  const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
  return String(n % 1_000_000).padStart(6, '0');
}

/** 参加リクエストの中身。新しい PC の公開鍵、名前、OS。 */
export type JoinRequestBody = { pub: string; name: string; os: string };

async function requestKey(code: string): Promise<CryptoKey> {
  return importAesKey(await hkdf(utf8.encode(mustNormalize(code)), utf8.encode(REQ_SALT), REQ_INFO, 32));
}

const requestAad = (codeHash: string): string => `join:${codeHash}`;

/**
 * 参加リクエストを参加コードで封じる。
 * 戻りは base64url(iv(12) || AES-256-GCM) で、そのまま Worker に送る。
 */
export async function sealJoinRequest(code: string, codeHash: string, body: JoinRequestBody): Promise<string> {
  const plain = utf8.encode(JSON.stringify({ pub: body.pub, name: body.name, os: body.os }));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(requestAad(codeHash)) }, await requestKey(code), plain));
  return toBase64Url(concatBytes(iv, ct));
}

/** 参加リクエストを開く（発行した PC だけが呼ぶ）。コードかハッシュが違えば E2eOpenError を投げる。 */
export async function openJoinRequest(code: string, codeHash: string, sealed: string): Promise<JoinRequestBody> {
  const raw = fromBase64Url(sealed);
  if (!raw || raw.length < IV_LEN + TAG_LEN) throw new E2eOpenError();
  let v: Record<string, unknown> | null;
  try {
    const key = await requestKey(code);
    const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, IV_LEN), additionalData: utf8.encode(requestAad(codeHash)) }, key, raw.slice(IV_LEN));
    v = JSON.parse(utf8.decode(new Uint8Array(plain))) as Record<string, unknown> | null;
  } catch {
    throw new E2eOpenError();
  }
  if (typeof v !== 'object' || v === null || typeof v.pub !== 'string' || fromBase64Url(v.pub)?.length !== 32 || typeof v.name !== 'string' || typeof v.os !== 'string') throw new E2eOpenError();
  return { pub: v.pub, name: v.name, os: v.os };
}
