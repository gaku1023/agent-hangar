import { describe, expect, it } from 'vitest';
import { newId, shortId } from './ids.ts';

describe('newId', () => {
  it('UUID v7 の形をしている', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('連続して作ると辞書順が時刻順になる', () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
  });
});

describe('shortId', () => {
  it('ハイフンを除いた先頭 8 文字を返す', () => {
    expect(shortId('01926b3c-9d2e-7abc-8def-0123456789ab')).toBe('01926b3c');
  });
});
