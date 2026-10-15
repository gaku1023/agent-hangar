// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { wrapComposition } from './compositionWrap.ts';

/**
 * xterm.js 6 の要素の並びをまねた偽物。
 * 変換が進むと、xterm は composition-view の textContent を差し替え、left と top と height をカーソルの位置に置く（CompositionHelper.updateCompositionElements）。
 * ここでも同じことを textarea の composition の知らせで行う。
 */
function fakeXterm(screenWidth: number, cursorLeft: number) {
  const root = document.createElement('div');
  root.className = 'xterm';
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  Object.defineProperty(screen, 'offsetWidth', { get: () => screenWidth });
  const helpers = document.createElement('div');
  helpers.className = 'xterm-helpers';
  const textarea = document.createElement('textarea');
  const view = document.createElement('div');
  view.className = 'composition-view';
  helpers.append(textarea, view);
  root.append(screen, helpers);
  document.body.append(root);
  textarea.addEventListener('compositionstart', () => { view.textContent = ''; view.classList.add('active'); });
  textarea.addEventListener('compositionupdate', (e) => {
    view.textContent = (e as CompositionEvent).data;
    view.style.left = `${cursorLeft}px`;
    view.style.top = '36px';
    view.style.height = '18px';
    view.style.lineHeight = '18px';
  });
  const compose = (data: string) => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data }));
  };
  return { root, view, compose };
}

/** MutationObserver の知らせは microtask で届く。 */
const flush = () => new Promise<void>((r) => { setTimeout(r, 0); });
const px = (v: string) => parseFloat(v);

afterEach(() => { document.body.innerHTML = ''; });

describe('wrapComposition（変換中の文字をターミナルの右端で折り返す）', () => {
  it('箱の幅をターミナルの幅に合わせ、左端まで戻し、1 行目だけカーソルの位置まで字下げする', async () => {
    const x = fakeXterm(640, 200);
    wrapComposition(x.root);
    x.compose('きょうはとてもいいてんきなのでさんぽにいこうとおもっています');
    await flush();
    // xterm が置いた left はそのまま使う。
    expect(x.view.style.left).toBe('200px');
    expect(px(x.view.style.width)).toBe(640);
    expect(px(x.view.style.marginLeft)).toBe(-200);
    expect(px(x.view.style.textIndent)).toBe(200);
    // 箱の右端（left＋margin＋width）がターミナルの右端を超えない。
    expect(px(x.view.style.left) + px(x.view.style.marginLeft) + px(x.view.style.width)).toBeLessThanOrEqual(640);
  });
  it('文字は 1 つの span に入れ、xterm が差し替えるたびに入れ直す。文字そのものは変えない', async () => {
    const x = fakeXterm(640, 80);
    wrapComposition(x.root);
    x.compose('かんじ');
    await flush();
    expect(x.view.children).toHaveLength(1);
    expect(x.view.firstElementChild).toHaveClass('composition-text');
    expect(x.view.textContent).toBe('かんじ');
    x.compose('かんじへんかん');
    await flush();
    expect(x.view.children).toHaveLength(1);
    expect(x.view.textContent).toBe('かんじへんかん');
  });
  it('カーソルが動けば字下げも追う', async () => {
    let left = 40;
    const x = fakeXterm(500, 0);
    wrapComposition(x.root);
    x.view.ownerDocument.querySelector('textarea')!.addEventListener('compositionupdate', () => { x.view.style.left = `${left}px`; });
    x.compose('あ');
    await flush();
    expect(px(x.view.style.textIndent)).toBe(40);
    left = 120;
    x.compose('あい');
    await flush();
    expect(px(x.view.style.textIndent)).toBe(120);
    expect(px(x.view.style.marginLeft)).toBe(-120);
  });
  it('止めた後は手を出さない', async () => {
    const x = fakeXterm(640, 200);
    const stop = wrapComposition(x.root);
    stop();
    x.compose('あいう');
    await flush();
    expect(x.view.style.width).toBe('');
    expect(x.view.firstElementChild).toBeNull();
  });
  it('composition-view が無ければ何もしない', () => {
    const root = document.createElement('div');
    expect(() => wrapComposition(root)()).not.toThrow();
  });
});
