import { describe, expect, it } from 'vitest';
import { diffHunk, diffOps, snippetStart } from './diff.ts';

describe('diffOps', () => {
  it('行ごとに、変わらない行と消えた行と足した行を並べる', () => {
    expect(diffOps('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { t: 'ctx', text: 'a' }, { t: 'del', text: 'b' }, { t: 'add', text: 'B' }, { t: 'ctx', text: 'c' }, { t: 'add', text: 'd' },
    ]);
  });
  it('空の側は全部足したか全部消したことになる', () => {
    expect(diffOps('', 'x\ny')).toEqual([{ t: 'add', text: 'x' }, { t: 'add', text: 'y' }]);
    expect(diffOps('x', '')).toEqual([{ t: 'del', text: 'x' }]);
  });
  it('大きすぎる中身でも止まらずに返す', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const ops = diffOps(big, big.replace('line 1500', 'LINE 1500'));
    expect(ops.filter((o) => o.t === 'del')).toEqual([{ t: 'del', text: 'line 1500' }]);
    expect(ops.filter((o) => o.t === 'add')).toEqual([{ t: 'add', text: 'LINE 1500' }]);
  });
});

describe('diffHunk', () => {
  it('行番号が分かれば前と後の番号と @@ の見出しを付ける', () => {
    const r = diffHunk('    <form>\n      <ErrorSummary />\n      <Field name="password">', '    <form>\n      <Field name="email">\n      </Field>\n      <Field name="password">', { start: 40 });
    expect(r.added).toBe(2);
    expect(r.removed).toBe(1);
    expect(r.hunk.header).toBe('@@ -40,3 +40,4 @@');
    expect(r.hunk.lines).toEqual([
      { t: 'ctx', old: 40, new: 40, text: '    <form>' },
      { t: 'del', old: 41, new: null, text: '      <ErrorSummary />' },
      { t: 'add', old: null, new: 41, text: '      <Field name="email">' },
      { t: 'add', old: null, new: 42, text: '      </Field>' },
      { t: 'ctx', old: 42, new: 43, text: '      <Field name="password">' },
    ]);
  });
  it('行番号が分からなければ番号も見出しも付けない', () => {
    const r = diffHunk('a', 'b', { start: null });
    expect(r.hunk.header).toBeNull();
    expect(r.hunk.lines).toEqual([{ t: 'del', old: null, new: null, text: 'a' }, { t: 'add', old: null, new: null, text: 'b' }]);
  });
  it('変わらない行は変わった所の前後 2 行だけ残し、間は畳んだ数にする', () => {
    const old = ['h1', 'h2', 'h3', 'h4', 'x', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'y', 't1', 't2', 't3'].join('\n');
    const now = old.replace('x', 'X').replace('y', 'Y');
    const lines = diffHunk(old, now, { start: null }).hunk.lines;
    expect(lines.map((l) => (l.t === 'gap' ? `…${l.count}` : `${l.t}:${l.text}`))).toEqual([
      '…2', 'ctx:h3', 'ctx:h4', 'del:x', 'add:X', 'ctx:m1', 'ctx:m2', '…2', 'ctx:m5', 'ctx:m6', 'del:y', 'add:Y', 'ctx:t1', 'ctx:t2', 'ctx:t3',
    ]);
  });
  it('畳むと 1 行しか隠れないときは畳まずに出す', () => {
    const old = ['a', 'b', 'c', 'x', 'd', 'e', 'f', 'g', 'y'].join('\n');
    const now = old.replace('x', 'X').replace('y', 'Y');
    const lines = diffHunk(old, now, { start: null }).hunk.lines;
    expect(lines.some((l) => l.t === 'gap')).toBe(false);
    expect(lines.filter((l) => l.t === 'ctx').map((l) => (l.t === 'ctx' ? l.text : ''))).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });
});

describe('snippetStart', () => {
  const result = [
    "The file /w/src/a.tsx has been updated. Here's the result of running `cat -n` on a snippet of the edited file:",
    '    38→export function A() {',
    '    39→  return (',
    '    40→    <form>',
    '    41→      <Field name="email">',
  ].join('\n');
  it('編集の結果の cat -n の抜粋から、新しい中身の最初の行の番号を読む', () => {
    expect(snippetStart(result, '    <form>\n      <Field name="email">')).toBe(40);
  });
  it('先頭が空行なら、最初の空でない行から逆算する', () => {
    expect(snippetStart(result, '\n    <form>')).toBe(39);
  });
  it('抜粋に見つからなければ null', () => {
    expect(snippetStart(result, 'nothing like this')).toBeNull();
    expect(snippetStart('The file /w/a has been updated successfully.', 'x')).toBeNull();
  });
});
