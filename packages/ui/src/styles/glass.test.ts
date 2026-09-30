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

// 仕様：ガラスは浮く部品（ヘッダ、サイドバー、⌘K、ダイアログ、通知と切断の帯）にだけ使う。
const GLASS = ['.sidebar', '.header', '.conn-banner', '.dialog', '.palette', '.toast'];

describe('浮くガラス', () => {
  it('backdrop-filter は浮く部品の規則にだけ現れる', () => {
    expect(blurs.length).toBeGreaterThan(0);
    for (const r of blurs) expect(GLASS, `${r.file}: ${r.selector}`).toContain(r.selector);
  });
  it('どのぼかしにも -webkit- の併記がある（macOS 13 と 14 の WKWebView のため）', () => {
    for (const r of blurs) expect(r.body, `${r.file}: ${r.selector}`).toContain('-webkit-backdrop-filter:');
  });
});

describe('骨格', () => {
  const base = read('base.css');
  it('中身はヘッダの下をくぐり、切断の帯が出ている間は帯の分も下がる', () => {
    expect(base).toMatch(/\.main \{[^}]*grid-row: 1 \/ -1;/);
    expect(base).toContain('.shell:has(.conn-banner) .main {');
  });
  // 信号の 3 点は、開閉に関わらずヘッダの左端に載る。ヘッダは VS Code のタイトルバーと同じく、窓の上辺と左右の端に付いた帯で、動かない。
  it('ヘッダは窓の上辺に付いた帯で、サイドバーは開閉に関わらずその下から始まる', () => {
    const header = all.find((r) => r.selector === '.header')?.body;
    expect(header).toContain('grid-column: 1 / -1;');
    expect(header).toMatch(/margin: 0;/);
    expect(header).toMatch(/border-radius: 0;/);
    expect(all.find((r) => r.selector === '.sidebar')?.body).toContain('margin: calc(var(--header-h) + var(--float-gap)) 0 var(--float-gap) var(--float-gap);');
    expect(all.filter((r) => r.selector.includes("[data-sidebar='collapsed']") && r.selector.includes('.header'))).toEqual([]);
  });
  it('信号の 3 点の分の余白は、殻の中でだけ、ヘッダの左に取る', () => {
    expect(all.filter((r) => r.selector.includes('.sidebar') && r.body.includes('padding-top'))).toEqual([]);
    const lefts = all.filter((r) => r.body.includes('var(--lights-end)'));
    expect(lefts.map((r) => r.selector)).toEqual(["[data-shell='desktop'] .header"]);
    expect(lefts[0]?.body).toContain('padding-left: var(--lights-end);');
  });
  it('横スワイプで戻る／進むをしても、頁ごと（サイドバーも）は引っ張られない', () => {
    const r = all.find((r) => r.selector === 'html, body');
    expect(r?.body).toMatch(/overscroll-behavior:\s*none;/);
  });
  it('背景の光は漂い、reduced motion では止まる', () => {
    expect(base).toMatch(/\.shell::before \{[^}]*animation: aura-drift var\(--aura-period\)/);
    expect(base).toContain('@media (prefers-reduced-motion: reduce) { .shell::before { animation: none; } }');
  });
  // 狭い窓では、何が起きたかの見出しを最後まで残し、次の再接続までの秒数から先に縮める。
  it('切断の帯は、見出しを縮めず、再接続の秒数から先に縮める', () => {
    expect(all.find((r) => r.selector === '.conn-banner > b')?.body).toMatch(/flex: none;/);
    expect(all.find((r) => r.selector === '.conn-banner > .conn-retry')?.body).toMatch(/flex-shrink: 4;/);
  });
});

