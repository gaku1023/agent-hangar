import { describe, expect, it } from 'vitest';
import { blobToSealed, sealedToBlob } from '../src/util.ts';

describe('封じた値と BLOB の行き来', () => {
  it('base64url とバイト列が往復する', () => {
    const s = Buffer.from('sealed-value-\u0000ÿ').toString('base64url');
    const b = sealedToBlob(s);
    expect(Buffer.from(b).toString('base64url')).toBe(s);
    // D1 は BLOB を数の配列で返し、ArrayBuffer で返す土台もある。
    expect(blobToSealed([...b])).toBe(s);
    expect(blobToSealed(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))).toBe(s);
    expect(blobToSealed(b)).toBe(s);
  });

  it('空の BLOB は空の文字（名簿の印の行）', () => {
    expect(blobToSealed([])).toBe('');
    expect(blobToSealed(new ArrayBuffer(0))).toBe('');
  });

  it('知らない型は投げる（壊れた行を名簿の印の行に見せない）', () => {
    for (const v of [null, undefined, 12, {}, true]) expect(() => blobToSealed(v)).toThrow();
  });
});
