import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// プロジェクト画面の右パネルの置き方（workbench.css）。
// jsdom は配置を計算しないので、ここでは規則の形を押さえ、実際の位置は WebKit で撮って確かめる。
const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const css = read('./workbench.css') + read('./base.css');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
const decl = (sel: string, prop: string) => {
  const r = rules.filter((x) => x.sel.split(',').map((s) => s.trim()).includes(sel));
  expect(r.length, sel).toBeGreaterThan(0);
  const v = r.map((x) => x.body.match(new RegExp(`(?:^|;)\\s*${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`))?.[1]?.trim()).filter(Boolean);
  return v[v.length - 1];
};

describe('プロジェクト画面の見出しと右パネル（workbench.css）', () => {
  it('見出しは 1 行目で両方の列にかかり、左の一覧と右パネルは 2 行目に並ぶ。開閉のボタンは右パネルの右端の上に留まる', () => {
    expect(decl('.project-screen', 'grid-template-rows')).toBe('auto minmax(0, 1fr)');
    expect(decl('.project-screen', 'row-gap')).toBe('0');
    expect(decl('.project-screen > .page-head', 'grid-column')).toBe('1 / -1');
  });
  it('指示とメモリの名前は、大きさと更新が入り切らなければそちらを次の行へ送り、名前を切らない', () => {
    expect(decl('.instr-name', 'flex-wrap')).toBe('wrap');
    expect(decl('.instr-name .mono', 'flex')).toBe('0 1 auto');
  });
});
