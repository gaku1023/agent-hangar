import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// 設定のクラウド同期の、PC とスマホの表と伏せ字の欄の規則。
// jsdom は配置を計算しないので、ここでは規則の形を押さえ、実際に収まるかは WebKit で撮って確かめる。
const read = (name: string) => fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rulesOf = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
const body = (css: string, sel: string) => {
  const r = rulesOf(css).filter((x) => x.sel.split(',').map((s) => s.trim()).includes(sel));
  expect(r.length, sel).toBeGreaterThan(0);
  return r.map((x) => x.body).join(';');
};
const decl = (b: string, prop: string) => b.match(new RegExp(`(?:^|;)\\s*${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`))?.[1]?.trim();

describe('PC とスマホの表（試作 cloud-e2e の E2）', () => {
  const css = read('cloudMember.css');

  it('IP と所在地の規則は残さない（互換の版 9 で表示をやめた）', () => {
    const sels = rulesOf(css).flatMap((x) => x.sel.split(',').map((s) => s.trim()));
    for (const gone of ['.cm-where', '.cm-place', '.cm-ip', '.cm-sep']) expect(sels).not.toContain(gone);
  });

  it('スマホの名前の下の 1 行（残りの日数と再接続の日付）は、欄より長ければ省略記号で切る', () => {
    const b = body(css, '.cm-sub');
    expect(decl(b, 'overflow')).toBe('hidden');
    expect(decl(b, 'text-overflow')).toBe('ellipsis');
    expect(decl(b, 'white-space')).toBe('nowrap');
  });
});

describe('伏せ字の欄', () => {
  // WebView2（Windows）は password の欄に「表示」の目のボタンを足す。API キーのような秘密を画面に出さないので、出さない。
  it('Edge の表示と消去のボタンを出さない', () => {
    const css = read('base.css');
    expect(decl(body(css, '.input::-ms-reveal'), 'display')).toBe('none');
    expect(decl(body(css, '.input::-ms-clear'), 'display')).toBe('none');
  });
});