// 規則を 1 つだけ取り出し、宣言を名前と値の組にする。同じ選択子が 2 度書かれていたら、それは取り違えなので落とす。
const rule = (file: string, selector: string) => {
  const found = rules(read(file)).filter((r) => r.selector === selector);
  expect(found, `${file}: ${selector}`).toHaveLength(1);
  return Object.fromEntries(found[0]!.body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':');
    return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
  })) as Record<string, string>;
};
// 一括指定（margin、padding）の先頭の値を取る。calc の中の空白では切らない。
const CALC = String.raw`calc\((?:[^()]|\([^()]*\))*\)`;
const first = (v: string) => v.match(new RegExp(`^(${CALC}|\\S+)`))![1]!;
// トークンの px の値を差し込み、calc を数に直す。四則演算と括弧のほかは受け付けない。
const tokens = Object.fromEntries([...read('tokens.css').matchAll(/(--[\w-]+):\s*(-?[\d.]+)px;/g)].map((m) => [m[1]!, Number(m[2])]));
const px = (v: string) => {
  const expr = v.replace(/var\((--[\w-]+)\)/g, (_, t: string) => { expect(tokens, t).toHaveProperty(t); return String(tokens[t]); }).replace(/calc\(/g, '(').replace(/(\d)px/g, '$1');
  expect(expr, v).toMatch(/^[\d.\s+\-*/()]+$/);
  return Function(`return (${expr});`)() as number;
};

describe('読む面', () => {
  // 仕様の 3 枚の層の 2 枚目。設定の中身、プロジェクトの右レール、会話は、光の背景の上に白い不透明な面を敷いて読む。
  it.each([
    ['settings.css', '.settings-screen > section'],
    ['workbench.css', '.rail-panel'],
    ['base.css', '.tr-sheet'],
  ])('%s の %s は白い読む面で、ぼかしを持たない', (file, selector) => {
    const d = rule(file, selector);
    expect(d.background).toBe('var(--surface)');
    expect(d['border-radius']).toBe('var(--r-lg)');
    expect(d['box-shadow']).toBe('var(--surface-shadow)');
    expect(d['backdrop-filter']).toBeUndefined();
  });
  // 畳んだ会話の列は 28px しかない。左右の余白を残すと、同じ幅の開くボタンが半分ほど隠れて押しにくくなる。
  it('畳んだ会話の列は左右の余白を持たず、開くボタンを列の幅いっぱいに見せる', () => {
    const d = rule('base.css', ".tr-pane[data-collapsed='true']");
    expect(d.padding).toMatch(new RegExp(`^(${CALC}|\\S+) 0$`));
    expect(px(rule('base.css', '.tr-toggle').width!)).toBe(28);
  });
  it('白い面の中のアーティファクトのカードは、淡い地に落として面を重ねない', () => {
    const body = all.find((r) => r.selector === '.rail-panel .artifact')?.body ?? '';
    expect(body).toMatch(/background: var\(--surface-2\);/);
    expect(body).toMatch(/box-shadow: none;/);
  });
});

describe('ヘッダの下の中身', () => {
  // j と k の行送りや Shift+Tab で届いた先が、浮いたヘッダの下に隠れないようにする（WCAG 2.4.11）。
  it.each(['.main', '.shell:has(.conn-banner) .main'])('%s は上の余白と同じだけ scroll-padding-top を取る', (selector) => {
    const d = rule('base.css', selector);
    expect(d['scroll-padding-top']).toBe(d['padding-top']);
  });
  // ヘッダの下も切断の帯の下も、中身は float-gap の隙間を空けて始まる。
  it('中身の上の余白は、ヘッダと切断の帯の実際の寸法から出る', () => {
    const gap = tokens['--float-gap']!;
    const header = rule('base.css', '.header');
    const headerBottom = px(first(header.margin!)) + px(header.height!);
    expect(px(rule('base.css', '.main')['padding-top']!)).toBe(headerBottom + gap);
    const banner = rule('base.css', '.conn-banner');
    // 帯は高さを決め打ちにし、上下の余白を持たない。中身が伸びて高さが変わると、この計算が合わなくなる。
    expect(banner['min-height']).toBeUndefined();
    expect(first(banner.padding!)).toBe('0');
    const bannerH = px(banner.height!);
    expect(px(rule('sync.css', '.btn-sm').height!)).toBeLessThanOrEqual(bannerH);
    const bannerBottom = headerBottom + px(first(banner.margin!)) + bannerH;
    expect(px(rule('base.css', '.shell:has(.conn-banner) .main')['padding-top']!)).toBe(bannerBottom + gap);
  });
});

describe('端末の板', () => {
  // xterm のスクロールバーや装飾は z-index を持つ。板で重なりを閉じないと、くぐった先の浮いたヘッダの上に描かれる。
  it('.term-pane は重なりの文脈を作る', () => {
    expect(rule('base.css', '.term-pane').isolation).toBe('isolate');
  });
});
