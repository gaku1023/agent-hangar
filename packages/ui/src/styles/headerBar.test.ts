import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// ヘッダの「移動・操作」のバー（.search-pill）の位置と大きさ。
// 左端と幅は、どの画面でも変わらない。セッション画面だけが付ける印（.shell[data-wide]）で値が変わる変数に頼らない。
// jsdom は配置を計算しないので、ここでは式の形を押さえ、実際の位置は WebKit で撮って確かめる。
const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
const base = strip(read('base.css'));

/** 波括弧の釣り合いを見て、at の位置から始まる塊の中身を返す。 */
function block(css: string, at: number): string {
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('閉じていない塊');
}

/** 選択子と宣言の組（入れ子の中も拾う）。 */
const rules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
const decl = (body: string, prop: string) => body.match(new RegExp(`(?:^|;)\\s*${prop.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`))?.[1]?.trim();
const containerBlock = (min: number) => {
  const at = base.indexOf(`@container header (min-width: ${min}px)`);
  expect(at, `@container header (min-width: ${min}px)`).toBeGreaterThanOrEqual(0);
  return block(base, at);
};

/** 式が参照する変数を、定義をたどって全部集める（どの選択子での定義もたどる、保守的な見積もり）。 */
function dependsOn(expr: string): Set<string> {
  const defs = new Map<string, string[]>();
  for (const f of sheets) {
    for (const r of rules(strip(read(f)))) {
      for (const m of r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) defs.set(m[1]!, [...(defs.get(m[1]!) ?? []), m[2]!]);
    }
  }
  const seen = new Set<string>();
  const queue = [...expr.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!);
  while (queue.length) {
    const v = queue.pop()!;
    if (seen.has(v)) continue;
    seen.add(v);
    for (const d of defs.get(v) ?? []) for (const m of d.matchAll(/var\((--[\w-]+)/g)) queue.push(m[1]!);
  }
  return seen;
}

/** セッション画面だけで値の変わる変数（.shell[data-wide] の規則で定義し直すもの）。 */
const wideVars = () => {
  const out = new Set<string>();
  for (const f of sheets) {
    for (const r of rules(strip(read(f)))) {
      if (!r.sel.includes('data-wide')) continue;
      for (const m of r.body.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]!);
    }
  }
  return out;
};

describe('移動・操作のバーの左端', () => {
  const left = rules(base).find((r) => r.sel === '.header-row > .search-pill');
  it('左端は --gutter-head で決め、本文の幅（--main-w）や行の幅（cqw）から計算しない', () => {
    const margin = decl(left?.body ?? '', 'margin-left');
    expect(margin).toBe('var(--gutter-head)');
  });
  it('左端の式は、セッション画面で値の変わる変数に頼らない', () => {
    const deps = dependsOn('var(--gutter-head)');
    expect(deps.has('--head-end')).toBe(true);
    expect(deps.has('--col1')).toBe(true);
    for (const v of ['--main-w', '--box-l']) expect(deps.has(v), v).toBe(false);
    for (const v of wideVars()) expect(deps.has(v), v).toBe(false);
  });
  it('ロゴを避ける式は max(16px, ヘッダの右端 − 左の列の幅) で、本文の箱の余りを引かない', () => {
    const shell = rules(base).filter((r) => r.sel === '.shell').map((r) => decl(r.body, '--gutter-head')).find(Boolean);
    expect(shell).toBe('max(calc(var(--u) * 4), calc(var(--head-end) - var(--col1)))');
    expect(base).not.toContain('--box-l');
  });
  it('バーの規則は、セッション画面の印（data-wide）で書き分けない', () => {
    for (const f of sheets) {
      for (const r of rules(strip(read(f)))) {
        if (r.sel.includes('data-wide')) expect(r.sel, `${f}: ${r.sel}`).not.toMatch(/search-pill|header/);
      }
    }
  });
});

describe('移動・操作のバーの大きさ（行の幅で 3 段）', () => {
  /** container の塊を除いた、いつも効く規則。 */
  const top = (() => {
    let css = base;
    for (;;) {
      const at = css.indexOf('@container header');
      if (at < 0) return css;
      const inner = block(css, at);
      css = css.slice(0, at) + css.slice(css.indexOf(inner, at) + inner.length + 1);
    }
  })();
  /** その選択子の規則を上から重ねたときの、最後の値。 */
  const last = (css: string, sel: string, prop: string) => rules(css).filter((r) => r.sel === sel).map((r) => decl(r.body, prop)).filter(Boolean).at(-1);
  it('行の幅が 640px 未満は虫眼鏡だけの丸いボタンで、文字、キー帽、説明の文を出さない', () => {
    expect(last(top, '.search-pill', 'width')).toBe('var(--row-h)');
    expect(last(top, '.search-pill', 'padding')).toBe('0');
    expect(last(top, '.search-pill-label, .search-kbd, .search-pill-hint', 'display')).toBe('none');
  });
  it('640〜999px は今の錠剤（中身の分の幅、文字とキー帽）', () => {
    const mid = containerBlock(640);
    expect(last(mid, '.search-pill', 'width')).toBe('auto');
    expect(last(mid, '.search-pill-label, .search-kbd', 'display')).toBe('inline-flex');
  });
  it('1000px 以上は長い欄で、幅は行の幅だけで決め、高さ 34px、字 14px', () => {
    const wide = containerBlock(1000);
    const width = last(wide, '.search-pill', 'width');
    expect(width).toBe('clamp(280px, calc(50cqw - 240px), 600px)');
    expect(last(wide, '.search-pill', 'height')).toBe('34px');
    expect(last(wide, '.search-pill', 'font-size')).toBe('14px');
    // 長い欄では「移動・操作」の代わりに、何を探せるかの文を出す。
    expect(last(wide, '.search-pill-label', 'display')).toBe('none');
    expect(last(wide, '.search-pill-hint', 'display')).toBe('block');
    // 畳んだときは、背と同じ幅の丸になる。
    expect(last(wide, '.header .search-pill:has(> [data-folded])', 'width')).toBe('34px');
    const deps = dependsOn(width!);
    for (const v of wideVars()) expect(deps.has(v), v).toBe(false);
  });
  it('段は行の幅が広がる向きにだけ書き、決め打ちの幅で畳む向き（max-width）には書かない', () => {
    expect(base).not.toMatch(/@container header \((max-width|width <)/);
  });
});

describe('本文の列', () => {
  it('スクロールバーの溝を常に取り、中身の有無で本文の左右がずれない', () => {
    const main = rules(base).find((r) => r.sel === '.main');
    expect(decl(main?.body ?? '', 'scrollbar-gutter')).toBe('stable');
  });
});
