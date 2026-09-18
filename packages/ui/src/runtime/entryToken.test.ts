import { describe, expect, it } from 'vitest';
import { stripEntryToken } from './entryToken.ts';

describe('stripEntryToken', () => {
  it('鍵付きで開かれたら URL から鍵を消す', () => {
    const seen: string[] = [];
    expect(stripEntryToken('http://127.0.0.1:4177/?t=abc123', (u) => seen.push(u))).toBe(true);
    expect(seen).toEqual(['/']);
  });
  it('ハッシュと他の問い合わせは残す', () => {
    const seen: string[] = [];
    expect(stripEntryToken('http://127.0.0.1:4177/?t=abc123&x=1#/s/42', (u) => seen.push(u))).toBe(true);
    expect(seen).toEqual(['/?x=1#/s/42']);
  });
  it('鍵が無ければ何もしない', () => {
    const seen: string[] = [];
    expect(stripEntryToken('http://127.0.0.1:4177/#/s/42', (u) => seen.push(u))).toBe(false);
    expect(seen).toEqual([]);
  });
});
