import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_MOVING_ATTR } from './layoutMotion.ts';
import { collapseHead, flashPane, flipFrom, flyName, holdLayout, landGhost, leavePane, nameSnap, paneEnter, popBadge, previewIn, retitle, riseParts, settleTop } from './splitMotion.ts';

/** jsdom は tokens.css を読まないので、どの要素から読んでもこの値が返るようにする（motionKit.test.ts と同じ）。 */
let values: Record<string, string> = {};
const tokens = (dur: string) => {
  values = { '--dur': dur, '--dur-fast': dur, '--dur-exit': dur, '--dur-swap': '150ms', '--stagger': dur === '0ms' ? '0ms' : '30ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' };
};
const animate = vi.fn();
const fakeAnimate = () => {
  animate.mockImplementation((frames: Keyframe[], opts: KeyframeAnimationOptions) => ({ frames, opts, finished: Promise.resolve(), cancel: vi.fn() }));
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
};
const rect = { left: 10, top: 20, width: 100, height: 40 };

beforeEach(() => {
  values = {};
  animate.mockReset();
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ getPropertyValue: (n: string) => values[n] ?? '', fontSize: '15px', fontFamily: 'sans' }) as unknown as CSSStyleDeclaration);
});
afterEach(() => { vi.restoreAllMocks(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; document.body.innerHTML = ''; });

const div = () => document.body.appendChild(document.createElement('div'));

describe('splitMotion（動きを減らす設定）', () => {
  it('長さが 0 のとき、どの動きも呼ばれても何もしない（animate も style も触れない）', async () => {
    tokens('0ms');
    fakeAnimate();
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const el = div();
    const before = el.outerHTML;
    const parts = [div(), div()];
    expect(flyName({ text: 'a', rect, font: 15 }, el)).toBeNull();
    expect(riseParts(parts)).toEqual([null, null]);
    expect(flipFrom(el, rect, { ...rect, left: 200 })).toBe(false);
    expect(paneEnter(el)).toBeNull();
    expect(flashPane(el)).toBeNull();
    expect(popBadge(el)).toBeNull();
    expect(previewIn(el)).toBeNull();
    expect(settleTop(el, 40)).toBeNull();
    expect(retitle(el)).toBeNull();
    await expect(landGhost(el, rect, true)).resolves.toBeUndefined();
    await expect(landGhost(el, null, false)).resolves.toBeUndefined();
    await expect(leavePane(el, rect)).resolves.toBeUndefined();
    await expect(collapseHead(el, rect)).resolves.toBeUndefined();
    holdLayout(el, [null]);
    expect(animate).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
    expect(el.outerHTML).toBe(before);
    expect(parts.every((p) => p.getAttribute('style') === null)).toBe(true);
    expect(document.querySelector('.pane-fly')).toBeNull();
    // 外す前の要素を、元の位置に戻して動かさない（body に付け足さない）。
    expect(document.body.children).toHaveLength(3);
  });

  it('Web Animations の無い環境（jsdom）でも何もしない', async () => {
    tokens('420ms');
    const el = div();
    expect(paneEnter(el)).toBeNull();
    expect(flyName({ text: 'a', rect, font: 15 }, el)).toBeNull();
    await expect(leavePane(el, rect)).resolves.toBeUndefined();
    expect(el.hasAttribute('style')).toBe(false);
  });
});

describe('splitMotion（動くとき）', () => {
  beforeEach(() => { tokens('420ms'); fakeAnimate(); });

  it('見出しの部品は --stagger ずつずれ、下からは正、上からは負の移動で出る', () => {
    const els = [div(), div(), div()];
    riseParts(els, { first: 2 });
    expect(animate.mock.calls.map((c) => (c[1] as KeyframeAnimationOptions).delay)).toEqual([60, 90, 120]);
    expect(((animate.mock.calls[0]![0] as Keyframe[])[0]!.transform)).toBe('translateY(4px)');
    animate.mockClear();
    riseParts(els, { dy: -4 });
    expect(((animate.mock.calls[0]![0] as Keyframe[])[0]!.transform)).toBe('translateY(-4px)');
  });

  it('FLIP は、動いたときだけ元の位置から今の位置へ。動かなければ false', () => {
    const el = div();
    expect(flipFrom(el, rect, rect)).toBe(false);
    expect(animate).not.toHaveBeenCalled();
    expect(flipFrom(el, { ...rect, left: 110 }, rect)).toBe(true);
    const frames = animate.mock.calls[0]![0] as Keyframe[];
    expect(frames[0]!.transform).toBe('translate(100px, 0px) scale(1, 1)');
    expect(frames[1]!.transform).toBe('none');
    expect(animate.mock.calls[0]![1]).toMatchObject({ duration: 420, easing: 'ease-out' });
  });

  it('新しいペインはぼかしと縮小から出る。最大化を戻したときは遅れて浅く出る', () => {
    const el = div();
    paneEnter(el);
    expect((animate.mock.calls[0]![0] as Keyframe[])[0]).toMatchObject({ opacity: 0, filter: 'blur(6px)', transform: 'scale(0.985)' });
    paneEnter(el, { delay: 120, light: true });
    expect((animate.mock.calls[1]![0] as Keyframe[])[0]!.transform).toBe('scale(0.99)');
    expect(animate.mock.calls[1]![1]).toMatchObject({ delay: 120 });
  });

  it('ドラッグの札は、落としたなら入る場所の中心へ縮みながら、やめたなら元の行へ戻る', async () => {
    const g = div();
    g.getBoundingClientRect = () => ({ left: 300, top: 200, width: 40, height: 20 }) as DOMRect;
    await landGhost(g, { left: 0, top: 0, width: 200, height: 100 }, true);
    const [frames, opts] = animate.mock.calls[0] as [Keyframe[], KeyframeAnimationOptions];
    expect(frames[1]).toMatchObject({ left: '80px', top: '40px', opacity: 0, transform: 'scale(0.8)' });
    expect(opts).toMatchObject({ duration: 420, easing: 'ease-in', fill: 'forwards' });
    await landGhost(g, { left: 5, top: 6, width: 100, height: 30 }, false);
    const [back, backOpts] = animate.mock.calls[1] as [Keyframe[], KeyframeAnimationOptions];
    expect(back[1]).toMatchObject({ left: '5px', top: '6px', transform: 'scale(1)' });
    expect(backOpts.easing).toBe('ease-out');
  });

  it('動きの間だけ、端末の寸法合わせを止める', async () => {
    const host = div();
    holdLayout(host, [null]);
    expect(host.hasAttribute(LAYOUT_MOVING_ATTR)).toBe(false);
    holdLayout(host, [{ finished: Promise.resolve() } as unknown as Animation]);
    expect(host.hasAttribute(LAYOUT_MOVING_ATTR)).toBe(true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(host.hasAttribute(LAYOUT_MOVING_ATTR)).toBe(false);
  });

  it('閉じるペインは元の位置に置かれて薄れ、終わったら外れる。畳む大きな見出しも同じ', async () => {
    const pane = document.createElement('div');
    await leavePane(pane, rect);
    expect(pane.isConnected).toBe(false);
    expect(animate.mock.calls[0]![0]).toEqual([expect.objectContaining({ opacity: 1 }), expect.objectContaining({ opacity: 0 })]);
    const head = document.createElement('div');
    await collapseHead(head, rect);
    expect(head.isConnected).toBe(false);
    expect((animate.mock.calls[1]![0] as Keyframe[]).at(-1)).toMatchObject({ height: '0px' });
  });

  it('名前の札は見出しの上に作られ、飛ぶ間は行き先を隠す。止めると元に戻る', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    const target = div();
    const stop = flyName({ text: '名前', rect, font: 15 }, target)!;
    expect(document.querySelector('.pane-fly')?.textContent).toBe('名前');
    expect(target.style.visibility).toBe('hidden');
    stop();
    expect(document.querySelector('.pane-fly')).toBeNull();
    expect(target.style.visibility).toBe('');
    expect(nameSnap(target).font).toBe(15);
  });
});
