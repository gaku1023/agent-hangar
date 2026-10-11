import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// ホームの動き（設計書「Home の帯と引き出し」「Home の一覧」「見た目と動き」）のうち、CSS が持つもの。長さと曲線はトークンを通す。
const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** 選択子に当たる宣言の塊。 */
const block = (css: string, selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === selector)?.[2] ?? '';

describe('ホームの動きの CSS', () => {
  it('始める前の確認の進みの棒は、幅を --dur で伸ばす', () => {
    expect(block(read('./home.css'), '.home-band .band-prog > span')).toMatch(/transition: width var\(--dur\) var\(--ease-out\)/);
  });
  it('一覧の行は並び替えで滑らせない（⑤ の c。並びはいきなり替え、印は markHit の [data-hit] が持つ）', () => {
    const base = read('./base.css');
    expect(base).not.toContain('data-glide');
    expect(block(base, '[data-hit]')).toMatch(/animation: hit var\(--dur-flash\)/);
  });
  it('選んだタブとページの塗りは、1 コマ置いてから位置と大きさを --dur で滑らせる', () => {
    const rows = read('./rows.css');
    for (const sel of [".sessions-tabs[data-ready='true'] .sessions-tab-thumb", ".pager-nums[data-ready='true'] .pager-thumb"]) {
      expect(block(rows, sel), sel).toMatch(/left var\(--dur\) var\(--ease-out\)/);
      expect(block(rows, sel), sel).toMatch(/width var\(--dur\) var\(--ease-out\)/);
    }
    // 塗りは敷いた 1 つだけが持ち、選んだボタン自身は地を持たない。
    expect(block(rows, ".sessions-tab[aria-pressed='true']")).not.toMatch(/box-shadow/);
    expect(block(rows, ".pager-btn[aria-current='page']")).not.toMatch(/background: var/);
  });
  it('右下の札の間は gap ではなく札ごとの上の余白で空ける（出る札が余白ごと畳まれ、外れた瞬間に間が跳ばない）', () => {
    const base = read('./base.css');
    expect(block(base, '.toasts')).not.toMatch(/gap:/);
    expect(block(base, '.toast-waiting-list')).not.toMatch(/gap:/);
    expect(block(base, '.toasts > .toast, .toast-waiting-list > .toast')).toMatch(/margin-top: calc\(var\(--u\) \* 2\)/);
  });
});
