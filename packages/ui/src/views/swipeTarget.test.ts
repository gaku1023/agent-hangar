import { afterEach, describe, expect, it } from 'vitest';
import { blocksSwipe } from './swipeTarget.ts';

/** jsdom は組版をしないので、箱の寸法は自分で置く。 */
function box(opts: { overflowX: string; scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  const el = document.createElement('div');
  el.style.overflowX = opts.overflowX;
  Object.defineProperty(el, 'scrollWidth', { value: opts.scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: opts.clientWidth, configurable: true });
  Object.defineProperty(el, 'scrollLeft', { value: opts.scrollLeft ?? 0, writable: true, configurable: true });
  document.body.appendChild(el);
  const child = document.createElement('span');
  el.appendChild(child);
  return child;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('スワイプを箱に譲るか', () => {
  it('ふつうの要素の上では譲らない', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(blocksSwipe(el, -30)).toBe(false);
  });

  it('要素でないもの（window など）が来ても落ちない', () => {
    expect(blocksSwipe(window, -30)).toBe(false);
    expect(blocksSwipe(null, -30)).toBe(false);
  });

  it('はみ出していても横に流せない箱には譲らない', () => {
    const child = box({ overflowX: 'visible', scrollWidth: 600, clientWidth: 200 });
    expect(blocksSwipe(child, -30)).toBe(false);
  });

  it('数 px のはみ出しは組版の綾なので譲らない', () => {
    // .main のように overflow: auto の器はどの画面にもある。ここで譲ると画面中でスワイプが死ぬ。
    const child = box({ overflowX: 'auto', scrollWidth: 604, clientWidth: 600, scrollLeft: 2 });
    expect(blocksSwipe(child, -30)).toBe(false);
    expect(blocksSwipe(child, 30)).toBe(false);
  });

  it('横に流せて、その向きにまだ余地があるなら譲る', () => {
    const child = box({ overflowX: 'auto', scrollWidth: 600, clientWidth: 200, scrollLeft: 100 });
    expect(blocksSwipe(child, -30)).toBe(true);
    expect(blocksSwipe(child, 30)).toBe(true);
  });

  it('その向きの端まで来ていれば譲らない', () => {
    const left = box({ overflowX: 'auto', scrollWidth: 600, clientWidth: 200, scrollLeft: 0 });
    expect(blocksSwipe(left, -30)).toBe(false);
    const right = box({ overflowX: 'scroll', scrollWidth: 600, clientWidth: 200, scrollLeft: 400 });
    expect(blocksSwipe(right, 30)).toBe(false);
  });

  it('身の丈に収まっている箱には譲らない', () => {
    const child = box({ overflowX: 'auto', scrollWidth: 200, clientWidth: 200 });
    expect(blocksSwipe(child, -30)).toBe(false);
  });
});
