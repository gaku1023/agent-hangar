import { describe, expect, it } from 'vitest';
import { utf8 } from './bytes.ts';
import { deriveEpochKeys, randomEpochKey } from './keys.ts';
import { E2eOpenError, GZIP_MIN_BYTES, SEAL_VERSION, openFileMeta, openPlaintext, openRow, rowAadString, sealFileMeta, sealRow, type FileAad, type RowAad } from './seal.ts';

const aad: RowAad = { k: 'k-abc', deviceId: 'pc-a', updatedAt: 1_700_000_000_000, op: 'upsert', epoch: 1 };
const short = { tableName: 'sessions', rowId: 'row-1', payload: { title: '会話の題の例', n: 1 } };
const big = { tableName: 'notes', rowId: 'row-2', payload: { body: 'x'.repeat(10 * 1024), nested: { a: [1, 2, 3] } } };

async function rowKey(): Promise<CryptoKey> {
  return (await deriveEpochKeys(1, randomEpochKey())).row;
}

function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('行の封（sealRow / openRow）', () => {
  it('封じて開けば元に戻る（短い本文と 10 KiB の本文）', async () => {
    const key = await rowKey();
    for (const body of [short, big]) {
      const sealed = await sealRow(key, aad, body);
      expect(sealed).toBeInstanceOf(Uint8Array);
      expect(sealed[0]).toBe(SEAL_VERSION);
      expect(await openRow(key, aad, sealed)).toEqual(body);
    }
  });

  it('10 KiB の本文は gzip で縮む', async () => {
    const sealed = await sealRow(await rowKey(), aad, big);
    expect(sealed.length).toBeLessThan(1024);
  });

  it('256 バイト以上は gzip の印 0x01、未満は 0x00', async () => {
    const key = await rowKey();
    expect(GZIP_MIN_BYTES).toBe(256);
    const plainSmall = await openPlaintext(key, rowAadString(aad), await sealRow(key, aad, short));
    expect(plainSmall[0]).toBe(0x00);
    const plainBig = await openPlaintext(key, rowAadString(aad), await sealRow(key, aad, big));
    expect(plainBig[0]).toBe(0x01);
    // 境目の 1 バイト前と境目で印が変わる。
    const base = JSON.stringify({ tableName: 't', rowId: 'r', payload: { s: '' } }).length;
    const below = { tableName: 't', rowId: 'r', payload: { s: 'a'.repeat(GZIP_MIN_BYTES - 1 - base) } };
    const at = { tableName: 't', rowId: 'r', payload: { s: 'a'.repeat(GZIP_MIN_BYTES - base) } };
    expect((await openPlaintext(key, rowAadString(aad), await sealRow(key, aad, below)))[0]).toBe(0x00);
    expect((await openPlaintext(key, rowAadString(aad), await sealRow(key, aad, at)))[0]).toBe(0x01);
  });

  it('行の付け替えが落ちる（k、deviceId、updatedAt、op、epoch を 1 つずつ変える）', async () => {
    const key = await rowKey();
    const sealed = await sealRow(key, aad, short);
    const variants: RowAad[] = [
      { ...aad, k: 'k-other' },
      { ...aad, deviceId: 'pc-b' },
      { ...aad, updatedAt: aad.updatedAt + 1 },
      { ...aad, op: 'delete' },
      { ...aad, epoch: 2 },
    ];
    for (const v of variants) await expect(openRow(key, v, sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('別の鍵、壊れた BLOB、版の違う BLOB は E2eOpenError', async () => {
    const key = await rowKey();
    const sealed = await sealRow(key, aad, short);
    await expect(openRow(await rowKey(), aad, sealed)).rejects.toBeInstanceOf(E2eOpenError);
    const flipped = sealed.slice();
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    await expect(openRow(key, aad, flipped)).rejects.toBeInstanceOf(E2eOpenError);
    const wrongVersion = sealed.slice();
    wrongVersion[0] = 0x01;
    await expect(openRow(key, aad, wrongVersion)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openRow(key, aad, new Uint8Array(5))).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('封じた BLOB に表名、行 ID、payload の文字列が含まれない', async () => {
    const key = await rowKey();
    const body = { tableName: 'sessions', rowId: 'row-plain-id-42', payload: { title: 'plain-title-marker' } };
    const sealed = await sealRow(key, aad, body);
    for (const s of ['sessions', 'row-plain-id-42', 'plain-title-marker']) expect(containsBytes(sealed, utf8.encode(s))).toBe(false);
  });

  it('同じ値を 2 回封じると別の BLOB', async () => {
    const key = await rowKey();
    const a = await sealRow(key, aad, short);
    const b = await sealRow(key, aad, short);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('ファイルのメタの封（sealFileMeta / openFileMeta）', () => {
  const faad: FileAad = { key: 'b/pc-a/abc', deviceId: 'pc-a', kind: 'transcript', epoch: 1 };
  const meta = { path: 'projects/example/session.jsonl', sha256: 'ab'.repeat(32), mtime: 1_700_000_000_000, origin: 'pc-a' };

  it('封じて開けば元に戻る', async () => {
    const key = await rowKey();
    expect(await openFileMeta(key, faad, await sealFileMeta(key, faad, meta))).toEqual(meta);
  });

  it('AAD の key、deviceId、kind、epoch のどれが違っても開けない', async () => {
    const key = await rowKey();
    const sealed = await sealFileMeta(key, faad, meta);
    const variants: FileAad[] = [
      { ...faad, key: 'b/pc-a/xyz' },
      { ...faad, deviceId: 'pc-b' },
      { ...faad, kind: 'config' },
      { ...faad, epoch: 2 },
    ];
    for (const v of variants) await expect(openFileMeta(key, v, sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('行の封とファイルのメタの封は取り違えられない', async () => {
    const key = await rowKey();
    const sealed = await sealRow(key, aad, short);
    await expect(openFileMeta(key, faad, sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });
});
