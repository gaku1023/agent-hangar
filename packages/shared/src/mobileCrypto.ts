/**
 * スマホ版の封じ（受信箱の素、起動の依頼、その答えを Worker に預けるときの暗号）。
 *
 * PC とスマホの両方から読むので、`globalThis.crypto.subtle` だけを使い、`node:crypto` を import しない。
 * 鍵は参加の秘密から HKDF-SHA256 で導く 32 バイトで、R2 の本文の鍵（info は hangar-file-v1）とは別の用途の鍵である。
 * スマホには参加の秘密を渡さず、この 32 バイトだけを QR に入れて渡す。
 */

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

const SALT = 'hangar-salt-v1';
const INFO = 'hangar-mobile-v1';
const IV_LEN = 12;
const TAG_LEN = 16;

/** 封じた文字列を開けなかった（鍵か AAD が違う、壊れている、JSON でない）。 */
export class MobileOpenError extends Error {
  constructor(message = '封じた文字列を開けませんでした') {
    super(message);
    this.name = 'MobileOpenError';
  }
}

/** つなぐ文字列（ペアリングの QR の中身）が読めない。 */
export class MobilePairingError extends Error {
  constructor(message = 'つなぐ文字列が読めません') {
    super(message);
    this.name = 'MobilePairingError';
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url（末尾の = は有っても無くてもよい）を読む。形が違えば null を返す。 */
function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** スマホ用の鍵の生の 32 バイト。PC だけが呼ぶ（QR に入れる）。 */
export async function deriveMobileKeyBytes(joinSecret: string): Promise<Uint8Array> {
  const base = await globalThis.crypto.subtle.importKey('raw', enc.encode(joinSecret), 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(SALT), info: enc.encode(INFO) }, base, 256);
  return new Uint8Array(bits);
}

/** 生の 32 バイトから AES-GCM の鍵にする。既定では取り出せない鍵にする（画面に XSS があっても値を持ち出せない）。 */
export async function importMobileKey(bytes: Uint8Array, extractable = false): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

/** 参加の秘密からそのまま鍵にする（PC 用）。 */
export async function deriveMobileKey(joinSecret: string): Promise<CryptoKey> {
  return importMobileKey(await deriveMobileKeyBytes(joinSecret));
}

/** 用途と宛先を縛る追加認証データ。別の用途や別の宛先に差し替えた封じは開けない。 */
export const aadFeed = (deviceId: string): string => `feed:${deviceId}`;
export const aadLaunch = (id: string, targetDevice: string): string => `launch:${id}:${targetDevice}`;
export const aadAnswer = (id: string): string => `answer:${id}`;

/** 値を JSON にして AES-256-GCM で封じる。戻りは base64url(iv(12) || 暗号文 || タグ)。IV は毎回乱数。 */
export async function seal(key: CryptoKey, aad: string, value: unknown): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const body = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(IV_LEN + body.length);
  out.set(iv, 0);
  out.set(body, IV_LEN);
  return toBase64Url(out);
}

/** 封じた文字列を開く。鍵、AAD、中身のどれが違っても MobileOpenError を投げる。 */
export async function open<T>(key: CryptoKey, aad: string, sealed: string): Promise<T> {
  const raw = fromBase64Url(sealed);
  if (!raw || raw.length < IV_LEN + TAG_LEN) throw new MobileOpenError();
  try {
    const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, IV_LEN), additionalData: enc.encode(aad) }, key, raw.subarray(IV_LEN));
    return JSON.parse(dec.decode(plain)) as T;
  } catch {
    throw new MobileOpenError();
  }
}

/**
 * ペアリングの QR の中身。秘密ではない url、code（使い捨ての券）、pcName、expiresAt に、スマホ用の鍵 key（base64url）が入る。
 * `<workerUrl>/app/#pair=<encodePairing(...)>` の形で渡し、フラグメントはサーバへ送られない。
 */
export type PairingBlob = { url: string; code: string; key: string; pcName: string; expiresAt: number };

export function encodePairing(b: PairingBlob): string {
  return toBase64Url(enc.encode(JSON.stringify({ url: b.url, code: b.code, key: b.key, pcName: b.pcName, expiresAt: b.expiresAt })));
}

export function decodePairing(s: string): PairingBlob {
  const raw = fromBase64Url(s.trim());
  if (!raw) throw new MobilePairingError();
  let v: unknown;
  try {
    v = JSON.parse(dec.decode(raw));
  } catch {
    throw new MobilePairingError();
  }
  const o = v as Partial<Record<keyof PairingBlob, unknown>> | null;
  if (!o || typeof o !== 'object') throw new MobilePairingError();
  if (typeof o.url !== 'string' || typeof o.code !== 'string' || typeof o.key !== 'string' || typeof o.pcName !== 'string') throw new MobilePairingError();
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) throw new MobilePairingError();
  if (!o.url || !o.code || !o.key) throw new MobilePairingError();
  return { url: o.url, code: o.code, key: o.key, pcName: o.pcName, expiresAt: o.expiresAt };
}

/**
 * `/rc` の URL として開いてよいか。会話から来た文は攻撃者が操れるので、https://claude.ai/ で始まり、URL として読めて、
 * 送り先が claude.ai そのものであるものだけを通す（PC で拾うときとスマホで開くときの両方で使う）。
 */
export function isRemoteControlUrl(u: string): boolean {
  if (typeof u !== 'string' || !u.startsWith('https://claude.ai/')) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === 'claude.ai' && url.username === '' && url.password === '' && url.port === '';
  } catch {
    return false;
  }
}
