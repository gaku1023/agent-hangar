import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../test/motion.ts';
import { measureRows, pinFlight, slideRows } from './pinSlide.ts';

type Done = { finish: () => void };

/** 位置を決めた行を 1 つ作る。 */
function rowAt(parent: HTMLElement, id: string, top: number, height = 30): HTMLElement {
  const a = document.createElement('a');
  a.className = 'side-live-row';
  a.dataset.id = id;
  a.getBoundingClientRect = () => ({ left: 10, top, right: 210, bottom: top + height, width: 200, height, x: 10, y: top, toJSON: () => ({}) });
  parent.append(a);
  return a;
}

/** el.animate の呼び出しを覚え、finished を試験から解決できるようにする。 */
function fakeAnimate() {
  const calls: { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions; done: Done }[] = [];
  const animate = vi.fn(function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    let resolve: () => void = () => {};
    const finished = new Promise<void>((r) => { resolve = r; });
    calls.push({ el: this, frames, opts, done: { finish: resolve } });
    return { finished, finish: resolve, cancel: resolve } as unknown as Animation;
  });
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
  return calls;
}

let restore = () => {};
afterEach(() => {
  restore();
  document.body.innerHTML = '';
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  pinFlight.instant = false;
});

describe('ピン留めの「滑って移る」', () => {
  it('動いた行は、複製が元の場所から行き先まで飛ぶ。飛ぶ間は本物を隠し、終わったら戻す', async () => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    const calls = fakeAnimate();
    const section = document.createElement('section');
    document.body.append(section);
    const a = rowAt(section, 'a', 300);
    const before = measureRows(section);
    a.getBoundingClientRect = () => ({ left: 10, top: 100, right: 210, bottom: 130, width: 200, height: 30, x: 10, y: 100, toJSON: () => ({}) });
    slideRows(section, before, ['a']);
    const flight = document.querySelector<HTMLElement>('body > .side-live-row[data-flight]')!;
    expect(flight).not.toBeNull();
    expect(a.style.visibility).toBe('hidden');
    const c = calls.find((x) => x.el === flight)!;
    expect(c.frames[0]!.transform).toContain('translate(0px, 200px)');
    expect(c.opts.duration).toBe(420);
    c.done.finish();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('[data-flight]')).toBeNull();
    expect(a.style.visibility).toBe('');
  });
  it('残った行は前の位置から滑り、動かなかった行は動かさない', () => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    const calls = fakeAnimate();
    const section = document.createElement('section');
    document.body.append(section);
    const b = rowAt(section, 'b', 200);
    const c = rowAt(section, 'c', 400);
    const before = measureRows(section);
    b.getBoundingClientRect = () => ({ left: 10, top: 230, right: 210, bottom: 260, width: 200, height: 30, x: 10, y: 230, toJSON: () => ({}) });
    slideRows(section, before, []);
    expect(calls.filter((x) => x.el === b)).toHaveLength(1);
    expect(calls.filter((x) => x.el === c)).toHaveLength(0);
  });
  it('行き先が畳んだグループの中（高さ 0）なら、元の場所で薄れて消え、本物は隠さない', () => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    const calls = fakeAnimate();
    const section = document.createElement('section');
    document.body.append(section);
    const a = rowAt(section, 'a', 300);
    const before = measureRows(section);
    a.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    slideRows(section, before, ['a']);
    const flight = document.querySelector<HTMLElement>('[data-flight]')!;
    expect(a.style.visibility).toBe('');
    expect(calls.find((x) => x.el === flight)!.frames.at(-1)!.opacity).toBe(0);
  });
  it('動かない環境では何も作らない', () => {
    const section = document.createElement('section');
    document.body.append(section);
    rowAt(section, 'a', 300);
    const before = measureRows(section);
    slideRows(section, before, ['a']);
    expect(document.querySelector('[data-flight]')).toBeNull();
  });
});
