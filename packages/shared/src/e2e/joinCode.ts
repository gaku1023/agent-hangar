/**
 * 参加コード：参加済みの PC が発行する 8 文字のコード（5 分、1 回限り）と、そこから導く値。
 *
 * 字種は読み違えやすい 0 O 1 I L U を除いた 30 字で、表示は `XXXX-XXXX` にする。
 * コードは約 39 bit しかないので、D1 に置く値（code_hash）と、参加リクエストの封の鍵と、確認コードは、どれも重い KDF を通してから導く。
 * 重い KDF は PBKDF2-SHA256 で、salt にクラウドごとの値（cloud_id）を入れる。
 * 1 回の SHA-256 なら、D1 の写し（code_hash と封じたリクエスト）から GPU で数十秒で総当たりでき、名前と OS が読めるためである。
 * 導くのは発行する PC と新しい PC だけで、どちらも Node の WebCrypto で計算する。
 * Worker は受け取った code_hash を比べるだけで、コードからは何も計算しない。
 * スマホの接続の券（phone.ts）は 16 バイトの乱数なので、この重い KDF の対象外である。
 */

import { concatBytes, fromBase64Url, fromBase64UrlLen, toBase64Url, toHex, utf8 } from './bytes.ts';
import { hkdf, importAesKey } from './keys.ts';
import { E2eOpenError } from './seal.ts';

const IV_LEN = 12;
const TAG_LEN = 16;

export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const JOIN_CODE_LEN = 8;

/**
 * 参加コードの PBKDF2-SHA256 の回数。
 * Node 22 の WebCrypto で 1 回の計算が 0.3 秒前後になる回数にした（2026-10-17 に Apple M5 Pro で 100 万回 0.107 秒、300 万回 0.32 秒を測った）。
 * 遅い PC では 1 秒を超えうるが、計算は参加の 1 回につき、新しい PC と発行した PC で 1 回ずつである。
 * GPU 1 枚が PBKDF2-SHA256 を毎秒 100 億回ほど回すとして、30^8 の空間の総当たりは 1 枚で数年かかる（1 回の SHA-256 なら数十秒）。
 * Node の WebCrypto の deriveBits はスレッドプールで走るので、サーバーのイベントループは止めない。
 * 値を変えると、発行した PC と新しい PC で code_hash が食い違い、参加できなくなる（両方の PC を同じバージョンにそろえること）。
 */
export const JOIN_KDF_ITERATIONS = 3_000_000;

/** PBKDF2 の salt の前置き。後ろにクラウドの ID（Worker の `GET /health` の cloudId）を付ける。 */
const KDF_SALT_PREFIX = 'hangar-join-v1:';
const HASH_INFO = 'hangar-join-hash-v1';
const REQ_INFO = 'hangar-join-req-v1';
const SAS_INFO = 'hangar-join-sas-v1';

let kdfIterations = JOIN_KDF_ITERATIONS;

/**
 * 試験だけが呼ぶ。PBKDF2 の回数を差し替える（null で本番の回数に戻す）。
 * 本番の回数では 1 回 0.3 秒前後かかり、参加の試験を何十本も回すと重いためである。
 * 製品のコードからは呼ばない。
 */
export function setJoinKdfIterationsForTests(n: number | null): void {
  if (n !== null && (!Number.isSafeInteger(n) || n < 1)) throw new RangeError('iterations must be a positive integer');
  kdfIterations = n ?? JOIN_KDF_ITERATIONS;
}

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

/**
 * 参加コードから導いた値の一式。
 * codeHash は D1 に置く値（hex の 64 字）で、Worker との照合と問い合わせに使う。
 * requestKey は参加リクエストの封の鍵、seed は確認コードの種で、どちらもこの PC のメモリにだけ置く。
 */
export type JoinSecrets = { readonly codeHash: string; readonly requestKey: CryptoKey; readonly seed: Uint8Array };

