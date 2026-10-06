import { describe, expect, it } from 'vitest';
import { createGlide, easeFn } from './glide.ts';

describe('easeFn', () => {
  it('cubic-bezier を 0 で 0、1 で 1 の、増えるだけの関数にする', () => {
    const f = easeFn('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    let prev = 0;
    for (let t = 0.05; t < 1; t += 0.05) {
      const v = f(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // 出だしの速い曲線なので、半分の時間でほぼ寄り切っている。
    expect(f(0.5)).toBeGreaterThan(0.9);
  });
  it('linear と読めない曲線は、そのままの進み具合にする', () => {
    expect(easeFn('linear')(0.3)).toBeCloseTo(0.3);
    expect(easeFn('')(0.3)).toBeCloseTo(0.3);
  });
});

/** 1 フレームずつ手で進める時計。 */
function clock() {
  let t = 0;
  let queue: (() => void)[] = [];
  return {
    now: () => t,
    frame: (cb: () => void) => { queue.push(cb); return queue.length; },
    cancel: () => { queue = []; },
    tick(ms: number) { t += ms; const q = queue; queue = []; for (const cb of q) cb(); },
    pending: () => queue.length,
  };
}

/** 寸法を差し替えられる器。 */
function box(scrollHeight: number, clientHeight = 200) {
  const el = document.createElement('div');
  let top = 0;
  let h = scrollHeight;
  Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.min(Math.max(v, 0), h - clientHeight); }, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => h, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  return { el, grow: (to: number) => { h = to; } };
}

const timing = { ms: 400, ease: (t: number) => t };

describe('createGlide', () => {
  it('フレームごとに下端へ寄せ、長さの分だけ進んだら止まる', () => {
    const c = clock();
    const { el } = box(1200);
    const g = createGlide(el, { frame: c.frame, cancel: c.cancel, now: c.now, timing: () => timing });
    g.toBottom();
    c.tick(100);
    expect(el.scrollTop).toBe(250);
    c.tick(300);
    expect(el.scrollTop).toBe(1000);
    expect(c.pending()).toBe(0);
  });
  it('寄せる途中で中身が伸びたら、伸びた後の下端まで寄せる', () => {
    // 行の高さを測り直すと、下端は動いている間にも伸びる。最初の下端で止まると末尾を外す。
    const c = clock();
    const b = box(1200);
    const g = createGlide(b.el, { frame: c.frame, cancel: c.cancel, now: c.now, timing: () => timing });
    g.toBottom();
    c.tick(200);
    b.grow(3200);
    c.tick(200);
    expect(b.el.scrollTop).toBe(3000);
  });
  it('stop の後は動かさない。跳ぶ側が先に止めてから書き換える', () => {
    const c = clock();
    const { el } = box(1200);
    const g = createGlide(el, { frame: c.frame, cancel: c.cancel, now: c.now, timing: () => timing });
    g.toBottom();
    c.tick(100);
    g.stop();
    el.scrollTop = 900;
    c.tick(300);
    expect(el.scrollTop).toBe(900);
  });
  it('寄せている間に利用者が上へ戻したら、それ以上は動かさない', () => {
    const c = clock();
    const { el } = box(1200);
    const g = createGlide(el, { frame: c.frame, cancel: c.cancel, now: c.now, timing: () => timing });
    g.toBottom();
    c.tick(100);
    el.scrollTop = 50;
    c.tick(100);
    expect(el.scrollTop).toBe(50);
    expect(c.pending()).toBe(0);
  });
  it('長さが 0（reduced motion）なら、その場で下端へ跳ぶ', () => {
    const c = clock();
    const { el } = box(1200);
    const g = createGlide(el, { frame: c.frame, cancel: c.cancel, now: c.now, timing: () => ({ ms: 0, ease: timing.ease }) });
    g.toBottom();
    expect(el.scrollTop).toBe(1000);
    expect(c.pending()).toBe(0);
  });
});
