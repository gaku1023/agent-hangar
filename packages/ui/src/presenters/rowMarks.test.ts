import { describe, expect, it } from 'vitest';
import { prNumberOf } from './row.ts';

describe('prNumberOf（行の 2 段目の右端の「PR #88」）', () => {
  it('PR の URL の末尾の番号を取る', () => {
    expect(prNumberOf('https://github.com/o/r/pull/88')).toBe('88');
    expect(prNumberOf('https://github.com/o/r/pull/88/files')).toBe('88');
    expect(prNumberOf('https://github.com/o/r/pull/88?x=1')).toBe('88');
    expect(prNumberOf('https://github.com/o/r/pull/88#issuecomment-1')).toBe('88');
  });
  it('この形でない URL と、URL が無いときは null（「PR」とだけ出す）', () => {
    expect(prNumberOf('https://gitlab.com/o/r/-/merge_requests/9')).toBeNull();
    expect(prNumberOf('https://github.com/o/r/pull/abc')).toBeNull();
    expect(prNumberOf(null)).toBeNull();
  });
});