/**
 * 参加コードとクラウドの ID から、重い KDF を 1 回だけ通して値の一式を導く。
 * `seed = PBKDF2-SHA256(正規化したコードの UTF-8, salt = "hangar-join-v1:" + cloudId, JOIN_KDF_ITERATIONS 回, 32 バイト)`。
 * codeHash は `HKDF(seed, info = hangar-join-hash-v1)`、封の鍵は `HKDF(seed, info = hangar-join-req-v1)` で、salt はどちらも空である。
 * 発行した PC と新しい PC は、同じコードと同じクラウドなら同じ値を出す。
 * コードの形が違うか、クラウドの ID が空なら TypeError を投げる。
 */
export async function deriveJoinSecrets(code: string, cloudId: string): Promise<JoinSecrets> {
  const norm = mustNormalize(code);
  if (typeof cloudId !== 'string' || cloudId === '') throw new TypeError('クラウドの ID がありません');
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', utf8.encode(norm), 'PBKDF2', false, ['deriveBits']);
  const seed = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: utf8.encode(KDF_SALT_PREFIX + cloudId), iterations: kdfIterations }, base, 256));
  const empty = new Uint8Array(0);
  const [hash, req] = await Promise.all([hkdf(seed, empty, HASH_INFO, 32), hkdf(seed, empty, REQ_INFO, 32)]);
  return { codeHash: toHex(hash), requestKey: await importAesKey(req), seed };
}

/** D1 に置く code_hash（hex の 64 字）だけを導く。中身は deriveJoinSecrets と同じ重い計算である。 */
export async function joinCodeHash(code: string, cloudId: string): Promise<string> {
  return (await deriveJoinSecrets(code, cloudId)).codeHash;
}

/**
 * 確認コード（6 桁の数字）。
 * `HKDF(seed, salt = 新しい PC の公開鍵の raw 32 バイト, info = hangar-join-sas-v1)` の 4 バイトを uint32 として 10^6 で割った余りを 0 埋めする。
 * seed は重い KDF の出力なので、確認コードと公開鍵を知っても、参加コードを軽く総当たりする手がかりにならない。
 * 表示の区切り（`123 456`）は画面で付ける。
 */
export async function deriveSas(secrets: JoinSecrets, newPcPub: string): Promise<string> {
  const pub = fromBase64UrlLen(newPcPub, 32, '新しい PC の公開鍵');
  const b = await hkdf(secrets.seed, pub, SAS_INFO, 4);
  const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
  return String(n % 1_000_000).padStart(6, '0');
}

/** 参加リクエストの中身。新しい PC の公開鍵、名前、OS。 */
export type JoinRequestBody = { pub: string; name: string; os: string };

const requestAad = (codeHash: string): string => `join:${codeHash}`;

/**
 * 参加リクエストを参加コードから導いた鍵で封じる。AAD は `join:<code_hash>` である。
 * 戻りは base64url(iv(12) || AES-256-GCM) で、そのまま Worker に送る。
 */
export async function sealJoinRequest(secrets: JoinSecrets, body: JoinRequestBody): Promise<string> {
  const plain = utf8.encode(JSON.stringify({ pub: body.pub, name: body.name, os: body.os }));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(requestAad(secrets.codeHash)) }, secrets.requestKey, plain));
  return toBase64Url(concatBytes(iv, ct));
}

/** 参加リクエストを開く（発行した PC だけが呼ぶ）。コードかクラウドが違えば E2eOpenError を投げる。 */
export async function openJoinRequest(secrets: JoinSecrets, sealed: string): Promise<JoinRequestBody> {
  const raw = fromBase64Url(sealed);
  if (!raw || raw.length < IV_LEN + TAG_LEN) throw new E2eOpenError();
  let v: Record<string, unknown> | null;
  try {
    const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, IV_LEN), additionalData: utf8.encode(requestAad(secrets.codeHash)) }, secrets.requestKey, raw.slice(IV_LEN));
    v = JSON.parse(utf8.decode(new Uint8Array(plain))) as Record<string, unknown> | null;
  } catch {
    throw new E2eOpenError();
  }
  if (typeof v !== 'object' || v === null || typeof v.pub !== 'string' || fromBase64Url(v.pub)?.length !== 32 || typeof v.name !== 'string' || typeof v.os !== 'string') throw new E2eOpenError();
  return { pub: v.pub, name: v.name, os: v.os };
}
