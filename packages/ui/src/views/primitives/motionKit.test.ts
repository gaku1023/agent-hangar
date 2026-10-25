import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collapseOut, fadeIn, fadeOut, staggerIn, growIn, liftIn, markHit, motionOn, popOut, resizeFrom, riseIn, risenKeys, shapeNow, slideAway, slideFrom } from './motionKit.ts';
import { beginLayoutMotion, endLayoutMotion, LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './layoutMotion.ts';

/**
 * トークンの値。jsdom は tokens.css を読まず、カスタムプロパティを子へ継がせもしないので、
 * 要素を問わず getComputedStyle がこの値を返すようにする（本番は :root から継ぐので、どの要素から読んでも同じ値になる）。
 */
let values: Record<string, string> = {};
const tokens = (dur: string) => {
  values = { '--dur': dur, '--dur-fast': dur, '--dur-exit': dur, '--dur-swap': '150ms', '--stagger': '30ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' };
};
const fakeAnimate = () => {
  const calls: { frames: Keyframe[]; opts: KeyframeAnimationOptions }[] = [];
  const fn = vi.fn((frames: Keyframe[], opts: KeyframeAnimationOptions) => { calls.push({ frames, opts }); return { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation; });
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = fn;
  return calls;
};
/** 終わりと取り消しを試験から決められる animate。呼ばれた順に並ぶ。 */
const controlledAnimate = () => {
  const made: { frames: Keyframe[]; resolve: () => void; reject: () => void }[] = [];
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = (frames: Keyframe[]) => {
    let resolve!: () => void; let reject!: () => void;
    const finished = new Promise<void>((res, rej) => { resolve = res; reject = () => rej(new DOMException('cancelled', 'AbortError')); });
    made.push({ frames, resolve, reject });
    return { finished, cancel: vi.fn() };
  };
  return made;
};
/** 終わりや取り消しを起こし、その後始末（Promise の続き）が走り終えるのを待つ。 */
const settle = async (fn: () => void) => { fn(); for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeEach(() => {
  values = {};
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ getPropertyValue: (n: string) => values[n] ?? '' }) as CSSStyleDeclaration);
});
afterEach(() => { vi.restoreAllMocks(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

describe('motionKit', () => {
  it('並べて入る形は、riseIn を --stagger ずつ遅らせる。札の入れ替えの薄れは --dur-swap で、最後の形を残す', async () => {
    tokens('420ms');
    const calls = fakeAnimate();
    const els = [document.createElement('div'), document.createElement('div'), document.createElement('div')];
    staggerIn(els);
    expect(calls.map((c) => c.opts.delay)).toEqual([0, 30, 60]);
    expect(calls.every((c) => c.opts.duration === 420 && c.opts.fill === 'backwards')).toBe(true);
    await fadeOut(els[0]!, '--dur-swap');
    expect(calls[3]!.opts).toMatchObject({ duration: 150, easing: 'ease-in', fill: 'forwards' });
  });
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
  it('持ち上がる形は、4px 下から薄れを晴らし、--dur-fast と --ease-out で動く。長さ 0 では動かさない', () => {
    values = { '--dur': '420ms', '--dur-fast': '200ms', '--ease-out': 'ease-out' };
    const calls = fakeAnimate();
    liftIn(document.createElement('div'));
    expect(calls[0]!.frames).toEqual([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }]);
    expect(calls[0]!.opts).toMatchObject({ duration: 200, easing: 'ease-out' });
    tokens('0ms');
    expect(liftIn(document.createElement('div'))).toBeNull();
    expect(calls).toHaveLength(1);
  });
  it('畳んで出る形は --dur-exit と --dur-fast の和で、--ease-in で、最後の形を残す', async () => {
    tokens('100ms');
    const calls = fakeAnimate();
    await collapseOut(document.createElement('div'));
    expect(calls[0]!.opts).toMatchObject({ duration: 200, easing: 'ease-in', fill: 'forwards' });
    expect(calls[0]!.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
  });
  it('ダイアログを引っ込める形は、背景を薄れさせ、板を少し縮める。--dur-exit と --ease-in で、最後の形を残す', async () => {
    tokens('100ms');
    const calls = fakeAnimate();
    const overlay = document.createElement('div');
    overlay.innerHTML = '<div class="dialog"></div>';
    await popOut(overlay);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(calls[1]!.frames.at(-1)).toMatchObject({ transform: 'translateY(4px) scale(0.96)' });
    for (const c of calls) expect(c.opts).toMatchObject({ duration: 100, easing: 'ease-in', fill: 'forwards' });
  });
  it('ダイアログを引っ込める形は、動かない環境ではすぐ解決し、取り消されても解決する', async () => {
    tokens('100ms');
    const overlay = document.createElement('div');
    await expect(popOut(overlay)).resolves.toBeUndefined();
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = () => ({ finished: Promise.reject(new DOMException('cancelled', 'AbortError')), cancel: vi.fn() });
    await expect(popOut(overlay)).resolves.toBeUndefined();
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
  it('伸びるだけの箱は、伸びる間だけはみ出しを隠し、終わったら元の指定に戻す', async () => {
    tokens('100ms');
    const ctl = controlledAnimate();
    const el = document.createElement('div');
    el.style.overflow = 'auto';
    growIn(el);
    expect(el.style.overflow).toBe('hidden');
    await settle(() => ctl[0]!.resolve());
    expect(el.style.overflow).toBe('auto');
  });
  // 畳み終えて隠したまま置いた箱（FoldBox の keep、ホームの引き出し）を開き直したとき。畳んだときの hidden を元の指定と取り違えない。
  it('畳み終えた箱を伸ばすと、伸び終わりで畳む前の指定に戻す', async () => {
    tokens('100ms');
    const ctl = controlledAnimate();
    const el = document.createElement('div');
    el.style.overflow = 'auto';
    const closed = collapseOut(el);
    await settle(() => ctl[0]!.resolve());
    await closed;
    expect(el.style.overflow).toBe('hidden');
    growIn(el);
    expect(el.style.overflow).toBe('hidden');
    await settle(() => ctl[1]!.resolve());
    expect(el.style.overflow).toBe('auto');
  });
  // 畳む途中で開き直したとき。取り消した畳みの後始末は非同期に遅れて届くので、伸びている最中の hidden を外さない。
  it('畳む途中で取り消した後始末が伸びる途中に届いても、伸び終わるまで hidden のまま。終わったら元の指定に戻す', async () => {
    tokens('100ms');
    const ctl = controlledAnimate();
    const el = document.createElement('div');
    el.style.overflow = 'auto';
    void collapseOut(el);
    growIn(el);
    await settle(() => ctl[0]!.reject());
    expect(el.style.overflow).toBe('hidden');
    await settle(() => ctl[1]!.resolve());
    expect(el.style.overflow).toBe('auto');
  });
  it('伸びる途中で畳み始めたら、伸びの後始末は畳みの hidden を外さない', async () => {
    tokens('100ms');
    const ctl = controlledAnimate();
    const el = document.createElement('div');
    growIn(el);
    void collapseOut(el);
    await settle(() => ctl[0]!.resolve());
    expect(el.style.overflow).toBe('hidden');
  });
  it('動かない環境で伸ばすときは、畳んで残した hidden を元の指定に戻す', async () => {
    tokens('100ms');
    const ctl = controlledAnimate();
    const el = document.createElement('div');
    el.style.overflow = 'auto';
    const closed = collapseOut(el);
    await settle(() => ctl[0]!.resolve());
    await closed;
    tokens('0ms');
    expect(growIn(el)).toBeNull();
    expect(el.style.overflow).toBe('auto');
  });
  it('伸びる形に今の形（shapeNow）を渡すと、0 からでなくその形から伸ばす。途中からなのでぼかしは掛けない', () => {
    tokens('100ms');
    values = { ...values, opacity: '0.5', 'padding-top': '3px', 'padding-bottom': '0px', 'margin-top': '0px', 'margin-bottom': '0px' };
    const calls = fakeAnimate();
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
    const now = shapeNow(el);
    expect(now).toEqual({ height: '30px', opacity: '0.5', paddingTop: '3px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' });
    growIn(el, 'y', now);
    expect(calls[0]!.frames[0]).toEqual(now);
    for (const f of calls[0]!.frames) expect(String(f.filter ?? 'none')).toBe('none');
    expect(calls[0]!.frames.at(-1)).toMatchObject({ opacity: 1 });
  });
  it('伸びて入る形は、その向きの余白（padding と margin）も 0 から今の値へ伸ばす', () => {
    tokens('100ms');
    values = { ...values, 'padding-top': '8px', 'padding-bottom': '4px', 'margin-top': '2px', 'padding-left': '9px' };
    const calls = fakeAnimate();
    growIn(document.createElement('div'));
    expect(calls[0]!.frames[0]).toMatchObject({ height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' });
    expect(calls[0]!.frames.at(-1)).toMatchObject({ paddingTop: '8px', paddingBottom: '4px', marginTop: '2px', marginBottom: '0px' });
    // 縦に伸ばすときは、横の余白には触れない。
    expect(calls[0]!.frames[0]).not.toHaveProperty('paddingLeft');
    growIn(document.createElement('div'), 'x');
    expect(calls[1]!.frames[0]).toMatchObject({ width: '0px', paddingLeft: '0px', paddingRight: '0px', marginLeft: '0px', marginRight: '0px' });
    expect(calls[1]!.frames.at(-1)).toMatchObject({ paddingLeft: '9px', paddingRight: '0px' });
    expect(calls[1]!.frames[0]).not.toHaveProperty('paddingTop');
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
  it('薄れから現す形は、長さのトークンを選べる（既定は --dur）', () => {
    tokens('420ms');
    values = { ...values, '--dur-fast': '200ms' };
    const calls = fakeAnimate();
    fadeIn(document.createElement('div'));
    fadeIn(document.createElement('div'), '--dur-fast');
    expect(calls[0]!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(calls.map((c) => c.opts.duration)).toEqual([420, 200]);
  });
  it('薄れて消える形は --dur-fast と --ease-in で、最後の形を残す。動かないときはすぐ解決する', async () => {
    tokens('0ms');
    const none = fakeAnimate();
    await expect(fadeOut(document.createElement('div'))).resolves.toBeUndefined();
    expect(none).toHaveLength(0);
    tokens('420ms');
    values = { ...values, '--dur-fast': '200ms' };
    const calls = fakeAnimate();
    await fadeOut(document.createElement('div'));
    expect(calls[0]!.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(calls[0]!.opts).toMatchObject({ duration: 200, easing: 'ease-in', fill: 'forwards' });
  });
  it('高さの補間は、前の高さから今の高さへ --dur で動かし、同じ高さなら動かさない', () => {
    tokens('420ms');
    const calls = fakeAnimate();
    const el = document.createElement('div');
    Object.defineProperty(el, 'offsetHeight', { value: 44, configurable: true });
    expect(resizeFrom(el, 44)).toBeNull();
    resizeFrom(el, 120);
    expect(calls[0]!.frames).toEqual([{ height: '120px' }, { height: '44px' }]);
    expect(calls[0]!.opts).toMatchObject({ duration: 420, easing: 'ease-out' });
    tokens('0ms');
    expect(resizeFrom(el, 120)).toBeNull();
  });
  it('横の補間は、幅を前の幅から今の幅へ動かす（新しいセッションのエージェントの札）', () => {
    tokens('420ms');
    const calls = fakeAnimate();
    const el = document.createElement('button');
    Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => 96 });
    expect(resizeFrom(el, 96, 'x')).toBeNull();
    resizeFrom(el, 130, 'x');
    expect(calls[0]!.frames).toEqual([{ width: '130px' }, { width: '96px' }]);
  });
  it('高さだけを畳む形は、不透明度に触れない（先に薄れた札を、もう一度見せない）', async () => {
    tokens('100ms');
    const calls = fakeAnimate();
    await collapseOut(document.createElement('div'), 'y', { fade: false });
    for (const f of calls[0]!.frames) expect(f).not.toHaveProperty('opacity');
    expect(calls[0]!.frames.at(-1)).toMatchObject({ height: '0px' });
  });
  it('横へ抜ける形は、--dur-exit と --ease-in で、薄れながら dx だけ動き、最後の形を残す', async () => {
    tokens('100ms');
    values = { ...values, '--dur-exit': '250ms' };
    const calls = fakeAnimate();
    await slideAway(document.createElement('div'), 28);
    expect(calls[0]!.frames).toEqual([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(28px)' }]);
    expect(calls[0]!.opts).toMatchObject({ duration: 250, easing: 'ease-in', fill: 'forwards' });
    tokens('0ms');
    await expect(slideAway(document.createElement('div'), 28)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    // 取り消されたら偽で解決し、呼び手に続きの畳みを始めさせない。
    tokens('100ms');
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = () => ({ finished: Promise.reject(new DOMException('cancelled', 'AbortError')), cancel: vi.fn() });
    await expect(slideAway(document.createElement('div'), 28)).resolves.toBe(false);
  });
  it('上がった行は、前と今の両方にある行の互いの順で前へ出た行だけ。足した行、消えた行、押し下げられた行は数えない', () => {
    expect([...risenKeys(['a', 'b', 'c', 'd'], ['n', 'c', 'a', 'b', 'd'])]).toEqual(['c']);
    expect([...risenKeys(['a', 'b', 'c'], ['a', 'c'])]).toEqual([]);
    expect([...risenKeys(['a', 'b'], ['b', 'a'])]).toEqual(['b']);
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
