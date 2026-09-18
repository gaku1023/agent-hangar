import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedOrigins, fetchSiteAllowed, hasRequestBody, jsonContentType, originAllowed, tokenEquals, tokenFromRequest } from './auth.ts';

afterEach(() => { vi.unstubAllEnvs(); });

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
    expect(originAllowed('tauri://localhost', 4198)).toBe(true);
  });
  it('開発用の Vite の 5173 は、開発のときだけ許す', () => {
    // 127.0.0.1 の別ポートは同一サイトなのでクッキーが載る。
    // 常時許すと、5173 に居る別のページがクッキーだけで書き込める。
    expect(originAllowed('http://127.0.0.1:5173', 4198)).toBe(false);
    expect(originAllowed('http://localhost:5173', 4198)).toBe(false);
    vi.stubEnv('HANGAR_DEV', '1');
    expect(originAllowed('http://127.0.0.1:5173', 4198)).toBe(true);
    expect(originAllowed('http://localhost:5173', 4198)).toBe(true);
  });
  it('allowedOrigins は待ち受けているポートと Tauri だけを並べ、開発のときに Vite を足す', () => {
    expect(allowedOrigins(4198)).toEqual(['http://127.0.0.1:4198', 'http://localhost:4198', 'tauri://localhost']);
    vi.stubEnv('HANGAR_DEV', '1');
    expect(allowedOrigins(4198)).toEqual(['http://127.0.0.1:4198', 'http://localhost:4198', 'http://127.0.0.1:5173', 'http://localhost:5173', 'tauri://localhost']);
    // 5173 で立てたときに同じ Origin を 2 度並べない。
    expect(allowedOrigins(5173)).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173', 'tauri://localhost']);
  });
});

describe('fetchSiteAllowed', () => {
  it('書き込みは same-origin と none だけを通す', () => {
    expect(fetchSiteAllowed('same-origin', 'POST')).toBe(true);
    expect(fetchSiteAllowed('none', 'POST')).toBe(true);
    expect(fetchSiteAllowed('cross-site', 'POST')).toBe(false);
    expect(fetchSiteAllowed('same-site', 'POST')).toBe(false);
    expect(fetchSiteAllowed('same-site', 'PATCH')).toBe(false);
    expect(fetchSiteAllowed('cross-site', 'DELETE')).toBe(false);
  });
  it('見出しを送らない curl と MCP クライアントは通す', () => {
    expect(fetchSiteAllowed(undefined, 'POST')).toBe(true);
    expect(fetchSiteAllowed(undefined, 'DELETE')).toBe(true);
  });
  it('読み出しだけの動詞は見ない', () => {
    // 応答は CORS で読めないので、状態を変えない要求はここで断らない。
    expect(fetchSiteAllowed('cross-site', 'GET')).toBe(true);
    expect(fetchSiteAllowed('cross-site', 'HEAD')).toBe(true);
  });
  it('開発のときだけ same-site を通す', () => {
    vi.stubEnv('HANGAR_DEV', '1');
    expect(fetchSiteAllowed('same-site', 'POST')).toBe(true);
    expect(fetchSiteAllowed('cross-site', 'POST')).toBe(false);
  });
});

describe('jsonContentType', () => {
  it('application/json だけを受ける', () => {
    expect(jsonContentType('application/json')).toBe(true);
    expect(jsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(jsonContentType('Application/JSON')).toBe(true);
    // 前検査の要らない「単純な要求」で使える型は全部断る。
    expect(jsonContentType('text/plain;charset=UTF-8')).toBe(false);
    expect(jsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(jsonContentType('multipart/form-data; boundary=x')).toBe(false);
    expect(jsonContentType(undefined)).toBe(false);
  });
});

describe('hasRequestBody', () => {
  it('本文の長さを名乗る見出しで決める', () => {
    expect(hasRequestBody('12', undefined)).toBe(true);
    expect(hasRequestBody(undefined, 'chunked')).toBe(true);
  });
  it('本文を持たない POST は本文無しと見なす', () => {
    // curl -X POST はどちらの見出しも付けない。node の受け口は空のストリームを付けるので、それでは測れない。
    expect(hasRequestBody(undefined, undefined)).toBe(false);
    expect(hasRequestBody('0', undefined)).toBe(false);
  });
});

describe('tokenEquals', () => {
  it('同じ長さの同じ文字列だけが真', () => {
    expect(tokenEquals('abc', 'abc')).toBe(true);
    expect(tokenEquals('abc', 'abd')).toBe(false);
    expect(tokenEquals('ab', 'abc')).toBe(false);
    expect(tokenEquals(null, 'abc')).toBe(false);
    expect(tokenEquals(undefined, 'abc')).toBe(false);
  });
});

describe('tokenFromRequest', () => {
  it('Bearer を優先し、無ければクッキー', () => {
    expect(tokenFromRequest(new Headers({ authorization: 'Bearer abc' }), 'hangar_token=zzz')).toBe('abc');
    expect(tokenFromRequest(new Headers(), 'a=1; hangar_token=zzz; b=2')).toBe('zzz');
    expect(tokenFromRequest(new Headers(), undefined)).toBeNull();
  });
});
