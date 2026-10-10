import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 入れ子の無い規則を、選択子と中身の組で取り出す。@media の中の規則も、内側の規則として拾える。 */
const rules = (css: string) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
const all = files.flatMap((f) => rules(read(f)).map((r) => ({ ...r, file: f })));
const blurs = all.filter((r) => /(^|[^-])backdrop-filter\s*:/.test(r.body));

// 仕様：ガラスは浮く部品（ヘッダ、サイドバー、⌘K、ダイアログ、通知と切断の帯、選ぶ部品の一覧、操作のメニュー、本文の中の検索の欄）にだけ使う。
const GLASS = ['.header', '.conn-banner', '.dialog', '.palette', '.toast', '.listbox-pop', '.menu-pop', '.tr-find'];

describe('浮くガラス', () => {
  it('backdrop-filter は浮く部品の規則にだけ現れる', () => {
    expect(blurs.length).toBeGreaterThan(0);
    for (const r of blurs) expect(GLASS, `${r.file}: ${r.selector}`).toContain(r.selector);
  });
  it('どのぼかしにも -webkit- の併記がある（macOS 13 と 14 の WKWebView のため）', () => {
    for (const r of blurs) expect(r.body, `${r.file}: ${r.selector}`).toContain('-webkit-backdrop-filter:');
  });
});
