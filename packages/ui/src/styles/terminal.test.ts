import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 入れ子の無い規則を、選択子と中身の組で取り出す。最初に見つかったもの（@media の外）を返す。 */
const body = (css: string, selector: string) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === selector)?.[2] ?? '';
const base = read('base.css');

describe('端末の縁の灯', () => {
  it('作業中は杏の輪と光で、--breathe-period でゆっくり明暗を往復する', () => {
    const b = body(base, ".term-pane[data-live='busy']");
    expect(b).toContain('var(--busy)');
    expect(b).toMatch(/animation: rim-breathe var\(--breathe-period\) ease-in-out infinite;/);
  });
  it('入力待ちは赤の輪と光で、動かない', () => {
    const b = body(base, ".term-pane[data-live='waiting']");
    expect(b).toContain('var(--waiting)');
    expect(b).not.toContain('animation');
  });
  it('休みと終了は灯さず、板を持ち上げる影だけにする', () => {
    expect(body(base, ".term-pane[data-live='idle']")).toBe('');
    expect(body(base, ".term-pane[data-live='ended']")).toBe('');
    expect(body(base, '.term-pane')).toMatch(/box-shadow: var\(--term-lift\);/);
  });
  it('状態が変わると、縁の色が --dur で移る', () => {
    expect(body(base, '.term-pane')).toMatch(/transition: box-shadow var\(--dur\) var\(--ease-out\);/);
  });
  it('reduced motion では往復を止め、静止した輪だけを残す', () => {
    expect(strip(base)).toContain("@media (prefers-reduced-motion: reduce) { .term-pane[data-live='busy'] { animation: none; } }");
  });
  // 分割の枠が外側の光を切ると、左右の板の縁だけ光が欠ける。はみ出す中身は板（.term-pane）が自分で切っている。
  it('分割しても、板の外側の光を切らない', () => {
    expect(body(read('split.css'), '.split-pane')).toMatch(/overflow: visible;/);
  });
});

describe('フォルダの耳のタブ', () => {
  it('タブは上の角だけを丸めた耳で、帯と板の間に線も隙間も置かない', () => {
    expect(body(base, '.tab')).toMatch(/border-radius: var\(--r\) var\(--r\) 0 0;/);
    expect(body(base, '.tabs')).not.toMatch(/border-bottom|margin-bottom/);
  });
  it('選んだタブは板と同じ墨色になる', () => {
    const b = body(base, '.tab-selected, .tab-selected:hover');
    expect(b).toContain('background: var(--term-bg);');
    expect(b).toContain('color: var(--term-fg);');
  });
  it('耳の下の板は、左上だけを角張らせて耳とつなぐ。分割しているときは左の板をつなぐ', () => {
    expect(body(base, '.tabs + .split > .term-pane, .tabs + .split > .split-h > .split-pane:first-child > .term-pane')).toMatch(/border-top-left-radius: 0;/);
  });
});
