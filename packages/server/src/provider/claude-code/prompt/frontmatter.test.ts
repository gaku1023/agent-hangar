import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter.ts';

describe('parseFrontmatter', () => {
  it('先頭の --- で囲んだ部分の、鍵と値を読む', () => {
    expect(parseFrontmatter('---\nname: goal\ndescription: 長く走る\nargument-hint: "[on|off]"\n---\n本文')).toEqual({ name: 'goal', description: '長く走る', 'argument-hint': '[on|off]' });
  });
  it('折り返しの値（> と |）は、字下げした行を空白でつなぐ', () => {
    expect(parseFrontmatter('---\ndescription: >-\n  一行目\n  二行目\nname: x\n---\n')).toEqual({ description: '一行目 二行目', name: 'x' });
  });
  it('frontmatter が無い、閉じていない文は、空を返す', () => {
    expect(parseFrontmatter('# 見出し\nname: x')).toEqual({});
    expect(parseFrontmatter('---\nname: x\n本文')).toEqual({});
  });
  it('値にコロンが入っていても、最初のコロンで分ける', () => {
    expect(parseFrontmatter('---\ndescription: 例: これ\n---\n')).toEqual({ description: '例: これ' });
  });
});
