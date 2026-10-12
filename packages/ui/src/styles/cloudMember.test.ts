import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// 設定のクラウド同期の、PC の表と参加トークンの欄の規則。
// jsdom は配置を計算しないので、ここでは規則の形を押さえ、実際に収まるかは WebKit で撮って確かめる。
const read = (name: string) => fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rulesOf = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
const body = (css: string, sel: string) => {
  const r = rulesOf(css).filter((x) => x.sel.split(',').map((s) => s.trim()).includes(sel));
  expect(r.length, sel).toBeGreaterThan(0);
  return r.map((x) => x.body).join(';');
};
const decl = (b: string, prop: string) => b.match(new RegExp(`(?:^|;)\\s*${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`))?.[1]?.trim();

describe('PC の表の、名前の下の場所と最後の IP', () => {
  // IPv6 の IP は長く、1 行の後ろに場所を置くと、IP の途中で切られて場所が見えなかった（0.4.0-rc.1 の Windows の実機）。
  // 場所を先に置いて縮めず、縮んで省略記号になるのは IP だけにする。
  const css = read('cloudMember.css');

  it('行は横に並べ、はみ出しは隠す', () => {
    const b = body(css, '.cm-where');
    expect(decl(b, 'display')).toBe('flex');
    expect(decl(b, 'min-width')).toBe('0');
    expect(decl(b, 'overflow')).toBe('hidden');
  });

  it('場所は縮めない（欄より長いときだけ、場所も省略記号にする）', () => {
    const b = body(css, '.cm-place');
    expect(decl(b, 'flex-shrink')).toBe('0');
    expect(decl(b, 'max-width')).toBe('100%');
    expect(decl(b, 'text-overflow')).toBe('ellipsis');
  });

  it('IP は縮んで省略記号になる', () => {
    const b = body(css, '.cm-ip');
    expect(decl(b, 'min-width')).toBe('0');
    expect(decl(b, 'flex-shrink')).toBe('1');
    expect(decl(b, 'text-overflow')).toBe('ellipsis');
    expect(decl(b, 'white-space')).toBe('nowrap');
    expect(decl(b, 'overflow')).toBe('hidden');
  });
});

describe('伏せ字の欄', () => {
  // WebView2（Windows）は password の欄に「表示」の目のボタンを足す。参加トークンを画面に出さないので、出さない。
  it('Edge の表示と消去のボタンを出さない', () => {
    const css = read('base.css');
    expect(decl(body(css, '.input::-ms-reveal'), 'display')).toBe('none');
    expect(decl(body(css, '.input::-ms-clear'), 'display')).toBe('none');
  });
});
