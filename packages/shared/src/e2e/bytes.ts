/**
 * E2E の部品が使う、バイト列の小道具（base64url、base32、hex、UTF-8、連結）。
 *
 * PC とスマホの両方から読むので、`node:crypto` や Buffer を使わない。
 * mobileCrypto.ts にも base64url があるが、そちらは別のセッションが触っているので、まとめるのは後のタスクで行う。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 の符号化と復号。復号は不正な並びで投げる。 */
export const utf8 = {
  encode: (s: string): Uint8Array<ArrayBuffer> => encoder.encode(s),
  decode: (b: Uint8Array): string => decoder.decode(b),
};

/** バイト列を base64url（詰め物なし）にする。 */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url（末尾の = は有っても無くてもよい）を読む。形が違えば null を返す。 */
export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
  const body = s.replace(/=+$/, '');
  if (body.length % 4 === 1) return null;
  try {
    const bin = atob(body.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 決まった長さの base64url を読む。形か長さが違えば投げる。 */
export function fromBase64UrlLen(s: string, len: number, what: string): Uint8Array<ArrayBuffer> {
  const b = fromBase64Url(s);
  if (!b || b.length !== len) throw new TypeError(`${what}の形が違います（${len} バイトの base64url）`);
  return b;
}

/** 小文字の hex にする。 */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** バイト列を順に連結する。 */
export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 の base32（大文字、詰め物なし）にする。 */
export function toBase32(bytes: Uint8Array): string {
  let out = '';
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buf &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buf << (5 - bits)) & 31];
  return out;
}

/**
 * base32（大文字、詰め物なし）を読む。
 * 字種の外の文字、ありえない長さ、末尾の余りのビットが 0 でないものは null を返す。
 */
export function fromBase32(s: string): Uint8Array<ArrayBuffer> | null {
  const rem = s.length % 8;
  if (rem === 1 || rem === 3 || rem === 6) return null;
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let buf = 0;
  let bits = 0;
  let at = 0;
  for (const ch of s) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    buf = ((buf << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[at++] = (buf >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if ((buf & ((1 << bits) - 1)) !== 0) return null;
  return out;
}
