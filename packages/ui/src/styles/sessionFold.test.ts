import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// セッション画面の右の列を畳むボタンの置き場所（2026-10-12、利用者が選んだ試作の A「列の頭の行」）。
// タブの列を本体（.c-body）の 1 行目に入れ、右の列はその行から下端までを占める。
// 列の上端の頭の行（.toc-slot-head）はタブの列と同じ高さで、右端に畳むボタンを置く。畳むと、同じ右上にタブの列の「目次 N」の札が出る。
// jsdom は配置を計算しないので、ここでは規則の形を押さえ、実際の位置は WebKit で撮って確かめる。
const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const css = read('./session.css') + read('./base.css');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
const decl = (sel: string, prop: string) => {
  const r = rules.filter((x) => x.sel.split(',').map((s) => s.trim()).includes(sel));
  expect(r.length, sel).toBeGreaterThan(0);
  const v = r.map((x) => x.body.match(new RegExp(`(?:^|;)\\s*${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`))?.[1]?.trim()).filter(Boolean);
  return v[v.length - 1];
};

describe('右の列の頭の行（session.css）', () => {
  it('タブの列のある本体は、1 行目をタブの列の高さにし、行の隙間を持たない（耳と板がつながる）', () => {
    expect(decl(".c-body[data-strip]", 'grid-template-rows')).toBe('var(--row-h) minmax(0, 1fr)');
    expect(decl(".c-body[data-strip]", 'row-gap')).toBe('0');
    expect(decl('.c-body[data-strip] > .tabs', 'grid-row')).toBe('1');
    expect(decl('.c-body[data-strip] > .c-main', 'grid-row')).toBe('2');
  });
  it('右の列はタブの列の行から下端までを占め、畳んでいる間はタブの列が全幅にかかる', () => {
    expect(decl('.c-body[data-strip] > .toc-slot', 'grid-row')).toBe('1 / -1');
    expect(decl('.c-body[data-strip] > .toc-slot', 'grid-column')).toBe('2');
    expect(decl('.c-body[data-strip] > .tabs', 'grid-column')).toBe('1');
    expect(decl(".c-body[data-strip][data-folded] > .tabs", 'grid-column')).toBe('1 / -1');
  });
  it('頭の行はタブの列と同じ高さで、下の札との隙間を詰める（札と目次の縦の幅を減らさない）', () => {
    expect(decl('.toc-slot-head', 'height')).toBe('var(--row-h)');
    expect(decl('.toc-slot-inner', 'gap')).toBe('calc(var(--u) * 2)');
    expect(decl('.toc-slot-head', 'margin-bottom')).toBe('calc(var(--u) * -2)');
  });
  it('狭い窓の上乗せは、列の行の決まりを外して本体の上端（タブの列の行）から重ねる', () => {
    expect(decl('.c-body[data-narrow] .toc-slot', 'top')).toBe('0');
    expect(decl('.c-body[data-narrow] .toc-slot', 'grid-row')).toBe('auto');
    expect(decl('.c-body[data-narrow] .toc-slot', 'grid-column')).toBe('auto');
    // 現在の札が長い文の幅まで広がらないよう、上乗せも列と同じ幅に留める。
    expect(decl('.c-body[data-narrow] .toc-slot', 'width')).toBe('240px');
  });
  it('耳の下の板の角は、本体の中のタブの列に続くターミナルで角張らせる', () => {
    expect(rules.some((r) => r.sel.includes('.c-body > .tabs + .c-main > :first-child.term-pane'))).toBe(true);
  });
});
