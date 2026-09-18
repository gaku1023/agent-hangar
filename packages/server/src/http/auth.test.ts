import { describe, expect, it } from 'vitest';
import { allowedOrigins, originAllowed, tokenFromRequest } from './auth.ts';

describe('originAllowed', () => {
  it('Origin 無しと一覧のものは許可、他は拒否', () => {
    expect(originAllowed(undefined, 4177)).toBe(true);
    expect(originAllowed('http://127.0.0.1:4177', 4177)).toBe(true);
    expect(originAllowed('http://localhost:4177', 4177)).toBe(true);
    expect(originAllowed('tauri://localhost', 4177)).toBe(true);
    expect(originAllowed('https://evil.example', 4177)).toBe(false);
    expect(originAllowed('http://127.0.0.1:4178', 4177)).toBe(false);
  });
  it('待ち受けているポートの Origin を許可し、他のポートは拒む', () => {
    // 4177 以外で立てたときに UI が使えなくならないよう、実際のポートから組み立てる。
    expect(originAllowed('http://127.0.0.1:4198', 4198)).toBe(true);
    expect(originAllowed('http://localhost:4198', 4198)).toBe(true);
    expect(originAllowed('http://127.0.0.1:4177', 4198)).toBe(false);
    expect(originAllowed('http://localhost:4177', 4198)).toBe(false);
    // 開発用の Vite と Tauri はポートに関わらず残す。
    expect(originAllowed('http://127.0.0.1:5173', 4198)).toBe(true);
    expect(originAllowed('http://localhost:5173', 4198)).toBe(true);
    expect(originAllowed('tauri://localhost', 4198)).toBe(true);
  });
  it('allowedOrigins は待ち受けているポートと開発用のものだけを並べる', () => {
    expect(allowedOrigins(4198)).toEqual(['http://127.0.0.1:4198', 'http://localhost:4198', 'http://127.0.0.1:5173', 'http://localhost:5173', 'tauri://localhost']);
    expect(allowedOrigins(5173)).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173', 'tauri://localhost']);
  });
});

describe('tokenFromRequest', () => {
  it('Bearer を優先し、無ければクッキー', () => {
    expect(tokenFromRequest(new Headers({ authorization: 'Bearer abc' }), 'hangar_token=zzz')).toBe('abc');
    expect(tokenFromRequest(new Headers(), 'a=1; hangar_token=zzz; b=2')).toBe('zzz');
    expect(tokenFromRequest(new Headers(), undefined)).toBeNull();
  });
});
