import { describe, expect, it } from 'vitest';
import { entryUrl } from './url.ts';

describe('entryUrl', () => {
  it('鍵を問い合わせに載せた URL を作る', () => {
    expect(entryUrl(4177, 'a'.repeat(64))).toBe(`http://127.0.0.1:4177/?t=${'a'.repeat(64)}`);
    expect(entryUrl(4198, 'ab/cd')).toBe('http://127.0.0.1:4198/?t=ab%2Fcd');
  });
});
