import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collapseOut, growIn, markHit, motionOn, riseIn, slideFrom } from './motionKit.ts';
import { beginLayoutMotion, endLayoutMotion, LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './layoutMotion.ts';

/**
 * トークンの値。jsdom は tokens.css を読まず、カスタムプロパティを子へ継がせもしないので、
 * 要素を問わず getComputedStyle がこの値を返すようにする（本番は :root から継ぐので、どの要素から読んでも同じ値になる）。
 */
let values: Record<string, string> = {};
const tokens = (dur: string) => {
  values = { '--dur': dur, '--dur-fast': dur, '--dur-exit': dur, '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' };
};
const fakeAnimate = () => {
  const calls: { frames: Keyframe[]; opts: KeyframeAnimationOptions }[] = [];
  const fn = vi.fn((frames: Keyframe[], opts: KeyframeAnimationOptions) => { calls.push({ frames, opts }); return { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation; });
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = fn;
  return calls;
};
beforeEach(() => {
  values = {};
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ getPropertyValue: (n: string) => values[n] ?? '' }) as CSSStyleDeclaration);
});
afterEach(() => { vi.restoreAllMocks(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

describe('motionKit', () => {
  it('Web Animations が無い環境と長さ 0 では動かさない', async () => {
    tokens('420ms');
    const el = document.createElement('div');
    expect(motionOn(el)).toBe(false);
    expect(riseIn(el)).toBeNull();
    await expect(collapseOut(el)).resolves.toBeUndefined();
    fakeAnimate();
    tokens('0ms');
    expect(motionOn(el)).toBe(false);
    expect(growIn(el)).toBeNull();
  });
  it('入る形は、ぼかしを 0.2 で晴らし、--rise だけ浮かぶ', () => {
    tokens('420ms');
    const calls = fakeAnimate();
    riseIn(document.createElement('div'));
    expect(calls[0]!.frames[0]).toMatchObject({ opacity: 0, transform: 'translateY(6px)', filter: 'blur(6px)' });
    expect(calls[0]!.frames[1]).toEqual({ offset: 0.2, filter: 'none' });
    expect(calls[0]!.opts).toMatchObject({ duration: 420, easing: 'ease-out' });
  });
  it('畳んで出る形は --dur-exit と --dur-fast の和で、--ease-in で、最後の形を残す', async () => {
    tokens('100ms');
    const calls = fakeAnimate();
    await collapseOut(document.createElement('div'));
    expect(calls[0]!.opts).toMatchObject({ duration: 200, easing: 'ease-in', fill: 'forwards' });
    expect(calls[0]!.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
  });
  it('畳む途中で取り消されたら、はみ出しの指定を元に戻す。終わったときは隠したままにする', async () => {
    tokens('100ms');
    const el = document.createElement('div');
    el.style.overflow = 'auto';
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = () => ({ finished: Promise.reject(new DOMException('cancelled', 'AbortError')), cancel: vi.fn() });
    await collapseOut(el);
    expect(el.style.overflow).toBe('auto');
    fakeAnimate();
    await collapseOut(el);
    expect(el.style.overflow).toBe('hidden');
  });
  it('横に畳むときは幅を 0 にする', async () => {
    tokens('100ms');
    const calls = fakeAnimate();
    await collapseOut(document.createElement('div'), 'x');
    expect(calls[0]!.frames.at(-1)).toMatchObject({ width: '0px' });
  });
  it('並びの滑りは、動いていなければ何もしない', () => {
    tokens('420ms');
    const calls = fakeAnimate();
    const r = new DOMRect(0, 10, 10, 10);
    expect(slideFrom(document.createElement('div'), r, r)).toBeNull();
    slideFrom(document.createElement('div'), new DOMRect(0, 30, 10, 10), r);
    expect(calls[0]!.frames[0]).toEqual({ transform: 'translate(0px, 20px)' });
  });
  it('光らせる印は、地の動きが終わったら外す', () => {
    const el = document.createElement('div');
    markHit(el);
    expect(el).toHaveAttribute('data-hit');
    el.dispatchEvent(new Event('animationend'));
    expect(el).not.toHaveAttribute('data-hit');
  });
});

describe('layoutMotion', () => {
  it('動いている間は印を付け、止まったら外して知らせる', () => {
    const el = document.createElement('div');
    const settled = vi.fn();
    window.addEventListener(LAYOUT_SETTLED, settled);
    beginLayoutMotion(el);
    expect(el).toHaveAttribute(LAYOUT_MOVING_ATTR);
    endLayoutMotion(el);
    expect(el).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).toHaveBeenCalledTimes(1);
    window.removeEventListener(LAYOUT_SETTLED, settled);
  });
  // 動きが重なっても、最後の 1 つが終わるまで印を残し、止まったことは 1 度だけ知らせる。
  it('重なった動きは数え、最後の 1 つが終わるまで印を残して、そのときに 1 度だけ知らせる', () => {
    const el = document.createElement('div');
    const settled = vi.fn();
    window.addEventListener(LAYOUT_SETTLED, settled);
    beginLayoutMotion(el);
    beginLayoutMotion(el);
    endLayoutMotion(el);
    expect(el).toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).not.toHaveBeenCalled();
    endLayoutMotion(el);
    expect(el).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).toHaveBeenCalledTimes(1);
    // 余分な end は数を負にせず、知らせもしない。
    endLayoutMotion(el);
    expect(settled).toHaveBeenCalledTimes(1);
    beginLayoutMotion(el);
    expect(el).toHaveAttribute(LAYOUT_MOVING_ATTR);
    endLayoutMotion(el);
    expect(el).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    window.removeEventListener(LAYOUT_SETTLED, settled);
  });
});
