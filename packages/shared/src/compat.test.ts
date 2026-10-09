import { describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION, compatHeaders, compatRefusalBody, parseCompat, readCompatRefusal } from './compat.ts';
import * as shared from './index.ts';

describe('互換の版番号', () => {
  it('版は整数で（いまは 2。名前とメモを session_notes で運ぶ版）、見出しは小文字の x-hangar-compat で運ぶ', () => {
    expect(COMPAT_VERSION).toBe(2);
    expect(Number.isSafeInteger(COMPAT_VERSION)).toBe(true);
    expect(COMPAT_HEADER).toBe('x-hangar-compat');
    expect(compatHeaders()).toEqual({ 'x-hangar-compat': '2' });
  });

  it('パッケージの入口から取れる', () => {
    expect(shared.COMPAT_VERSION).toBe(COMPAT_VERSION);
    expect(shared.parseCompat).toBe(parseCompat);
    expect(shared.readCompatRefusal).toBe(readCompatRefusal);
  });

  it('相手が名乗った版を整数で読む', () => {
    expect(parseCompat('1')).toBe(1);
    expect(parseCompat('12')).toBe(12);
    expect(parseCompat(' 3 ')).toBe(3);
  });

  it('見出しの無い相手と、整数として読めない値は版 0 として読む', () => {
    for (const v of [null, undefined, '', 'abc', '-1', '1.5', '1e3', '0x10', '99999999999999999999']) {
      expect(parseCompat(v), String(v)).toBe(0);
    }
  });

  it('426 の本文は下限と Worker の版を運び、端末はそこから下限を読む', () => {
    expect(compatRefusalBody(2)).toEqual({ error: 'upgrade required', minCompat: 2, compat: COMPAT_VERSION });
    expect(readCompatRefusal(JSON.stringify(compatRefusalBody(2)))).toBe(2);
    expect(readCompatRefusal(JSON.stringify(compatRefusalBody(0)))).toBe(0);
  });

  it('形の違う本文からは下限を読まない（例外も投げない）', () => {
    for (const t of ['', 'nonsense', 'null', '{"error":"gone","minCompat":1}', '{"error":"upgrade required"}', '{"error":"upgrade required","minCompat":-1}', '{"error":"upgrade required","minCompat":"2"}', '{"error":"upgrade required","minCompat":1.5}']) {
      expect(readCompatRefusal(t), t).toBeNull();
    }
  });
});
