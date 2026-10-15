import { describe, expect, it, vi } from 'vitest';
import { newIssueUrl, searchSimilar, similarTerms } from './github.ts';

describe('newIssueUrl', () => {
  it('題名と本文を埋める', () => {
    const r = newIssueUrl('o/r', '[bug] a&b', 'x y', '…');
    expect(r.truncated).toBe(false);
    const u = new URL(r.url);
    expect(u.origin + u.pathname).toBe('https://github.com/o/r/issues/new');
    expect(u.searchParams.get('title')).toBe('[bug] a&b');
    expect(u.searchParams.get('body')).toBe('x y');
  });

  it('長すぎれば本文を切り詰め、注記を足して上限に収める', () => {
    const body = 'あ'.repeat(5000);
    const r = newIssueUrl('o/r', 't', body, '(truncated)', 8000);
    expect(r.truncated).toBe(true);
    expect(r.url.length).toBeLessThanOrEqual(8000);
    const got = new URL(r.url).searchParams.get('body')!;
    expect(got.endsWith('(truncated)')).toBe(true);
    expect(body.startsWith(got.slice(0, -'(truncated)'.length).trimEnd())).toBe(true);
  });
});

describe('similarTerms', () => {
  it('頭の印と伏せ字と記号を外し、語を 6 つまで取る', () => {
    expect(similarTerms('[bug] <project-1> の一覧が: 出ない (Windows) a b c d e f g')).toEqual(['の一覧が', '出ない', 'Windows', 'a', 'b', 'c']);
  });
});

describe('searchSimilar', () => {
  it('開いている issue を 5 件まで返す', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, title: `t${i}`, html_url: `u${i}`, state: 'open', pull_request: undefined }));
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 }));
    const r = await searchSimilar(fetchFn, 'o/r', '[bug] 一覧 出ない');
    expect(r).toHaveLength(5);
    expect(r![0]).toEqual({ number: 1, title: 't0', url: 'u0' });
    const called = new URL((fetchFn.mock.calls[0] as unknown as [string])[0]);
    expect(called.searchParams.get('q')).toBe('repo:o/r is:issue is:open 一覧 出ない');
  });

  it('失敗したら null を返す', async () => {
    expect(await searchSimilar(async () => new Response('', { status: 403 }), 'o/r', 'x')).toBeNull();
    expect(await searchSimilar(async () => { throw new Error('offline'); }, 'o/r', 'x')).toBeNull();
  });

  it('語が無ければ引かずに空を返す', async () => {
    const fetchFn = vi.fn();
    expect(await searchSimilar(fetchFn, 'o/r', '[bug] <project-1>')).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
