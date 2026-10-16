/**
 * Worker に平文で見せる鍵名（行の k、R2 の鍵名、ファイルの指紋）を、`/index` と `/fp` の鍵の HMAC-SHA256 で作る。
 *
 * 同じ世代の鍵を持つ PC は同じ鍵名を計算できるので、冪等な書き込みの形を保てる。
 * Worker からは、表名、行 ID、セッションの UUID、パスが見えない。
 */

import { toBase64Url, utf8 } from './bytes.ts';

async function mac(key: CryptoKey, input: string): Promise<string> {
  return toBase64Url(new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, utf8.encode(input))));
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BLOB_KEY_RE = /^b\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{43}$/;

function blobKey(deviceId: string, name: string): string {
  if (!DEVICE_ID_RE.test(deviceId)) throw new TypeError('端末の ID の形が違います');
  return `b/${deviceId}/${name}`;
}

/** 行の k。`HMAC(/index, 表名 ":" 行 ID)` の base64url。 */
export async function rowK(indexKey: CryptoKey, table: string, rowId: string): Promise<string> {
  return mac(indexKey, `${table}:${rowId}`);
}

/** トランスクリプトの本文の R2 の鍵名。サブエージェントのものは agentId を足す。 */
export async function transcriptBlobKey(indexKey: CryptoKey, deviceId: string, origin: string, uuid: string, agentId: string | null): Promise<string> {
  const input = agentId === null ? `t:${origin}:${uuid}` : `t:${origin}:${uuid}:${agentId}`;
  return blobKey(deviceId, await mac(indexKey, input));
}

/** 設定の同期のファイルの R2 の鍵名。相対パスを平文で残さない。 */
export async function configBlobKey(indexKey: CryptoKey, deviceId: string, origin: string, rel: string): Promise<string> {
  return blobKey(deviceId, await mac(indexKey, `c:${origin}:${rel}`));
}

/** ファイルの平文の SHA-256（hex）から、比べるための指紋を作る（`/fp` の用途）。 */
export async function fingerprint(fpKey: CryptoKey, sha256Hex: string): Promise<string> {
  return mac(fpKey, sha256Hex.toLowerCase());
}

/** R2 の鍵名の形か。Worker が受け取った鍵名を確かめるのに使う。 */
export function isBlobKey(key: string): boolean {
  return typeof key === 'string' && BLOB_KEY_RE.test(key);
}
