import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, decryptBuffer, decryptStream, deriveFileKey, encryptBuffer, encryptStream, sha256Hex, sha256Stream } from './crypto.ts';

const key = deriveFileKey('join-secret');
const collect = async (s: NodeJS.ReadableStream): Promise<Buffer> => { const out: Buffer[] = []; for await (const c of s) out.push(c as Buffer); return Buffer.concat(out); };

describe('deriveFileKey', () => {
  it('同じ秘密から同じ 32 バイト、違う秘密から違う鍵', () => {
    expect(key.length).toBe(32); // 鍵そのものを期待値に置かない（失敗の差分に鍵が出ないため）
    expect(deriveFileKey('join-secret').equals(key)).toBe(true);
    expect(deriveFileKey('other').equals(key)).toBe(false);
  });
});

describe('encrypt と decrypt', () => {
  it('空、1 バイト、ちょうど 1 チャンク、2 チャンク半を往復する', async () => {
    for (const n of [0, 1, CHUNK_SIZE, CHUNK_SIZE * 2 + 12345]) {
      const src = randomBytes(n);
      const enc = await encryptBuffer(key, src);
      expect(enc.subarray(0, 4).toString()).toBe('HGR1');
      const dec = await decryptBuffer(key, enc);
      expect(dec.equals(src)).toBe(true);
      const chunks = Math.max(1, Math.ceil(n / CHUNK_SIZE));
      expect(enc.length).toBe(12 + n + chunks * 21);
    }
  });
  it('同じ平文でも nonce 接頭辞が違うので暗号文が違う', async () => {
    const src = Buffer.from('hello');
    const a = await encryptBuffer(key, src);
    const b = await encryptBuffer(key, src);
    expect(a.equals(b)).toBe(false);
    expect((await decryptBuffer(key, a)).equals(await decryptBuffer(key, b))).toBe(true);
  });
  it('ストリームでも同じ結果になり、小さな書き込みの列を受ける', async () => {
    const src = randomBytes(CHUNK_SIZE + 777);
    const pieces: Buffer[] = [];
    for (let i = 0; i < src.length; i += 4096) pieces.push(src.subarray(i, i + 4096));
    const enc = await collect(Readable.from(pieces).pipe(encryptStream(key)));
    const dec = await collect(Readable.from([enc.subarray(0, 100), enc.subarray(100)]).pipe(decryptStream(key)));
    expect(dec.equals(src)).toBe(true);
  });
  it('改竄、鍵違い、切り詰め、末尾の余りは失敗する', async () => {
    const src = randomBytes(CHUNK_SIZE + 10);
    const enc = await encryptBuffer(key, src);
    const flipped = Buffer.from(enc); flipped[20] = flipped[20]! ^ 1;
    await expect(decryptBuffer(key, flipped)).rejects.toThrow();
    await expect(decryptBuffer(deriveFileKey('other'), enc)).rejects.toThrow();
    await expect(decryptBuffer(key, enc.subarray(0, enc.length - 30))).rejects.toThrow(/切り詰め|truncated/);
    await expect(decryptBuffer(key, Buffer.concat([enc, Buffer.from([0])]))).rejects.toThrow();
    await expect(decryptBuffer(key, Buffer.from('nope'))).rejects.toThrow();
  });
});

describe('sha256', () => {
  it('文字列とストリームで同じ値', async () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Stream(Readable.from([Buffer.from('a'), Buffer.from('bc')]))).toBe(sha256Hex('abc'));
    await pipeline(Readable.from([]), async function* (s) { for await (const c of s) yield c; });
  });
});

describe('壊れた長さの申告', () => {
  it('len に巨大な値を書いた入力は、溜め込む前に error になる', async () => {
    const head = Buffer.alloc(5);
    head[0] = 0;
    head.writeUInt32BE(0x7fffffff, 1);
    const broken = Buffer.concat([Buffer.from('HGR1'), randomBytes(8), head, randomBytes(64)]);
    await expect(decryptBuffer(key, broken)).rejects.toThrow(/上限|too large/);
  });
  it('上限ちょうどまでは受け付け、1 バイト超えたら断る', async () => {
    const frame = (len: number) => {
      const head = Buffer.alloc(5);
      head[0] = 0;
      head.writeUInt32BE(len, 1);
      return Buffer.concat([Buffer.from('HGR1'), randomBytes(8), head]);
    };
    // 上限ちょうどは長さの検査を通り、本体が足りないので切り詰めとして落ちる。
    await expect(decryptBuffer(key, frame(CHUNK_SIZE + 64))).rejects.toThrow(/切り詰め|truncated/);
    await expect(decryptBuffer(key, frame(CHUNK_SIZE + 65))).rejects.toThrow(/上限|too large/);
  });
});
