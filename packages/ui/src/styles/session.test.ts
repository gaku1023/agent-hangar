import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
const rules = files.flatMap((f) => [...strip(read(f)).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ file: f, selector: m[1]!.trim(), body: m[2]! })));
/**
 * 選択子がちょうど一致する規則の中身。
 * 1 つだけあることも確かめる。
 */
const body = (selector: string) => {
  const found = rules.filter((r) => r.selector === selector);
  expect(found, selector).toHaveLength(1);
  return found[0]!.body;
};

// セッション画面の組み直し（UX 刷新 2 の 1）。
// 窓の残りの高さを縦の flex で配り、決め打ちの高さを使わない。
describe('セッション画面の縦の配り方', () => {
  it('窓の高さから決め打ちで引いた高さ（calc(100vh - …)）を、ターミナルにも本文にも使わない', () => {
    for (const r of rules) if (/\.split\b|\.tr\b|\.tr-sheet|\.session-/.test(r.selector)) expect(r.body, `${r.file}: ${r.selector}`).not.toMatch(/100vh/);
  });
  it('セッション画面のときだけ、本文の列を縦の flex にして、中身に残りの高さを渡す', () => {
    expect(body('.shell[data-wide] .main')).toMatch(/display: flex;[^}]*flex-direction: column;/);
    const inner = body('.shell[data-wide] .main-inner');
    expect(inner).toMatch(/flex: 1;/);
    expect(inner).toMatch(/min-height: 0;/);
    expect(inner).toMatch(/display: flex;/);
    expect(inner).toMatch(/flex-direction: column;/);
    const screen = body('.session-screen');
    expect(screen).toMatch(/flex: 1;/);
    expect(screen).toMatch(/min-height: 0;/);
    expect(screen).toMatch(/flex-direction: column;/);
  });
  it('ターミナルの段と本文の段が残りを全部受け取り、上の段は縮まない', () => {
    expect(body('.session-screen > *')).toMatch(/flex: none;/);
    const fill = body('.session-screen > .split, .session-screen > .session-body');
    expect(fill).toMatch(/flex: 1;/);
    expect(fill).toMatch(/min-height:/);
  });
  it('本文の面の中でも、一覧の箱が残りを受け取ってスクロールする', () => {
    expect(body('.tr-sheet')).toMatch(/display: flex;[^}]*flex-direction: column;/);
    expect(body('.tr-sheet .tr-wrap')).toMatch(/flex: 1;[^}]*min-height: 0;/);
    expect(body('.tr')).toMatch(/flex: 1;[^}]*min-height: 0;/);
  });
});

describe('セッション画面の幅（案 b）', () => {
  it('セッション画面だけ --main-w の上限を外す。ほかの画面は 1200px のまま', () => {
    expect(read('tokens.css')).toContain('--main-w: 1200px;');
    expect(body('.shell[data-wide]')).toMatch(/--main-w: 100vw;/);
  });
});

describe('見出しの行の操作（A1）', () => {
  it('「…」は行の高さの丸いアイコンのボタンで、押せない主の操作は薄くする', () => {
    expect(body('.btn-icon')).toMatch(/width: var\(--row-h\);[^}]*padding: 0;/);
    expect(body(".session-hero .btn[aria-disabled='true']")).toMatch(/opacity: 0\.5;/);
  });
});

describe('線の下の 1 行（B1）', () => {
  it('24px の 1 行で、折り返さずにはみ出す分を切る。作業ディレクトリから縮める', () => {
    const b = body('.session-info');
    expect(b).toMatch(/height: 24px;/);
    expect(b).toMatch(/white-space: nowrap;/);
    expect(b).toMatch(/overflow: hidden;/);
    expect(body('.session-info > *')).toMatch(/flex: none;/);
    expect(body('.session-info > .session-info-cwd')).toMatch(/flex: 0 1 auto;[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/);
  });
});

describe('ターミナルの知らせ（F1）', () => {
  it('切れている間は板を暗く沈め、縁の灯を消し、中央に白いカードを置く', () => {
    expect(body(".term-pane[data-off] .term-host")).toMatch(/opacity: 0\.28;/);
    expect(body(".term-pane[data-off]")).toMatch(/animation: none;/);
    expect(body('.term-veil')).toMatch(/place-items: center;/);
    expect(body('.term-off-card')).toMatch(/background: var\(--surface\);/);
  });
  it('transcript の帯はターミナルの上端の全幅の帯で、杏の地にする', () => {
    const b = body('.term-band');
    expect(b).toMatch(/flex: none;/);
    expect(b).toMatch(/var\(--term-tool\)/);
  });
});

// タブの列は耳を板に付けるために下揃えにしている。
// 列いっぱいの高さのタブと分割ボタンはそれで揃うが、列より低い追加ボタンは下に寄り、＋だけ 4px 下がって見えた。
describe('タブの列の追加ボタン', () => {
  it('列は下揃えのまま、列より低い追加ボタンだけを縦の中央に戻す', () => {
    expect(body('.tabs')).toMatch(/align-items: flex-end;/);
    expect(body('.tab-close, .tab-add')).toMatch(/height: calc\(var\(--u\) \* 5\);/);
    expect(body('.tab-add')).toMatch(/align-self: center;/);
  });
});
