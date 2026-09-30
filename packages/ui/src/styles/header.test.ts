import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const base = read('./base.css');
/** セレクタがちょうど一致する規則の中身。 */
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(base)?.[1] ?? '';
};

describe('ヘッダの列と検索欄の位置', () => {
  // ヘッダは殻の列を subgrid で使う。container はレイアウトの封じ込めを伴い、封じ込めのある要素では subgrid が効かない。
  it('ヘッダは subgrid で殻の列を使い、大きさの入れ物は内側の行に付ける', () => {
    expect(rule('.header')).toContain('grid-template-columns: subgrid;');
    expect(rule('.header')).not.toContain('container');
    expect(rule('.header-row')).toContain('container: header / inline-size;');
  });
  // 本文と検索欄は同じ左の余白（--gutter-l）で始まる。本文は --main-w で中央に寄るので、検索欄もその分を足す。
  // 余白を広げるのは、中央へ寄った本文がロゴの右端より左に来るときだけにする。いつも足すと、広い窓で畳んだときに本文が右へ逃げる。
  it('本文の左の余白は、中央へ寄った分を引いてから、ロゴの右端に届く分だけ広げる', () => {
    expect(base).toContain('--gutter-l: max(calc(var(--u) * 4), calc(var(--head-end) - var(--col1) - var(--box-l)));');
    expect(base).toContain('--box-l: max(0px, calc((100vw - var(--col1) - var(--main-w)) / 2));');
  });
  it('検索欄の左端は、本文の左端と同じ式で決まる', () => {
    expect(rule('.main-inner')).toMatch(/max-width: var\(--main-w\);[^}]*margin: 0 auto;[^}]*var\(--gutter-l\);/);
    expect(base).toContain('margin-left: max(var(--gutter-l), calc((100cqw - var(--main-w)) / 2 + var(--gutter-l)));');
  });
  // 開閉の動きは --col1 も動かす。登録していないと途中の値が補間されず、本文と検索欄の余白だけが跳ぶ。
  it('左の列の幅は、登録したカスタムプロパティ --col1 に持つ', () => {
    expect(base).toContain("@property --col1 { syntax: '<length>'; inherits: true;");
    expect(base).toMatch(/\.shell \{[^}]*grid-template-columns: var\(--col1\) minmax\(0, 1fr\);/);
    expect(rule(".shell[data-sidebar='collapsed']")).toContain('--col1:');
    expect(base).not.toMatch(/\.shell\[data-sidebar='collapsed'\] \{[^}]*grid-template-columns/);
  });
  // 畳んだ帯ではロゴが列の外まで伸びる。ロゴの箱の幅を決め打ちにしておかないと、字形の読み込みの前後で本文の位置が動く。
  it('ロゴの箱の幅は tokens の --brand-w に決め打ちし、はみ出した分は切る', () => {
    expect(read('./tokens.css')).toMatch(/--brand-w: \d+px;/);
    expect(rule('.brand')).toMatch(/width: var\(--brand-w\);[^}]*overflow: hidden;/);
    expect(base).toMatch(/--head-end: calc\(var\(--head-lead\) \+ var\(--brand-w\) \+ [^;]+\);/);
  });
});

describe('頁の見出し', () => {
  it('見出しは 18px の太字で、下の線で本文と分ける', () => {
    expect(rule('.page-title')).toMatch(/font-size: 18px;[^}]*font-weight: 700;/);
    expect(rule('.page-head')).toContain('border-bottom: 1px solid var(--line-strong);');
  });
  // 親の行と見出しの行の高さを決めておくと、どの頁へ移っても見出しと線の高さが揃う。
  it('親の行と見出しの行は、中身に関わらず同じ高さを取る', () => {
    expect(rule('.page-parent')).toContain('height: 18px;');
    expect(rule('.page-title-row')).toContain('min-height: var(--row-h);');
  });
});
