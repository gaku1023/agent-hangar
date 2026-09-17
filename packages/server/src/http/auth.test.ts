import { describe, expect, it } from 'vitest';
import { originAllowed, tokenFromRequest } from './auth.ts';

describe('originAllowed', () => {
  it('Origin 無しと一覧のものは許可、他は拒否', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('http://127.0.0.1:4177')).toBe(true);
    expect(originAllowed('tauri://localhost')).toBe(true);
    expect(originAllowed('https://evil.example')).toBe(false);
    expect(originAllowed('http://127.0.0.1:4178')).toBe(false);
  });
});

describe('tokenFromRequest', () => {
  it('Bearer を優先し、無ければクッキー', () => {
    expect(tokenFromRequest(new Headers({ authorization: 'Bearer abc' }), 'hangar_token=zzz')).toBe('abc');
    expect(tokenFromRequest(new Headers(), 'a=1; hangar_token=zzz; b=2')).toBe('zzz');
    expect(tokenFromRequest(new Headers(), undefined)).toBeNull();
  });
});
