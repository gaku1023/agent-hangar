/**
 * 行、ファイルのメタ、名簿を AES-256-GCM で封じる形。
 *
 * `sealed = 版(1) || iv(12) || AES-256-GCM(鍵, 平文)` で、版は SEAL_VERSION。
 * 平文は `印(1) || 本文` で、印は 0x00 なら生、0x01 なら gzip した本文である。
 * 本文は JSON の UTF-8 で、GZIP_MIN_BYTES 以上なら gzip してから封じる。
 * AAD は配列の JSON にし、行の宛先を区切りの曖昧さなく縛る（別の行と取り違えた封じは開けない）。
 */

import { concatBytes, utf8 } from './bytes.ts';

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export const GZIP_MIN_BYTES = 256;
export const SEAL_VERSION = 0x02;

const IV_LEN = 12;
const TAG_LEN = 16;
const FLAG_RAW = 0x00;
const FLAG_GZIP = 0x01;

/** 封じたものを開けなかった（鍵か AAD が違う、壊れている、形が違う）。 */
export class E2eOpenError extends Error {
  constructor(message = '封じたデータを開けませんでした') {
    super(message);
    this.name = 'E2eOpenError';
  }
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** 値を JSON にして封じる。行、ファイルのメタ、名簿で共通の形。 */
export async function sealJson(key: CryptoKey, aad: string, value: unknown): Promise<Uint8Array> {
  const body = utf8.encode(JSON.stringify(value));
  const plain = body.length >= GZIP_MIN_BYTES ? concatBytes(Uint8Array.of(FLAG_GZIP), await pipe(body, new CompressionStream('gzip'))) : concatBytes(Uint8Array.of(FLAG_RAW), body);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad) }, key, plain));
  return concatBytes(Uint8Array.of(SEAL_VERSION), iv, ct);
}

/**
 * 封じたものを開き、印つきの平文（`印(1) || 本文`）をそのまま返す。
 * 試験と sealJson の対で使う内部の関数で、e2e の索引からは出さない。
 */
export async function openPlaintext(key: CryptoKey, aad: string, sealed: Uint8Array): Promise<Uint8Array> {
  if (!(sealed instanceof Uint8Array) || sealed.length < 1 + IV_LEN + TAG_LEN + 1 || sealed[0] !== SEAL_VERSION) throw new E2eOpenError();
  try {
    const iv = sealed.slice(1, 1 + IV_LEN);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad) }, key, sealed.slice(1 + IV_LEN));
    return new Uint8Array(plain);
  } catch {
    throw new E2eOpenError();
  }
}

/** 封じたものを開いて JSON の値に戻す。どこで失敗しても E2eOpenError を投げる。 */
export async function openJson(key: CryptoKey, aad: string, sealed: Uint8Array): Promise<unknown> {
  const plain = await openPlaintext(key, aad, sealed);
  try {
    const flag = plain[0];
    const body = plain.subarray(1);
    if (flag === FLAG_RAW) return JSON.parse(utf8.decode(body));
    if (flag === FLAG_GZIP) return JSON.parse(utf8.decode(await pipe(body, new DecompressionStream('gzip'))));
  } catch {
    throw new E2eOpenError();
  }
  throw new E2eOpenError();
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 行の宛先。D1 の `rows` に平文で並ぶ列と同じもの。 */
export type RowAad = { k: string; deviceId: string; updatedAt: number; op: 'upsert' | 'delete'; epoch: number };

export const rowAadString = (a: RowAad): string => JSON.stringify(['row', a.k, a.deviceId, a.updatedAt, a.op, a.epoch]);

export type RowBody = { tableName: string; rowId: string; payload: Record<string, unknown> };

/** 行を `/row` の鍵で封じる。 */
export async function sealRow(key: CryptoKey, aad: RowAad, body: RowBody): Promise<Uint8Array> {
  return sealJson(key, rowAadString(aad), { tableName: body.tableName, rowId: body.rowId, payload: body.payload });
}

/** 封じた行を開く。鍵、宛先、中身のどれが違っても E2eOpenError を投げる。 */
export async function openRow(key: CryptoKey, aad: RowAad, sealed: Uint8Array): Promise<RowBody> {
  const v = await openJson(key, rowAadString(aad), sealed);
  if (!isObj(v) || typeof v.tableName !== 'string' || typeof v.rowId !== 'string' || !isObj(v.payload)) throw new E2eOpenError();
  return { tableName: v.tableName, rowId: v.rowId, payload: v.payload };
}

/** ファイルの索引の宛先。D1 の `files` に平文で並ぶ列と同じもの。 */
export type FileAad = { key: string; deviceId: string; kind: 'transcript' | 'config'; epoch: number };

/** 封じるファイルのメタ。origin は元の PC の ID。 */
export type FileMeta = { path: string; sha256: string; mtime: number; origin: string };

export const fileAadString = (a: FileAad): string => JSON.stringify(['file', a.key, a.deviceId, a.kind, a.epoch]);

/** ファイルのメタを `/row` の鍵で封じる（`sealed_meta`）。 */
export async function sealFileMeta(key: CryptoKey, aad: FileAad, meta: FileMeta): Promise<Uint8Array> {
  return sealJson(key, fileAadString(aad), { path: meta.path, sha256: meta.sha256, mtime: meta.mtime, origin: meta.origin });
}

export async function openFileMeta(key: CryptoKey, aad: FileAad, sealed: Uint8Array): Promise<FileMeta> {
  const v = await openJson(key, fileAadString(aad), sealed);
  if (!isObj(v) || typeof v.path !== 'string' || typeof v.sha256 !== 'string' || typeof v.mtime !== 'number' || typeof v.origin !== 'string') throw new E2eOpenError();
  return { path: v.path, sha256: v.sha256, mtime: v.mtime, origin: v.origin };
}
