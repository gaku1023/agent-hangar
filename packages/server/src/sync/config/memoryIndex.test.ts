import { describe, expect, it } from 'vitest';
import { memoryLinkOf, mergeMemoryIndex, type MergeOptions } from './memoryIndex.ts';

/**
 * メモリの索引（MEMORY.md）の行の和（memoryIndex.ts）。
 * 2 台が同じ規則で合わせるので、手元と相手を入れ替えても同じバイト列になることを、どの試験でも確かめる。
 */

const all: MergeOptions = { present: () => true, newer: () => null };

/** 手元 a、相手 b で合わせた結果と、入れ替えて合わせた結果が一致することを確かめて返す。newer は a 側から見た答えで、入れ替えた側には反転して渡す。 */
function both(a: string, b: string, o: MergeOptions = all): string {
  const flip = (s: 'a' | 'b' | null): 'a' | 'b' | null => (s === 'a' ? 'b' : s === 'b' ? 'a' : null);
  const ab = mergeMemoryIndex(a, b, o);
  const ba = mergeMemoryIndex(b, a, { present: o.present, newer: (f) => flip(o.newer(f)) });
  expect(ba).toBe(ab);
  return ab;
}

const line = (file: string, note = file): string => `- [${file}](${file}.md) — ${note}`;
const doc = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('memoryLinkOf', () => {
  it('行頭の箇条の、相対の .md のリンクだけを本文のファイルと読む', () => {
    expect(memoryLinkOf('- [題名](a.md) — 一言')).toBe('a.md');
    expect(memoryLinkOf('* [題名](sub/b.md)')).toBe('sub/b.md');
    expect(memoryLinkOf('# 見出し')).toBeNull();
    expect(memoryLinkOf('')).toBeNull();
    expect(memoryLinkOf('- [外](https://example.com/a.md)')).toBeNull();
    expect(memoryLinkOf('- [上](../a.md)')).toBeNull();
    expect(memoryLinkOf('- [絶対](/a.md)')).toBeNull();
    expect(memoryLinkOf('- [画像](a.png)')).toBeNull();
  });
});

describe('mergeMemoryIndex', () => {
  it('両方の末尾に足した行を、どちらにも残す（入れ替えても同じ並び）', () => {
    const base = [line('x'), line('y')];
    const out = both(doc(...base, line('a1'), line('a2')), doc(...base, line('b1')));
    expect(out.split('\n').filter(Boolean)).toHaveLength(5);
    expect(out.startsWith(doc(...base))).toBe(true);
    for (const f of ['a1', 'a2', 'b1']) expect(out).toContain(line(f));
    // 片側の続けて足した行は、続いたまま並ぶ。
    expect(out).toContain(`${line('a1')}\n${line('a2')}`);
  });

  it('途中に足した行は、前の行の後ろに置く', () => {
    const out = both(doc(line('x'), line('a'), line('y')), doc(line('x'), line('y'), line('b')));
    expect(out).toBe(doc(line('x'), line('a'), line('y'), line('b')));
  });

  it('合わせた結果をもう一度片方と合わせても変わらない（3 台目や次の周で揺れない）', () => {
    const a = doc('# 索引', line('x'), line('a1'), '', line('y'), line('a2'));
    const b = doc('# 索引', line('x'), line('b1'), '', line('y'), line('b2'));
    const m = both(a, b);
    expect(both(a, m)).toBe(m);
    expect(both(b, m)).toBe(m);
    expect(both(m, m)).toBe(m);
  });

  it('指す本文のファイルが無い行は落とす（両側から）', () => {
    const present = (f: string): boolean => f !== 'gone.md';
    const out = both(doc(line('x'), line('gone')), doc(line('x'), line('b')), { present, newer: () => null });
    expect(out).toBe(doc(line('x'), line('b')));
  });

  it('同じファイルを指す行の一言が違えば、本文が新しい側の行を採る', () => {
    const a = doc(line('x', '古い'), line('a'));
    const b = doc(line('x', '新しい'), line('b'));
    expect(both(a, b, { present: () => true, newer: (f) => (f === 'x.md' ? 'b' : null) })).toContain(line('x', '新しい'));
    expect(both(a, b, { present: () => true, newer: (f) => (f === 'x.md' ? 'a' : null) })).toContain(line('x', '古い'));
    // 決められないときも、両側で同じ行を採り、どちらか一方だけが残る。
    const tie = both(a, b);
    expect(tie.split('\n').filter((l) => memoryLinkOf(l) === 'x.md')).toHaveLength(1);
  });

  it('リンクの無い行（見出し、空行）は手元の位置に残し、相手だけのものも失わない', () => {
    const a = doc('# 索引', '', line('x'));
    const b = doc('# 索引', '', line('x'), '', '## 古いもの', line('old'));
    const out = both(a, b);
    expect(out).toBe(doc('# 索引', '', line('x'), '', '## 古いもの', line('old')));
  });

  it('共通の行の並びが両側で違っても、両側で同じ結果になり、行は重ならない', () => {
    const a = doc(line('x'), line('y'), line('a'));
    const b = doc(line('y'), line('x'), line('b'));
    const out = both(a, b);
    for (const f of ['x', 'y', 'a', 'b']) expect(out.split('\n').filter((l) => l === line(f))).toHaveLength(1);
  });

  it('改行は、両方が CRLF のときだけ CRLF。末尾の改行はどちらかにあれば付ける', () => {
    expect(both(`${line('x')}\r\n${line('a')}\r\n`, `${line('x')}\r\n${line('b')}\r\n`)).toMatch(/\r\n$/);
    const mixed = both(`${line('x')}\r\n${line('a')}\r\n`, `${line('x')}\n${line('b')}`);
    expect(mixed).not.toContain('\r');
    expect(mixed.endsWith('\n')).toBe(true);
  });
});
