/**
 * スマホ版の封じ（受信箱の素、起動の依頼、その答えを Worker に預けるときの暗号）。
 *
 * PC とスマホの両方から読むので、`globalThis.crypto.subtle` だけを使い、`node:crypto` を import しない。
 * 鍵はスマホ用の鍵 `M[m]`（32 バイトの乱数）で、PC の世代鍵から導いた用途の鍵とは別物である。
 * M は名簿の `phoneKey` に入れて PC どうしで持ち、スマホにはスマホの公開鍵に封じた keybox で渡す（e2e/phone.ts）。
 * QR には鍵を入れない。
 */

import { fromBase64Url, toBase64Url } from './e2e/bytes.ts';
import { PHONE_NOTICE_ID_MAX, PHONE_NOTICE_TEXT_MAX, type PhoneNotice } from './mobile.ts';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

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

/** スマホ用の鍵 M の生の 32 バイトから AES-GCM の鍵にする。既定では取り出せない鍵にする（画面に XSS があっても値を持ち出せない）。 */
export async function importMobileKey(bytes: Uint8Array, extractable = false): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

/** 用途と宛先を縛る追加認証データ。別の用途や別の宛先に差し替えた封じは開けない。 */
export const aadFeed = (deviceId: string): string => `feed:${deviceId}`;
export const aadLaunch = (id: string, targetDevice: string): string => `launch:${id}:${targetDevice}`;
export const aadAnswer = (id: string): string => `answer:${id}`;
export const aadAsk = (id: string, targetDevice: string): string => `ask:${id}:${targetDevice}`;
export const aadReply = (id: string): string => `reply:${id}`;
export const aadImage = (launchId: string, n: number): string => `image:${launchId}:${n}`;

/** 値を JSON にして AES-256-GCM で封じる。戻りは base64url(iv(12) || 暗号文 || タグ)。IV は毎回乱数。 */
export async function seal(key: CryptoKey, aad: string, value: unknown): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const body = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(IV_LEN + body.length);
  out.set(iv, 0);
  out.set(body, IV_LEN);
  return toBase64Url(out);
}

/** バイト列を AES-256-GCM で封じる（画像用）。戻りは iv(12) || 暗号文 || タグ。鍵と IV は seal と同じ。 */
export async function sealBytes(key: CryptoKey, aad: string, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const body = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes as BufferSource));
  const out = new Uint8Array(IV_LEN + body.length);
  out.set(iv, 0);
  out.set(body, IV_LEN);
  return out;
}

/** sealBytes で封じたものを開く。鍵、AAD、中身のどれが違っても MobileOpenError を投げる。 */
export async function openBytes(key: CryptoKey, aad: string, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < IV_LEN + TAG_LEN) throw new MobileOpenError();
  try {
    const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, IV_LEN) as BufferSource, additionalData: enc.encode(aad) }, key, sealed.subarray(IV_LEN) as BufferSource);
    return new Uint8Array(plain);
  } catch {
    throw new MobileOpenError();
  }
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

/** スマホの通知の AAD。世代を入れるので、封じた文字列の頭の世代を書き換えると開けない。 */
export const aadPhoneNotice = (epoch: number): string => JSON.stringify(['phone-notice', epoch]);

const NOTICE_RE = /^([1-9][0-9]{0,8})\.([A-Za-z0-9_-]+)$/;

const isNoticeEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isNoticeCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

/** M を AES-GCM の鍵にする。CryptoKey はそのまま、生の 32 バイトは取り出せない鍵にして使う。 */
async function noticeKey(key: CryptoKey | Uint8Array): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array)) return key;
  if (key.length !== 32) throw new TypeError('スマホ用の鍵の形が違います（32 バイト）');
  return importMobileKey(key);
}

const clip = (s: string): string => [...s].slice(0, PHONE_NOTICE_TEXT_MAX).join('');

/**
 * 封じた通知の頭の世代を読む（service worker が、どの世代の M で開くかを決めるのに使う）。形が違えば null。
 * 開けるかどうかは見ない。
 */
