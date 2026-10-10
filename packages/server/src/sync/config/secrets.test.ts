import { describe, expect, it } from 'vitest';
import { findSecret } from './secrets.ts';

// 試験の文字列は作り物である。実在のトークンの形をなぞっただけで、どこにも通らない。
describe('秘密らしい文字列の検出', () => {
  it.each([
    ['sk-ant-', 'key = sk-ant-api03-AbCdEfGhIjKlMnOpQrSt0123456789'],
    ['ghp_', 'token: ghp_0123456789abcdefghijABCDEFGHIJ012345'],
    ['AKIA', 'AWS_KEY=AKIAABCDEFGHIJKLMNOP'],
    ['-----BEGIN', '-----BEGIN OPENSSH PRIVATE KEY-----\nxxxx\n-----END OPENSSH PRIVATE KEY-----'],
    ['github_pat_', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789'],
    ['xox', 'slack xoxb-1234567890-abcdefghij'],
  ])('%s の形を見つけ、種類の名前だけを返す', (label, text) => {
    expect(findSecret(text)).toBe(label);
  });

  it('見つけた文字列そのものは返さない', () => {
    const text = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ';
    expect(findSecret(text)).not.toContain('ZZZZ');
  });

  it('普通の文章と、形だけ書いた説明は通す', () => {
    expect(findSecret('# メモ\nAPI キーは sk-ant- で始まる。ghp_ や AKIA も同じ。')).toBeNull();
    expect(findSecret('Use `git push` and write -----BEGIN-less text')).toBeNull();
    expect(findSecret('')).toBeNull();
    expect(findSecret('skill: ask-ant-farm')).toBeNull();
  });

  it('長い本文の途中にあっても見つける', () => {
    expect(findSecret(`${'a\n'.repeat(5000)}AKIAABCDEFGHIJKLMNOP\n${'b\n'.repeat(5000)}`)).toBe('AKIA');
  });
});
