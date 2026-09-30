import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SESSION_ROW_H } from '../views/SessionRows.tsx';

const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

describe('2 段の行', () => {
  // 仮想スクロールの見積もり（SESSION_ROW_H）と、CSS の高さがずれると、スクロールの位置が行の途中で止まる。
  it('行の高さは 56px で、tokens.css と SessionRows の見積もりが揃う', () => {
    expect(SESSION_ROW_H).toBe(56);
    expect(read('./tokens.css')).toContain(`--session-row-h: ${SESSION_ROW_H}px;`);
    expect(read('./rows.css')).toMatch(/\.row-2 \{[^}]*height: var\(--session-row-h\);/);
  });
  it('1 段の部品の高さ（--row-h）は 28px のまま', () => {
    expect(read('./tokens.css')).toContain('--row-h: 28px;');
  });
  it('メモは利用者の書いた本文なので、注記の色ではなく本文の色で出す', () => {
    // --ink-3 は注記の 3 : 1 までしか約束しない。本文には 4.5 : 1 を超える --ink-2 を使う。
    expect(read('./rows.css')).toMatch(/\.row-memo \{[^}]*color: var\(--ink-2\);/);
  });
  it('一致した語の印は淡い地で、文字の色は変えない', () => {
    expect(read('./rows.css')).toMatch(/\.hit \{[^}]*background: var\(--hit\);[^}]*color: inherit;/);
  });
  // .btn の高さ（28px）のままだと、2 段目（1 行分の高さ）が行の下端からはみ出す。
  it('2 段目の鉛筆とメモ入力は、1 行分の高さに収まる', () => {
    const css = read('./rows.css');
    expect(css).toMatch(/\.row-sub \.memo-pencil \{[^}]*height: calc\(var\(--u\) \* 5\);/);
    expect(css).toMatch(/\.row-sub \.memo-input \{[^}]*height: calc\(var\(--u\) \* 5\);/);
  });
});

describe('プロジェクトのカード（C1）', () => {
  const css = read('./workbench.css');
  it('抜粋は 2 行で切り、2 行分の高さを取る', () => {
    expect(css).toMatch(/\.card-excerpt \{[^}]*-webkit-line-clamp: 2;[^}]*min-height: 2\.9em;/);
  });
  // 12 枚すべてに同じボタンが並ぶとうるさいので、乗せたときとキーボードで届いたときだけ見せる。
  it('「ここで始める」は乗せたときと、カードの中にフォーカスがあるときだけ見せる', () => {
    expect(css).toMatch(/\.card-here \{[^}]*opacity: 0;/);
    expect(css).toMatch(/\.card:hover \.card-here,\s*\.card:focus-within \.card-here \{[^}]*opacity: 1;/);
  });
});