export function phoneNoticeEpoch(sealed: string): number | null {
  if (typeof sealed !== 'string') return null;
  const m = NOTICE_RE.exec(sealed);
  return m ? Number(m[1]) : null;
}

/**
 * スマホの通知の中身をスマホ用の鍵 M[epoch] で封じる（PC が呼ぶ）。
 * 戻りは `<世代>.<base64url(iv(12) || 暗号文 || タグ)>` で、封じ方は受信箱の素（seal）と同じ AES-256-GCM、AAD は aadPhoneNotice(世代) である。
 * Worker はこの文字列を `POST /notices` で受け、そのまま Web Push の本文にする。
 * 題と PC の名前は PHONE_NOTICE_TEXT_MAX 字で切る。key は取り出せない CryptoKey でも、生の 32 バイトでもよい。
 */
export async function sealPhoneNotice(key: CryptoKey | Uint8Array, epoch: number, notice: PhoneNotice): Promise<string> {
  if (!isNoticeEpoch(epoch)) throw new TypeError('世代の形が違います');
  const n = notice as Partial<PhoneNotice> | null;
  if (!n || typeof n.title !== 'string' || typeof n.pcName !== 'string' || typeof n.sessionId !== 'string' || n.sessionId.length > PHONE_NOTICE_ID_MAX || !isNoticeCount(n.count)) {
    throw new TypeError('通知の形が違います');
  }
  const body: PhoneNotice = { title: clip(n.title), pcName: clip(n.pcName), sessionId: n.sessionId, count: n.count };
  return `${epoch}.${await seal(await noticeKey(key), aadPhoneNotice(epoch), body)}`;
}

/**
 * sealPhoneNotice で封じた通知を開く（service worker が呼ぶ）。
 * 鍵、世代、中身のどれが違っても MobileOpenError を投げる。key は取り出せない CryptoKey でも、生の 32 バイトでもよい。
 */
export async function openPhoneNotice(key: CryptoKey | Uint8Array, sealed: string): Promise<PhoneNotice> {
  const m = typeof sealed === 'string' ? NOTICE_RE.exec(sealed) : null;
  if (!m) throw new MobileOpenError();
  let k: CryptoKey;
  try {
    k = await noticeKey(key);
  } catch {
    throw new MobileOpenError();
  }
  const v = await open<Partial<PhoneNotice> | null>(k, aadPhoneNotice(Number(m[1])), m[2]!);
  if (!v || typeof v !== 'object' || typeof v.title !== 'string' || typeof v.pcName !== 'string' || typeof v.sessionId !== 'string' || !isNoticeCount(v.count)) throw new MobileOpenError();
  return { title: v.title, pcName: v.pcName, sessionId: v.sessionId, count: v.count };
}

/**
 * ペアリングの QR の中身。url、code（使い捨ての券）、pcName、expiresAt だけで、鍵は入れない（互換の版 9）。
 * スマホは券から導いた鍵で自分の公開鍵を封じて接続し、QR を出した PC がスマホ用の鍵をその公開鍵に封じて置く。
 * `<workerUrl>/app/#pair=<encodePairing(...)>` の形で渡し、フラグメントはサーバーへ送られない。
 * 券は 5 分で失効する 1 回限りのもので、漏れても接続できるのはその 5 分の間に先に使った 1 台だけである。
 */
export type PairingBlob = { url: string; code: string; pcName: string; expiresAt: number };

export function encodePairing(b: PairingBlob): string {
  return toBase64Url(enc.encode(JSON.stringify({ url: b.url, code: b.code, pcName: b.pcName, expiresAt: b.expiresAt })));
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
  if (typeof o.url !== 'string' || typeof o.code !== 'string' || typeof o.pcName !== 'string') throw new MobilePairingError();
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) throw new MobilePairingError();
  if (!o.url || !o.code) throw new MobilePairingError();
  // 0.8 の QR は鍵（key）も持っていたが、読まずに捨てる。
  return { url: o.url, code: o.code, pcName: o.pcName, expiresAt: o.expiresAt };
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
