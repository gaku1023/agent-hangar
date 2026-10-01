import { describe, expect, it } from 'vitest';
import { countHits, markTerms } from './highlight.ts';

describe('markTerms', () => {
  it('検索語を大文字と小文字を問わずに印し、残りはそのまま', () => {
    expect(markTerms('床（transcriptsFrom）を外す', 'TRANSCRIPTSFROM')).toEqual([{ text: '床（', hit: false }, { text: 'transcriptsFrom', hit: true }, { text: '）を外す', hit: false }]);
  });
  it('空白で区切った語をどれも印し、重なるときは長い語を先に当てる', () => {
    expect(markTerms('sync sync-floor', 'sync sync-floor')).toEqual([{ text: 'sync', hit: true }, { text: ' ', hit: false }, { text: 'sync-floor', hit: true }]);
  });
  it('正規表現の記号と引用符は、ただの文字として扱う', () => {
    expect(markTerms('a.b(c) と axb(', '"a.b("')).toEqual([{ text: 'a.b(', hit: true }, { text: 'c) と axb(', hit: false }]);
  });
  it('語が無ければ全体を印のない 1 つの塊にし、本文が空なら空', () => {
    expect(markTerms('本文', '  ')).toEqual([{ text: '本文', hit: false }]);
    expect(markTerms('', 'x')).toEqual([]);
  });
  it('literal のときは空白を含めた全体を 1 つの語として当てる', () => {
    expect(markTerms('a b と a と b', 'a b', { literal: true })).toEqual([{ text: 'a b', hit: true }, { text: ' と a と b', hit: false }]);
  });
  it('caseSensitive のときは大文字と小文字を分ける', () => {
    expect(markTerms('Foo foo', 'foo', { caseSensitive: true })).toEqual([{ text: 'Foo ', hit: false }, { text: 'foo', hit: true }]);
  });
});

describe('countHits', () => {
  it('markTerms が印す塊の数と同じ数を返す', () => {
    expect(countHits('バリデーションの バリデーション', 'バリデーション', { literal: true })).toBe(2);
    expect(countHits('sync sync-floor', 'sync sync-floor')).toBe(2);
    expect(countHits('abc', '')).toBe(0);
    expect(countHits('', 'x')).toBe(0);
  });
});
