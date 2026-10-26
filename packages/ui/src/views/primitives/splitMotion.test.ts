import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_MOVING_ATTR } from './layoutMotion.ts';
import { afterHeavyFrames, collapseHead, flashPane, flipFrom, flyName, growFrom, holdLayout, landGhost, leavePane, nameSnap, paneEnter, previewIn, retitle, riseParts, settleEntrance, settleTop } from './splitMotion.ts';

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
    expect(growFrom(el, rect, { ...rect, width: 300 })).toBeNull();
    expect(paneEnter(el)).toBeNull();
    expect(flashPane(el)).toBeNull();
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

  it('広がるときは、中身を伸ばさず、元の左上へ位置だけ戻し、元の大きさに切り抜いてから今の形へ', () => {
    const el = div();
    const to = { left: 0, top: 20, width: 300, height: 100 };
    expect(growFrom(el, to, to)).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    expect(growFrom(el, { left: 150, top: 20, width: 150, height: 60 }, to)).not.toBeNull();
    const frames = animate.mock.calls[0]![0] as Keyframe[];
    expect(frames[0]).toEqual({ transform: 'translate(150px, 0px)', clipPath: 'inset(0px 150px 40px 0px)' });
    expect(frames[1]).toEqual({ transform: 'none', clipPath: 'inset(0px 0px 0px 0px)' });
    expect(frames.some((f) => String(f.transform).includes('scale'))).toBe(false);
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
    // 薄れるだけ。ぼかしと縮みは、大きな面を毎こま描き直すので使わない。長さは --dur-exit、出だしの速い曲線。
    expect(animate.mock.calls[0]![0]).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(animate.mock.calls[0]![1]).toMatchObject({ duration: 420, easing: 'ease-out' });
    const head = document.createElement('div');
    await collapseHead(head, rect);
    expect(head.isConnected).toBe(false);
    expect((animate.mock.calls[1]![0] as Keyframe[]).at(-1)).toMatchObject({ height: '0px' });
  });

  describe('画面の入場（CSS の enter）', () => {
    type Css = { animationName: string; effect: { target: Element }; finish: ReturnType<typeof vi.fn> };
    const css = (animationName: string, target: Element): Css => ({ animationName, effect: { target }, finish: vi.fn() });
    const withAnims = (el: Element, list: Css[]) => { (el as unknown as { getAnimations: () => Css[] }).getAnimations = () => list; };

    it('settleEntrance は、中の画面（.screen）の enter だけを終わらせる。ほかの CSS の動きには触れない', () => {
      const host = div();
      const screen = host.appendChild(document.createElement('div'));
      screen.className = 'screen';
      const other = host.appendChild(document.createElement('div'));
      const enter = css('enter', screen);
      const breathe = css('rim-breathe', screen);
      const notScreen = css('enter', other);
      withAnims(host, [enter, breathe, notScreen]);
      settleEntrance(host);
      expect(enter.finish).toHaveBeenCalled();
      expect(breathe.finish).not.toHaveBeenCalled();
      expect(notScreen.finish).not.toHaveBeenCalled();
    });

    it('閉じるペインを差し戻すと中の画面の enter が頭からやり直すので、すぐ終わらせる（不透明度 0 の白い箱にしない）', () => {
      const pane = document.createElement('div');
      const screen = pane.appendChild(document.createElement('div'));
      screen.className = 'screen';
      const enter = css('enter', screen);
      withAnims(pane, [enter]);
      void leavePane(pane, rect, div());
      expect(enter.finish).toHaveBeenCalled();
    });

    it('getAnimations の無い環境でも落ちない', () => {
      expect(() => settleEntrance(div())).not.toThrow();
    });
  });

  it('残るものの手前に敷くと、閉じるペインは残るものの下に重なる（前へ出さない）', () => {
    const host = div();
    const keep = host.appendChild(document.createElement('div'));
    const pane = document.createElement('div');
    void leavePane(pane, rect, keep);
    expect(pane.nextElementSibling).toBe(keep);
    expect(pane.style.position).toBe('fixed');
    expect(pane.style.zIndex).toBe('');
    expect(pane.getAttribute('inert')).toBe('');
  });

  it('閉じるペインの要素がまだ文書にある（ほかのペインの描画に使い回された）ときは、動かさず外さない', async () => {
    const host = div();
    const pane = host.appendChild(document.createElement('div'));
    await leavePane(pane, rect);
    expect(pane.parentElement).toBe(host);
    expect(pane.getAttribute('style')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  describe('afterHeavyFrames（描き替えの重いこまが過ぎてから動かす）', () => {
    type Fake = { pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; playState: string };
    const fake = (): Fake => ({ pause: vi.fn(), play: vi.fn(), playState: 'running' });
    let frames: FrameRequestCallback[] = [];
    let anims: Fake[] = [];
    const tick = (at: number) => { const f = frames; frames = []; for (const cb of f) cb(at); };
    beforeEach(() => {
      frames = [];
      anims = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
      (document as unknown as { getAnimations: () => Fake[] }).getAnimations = () => anims;
    });
    afterEach(() => { delete (document as unknown as { getAnimations?: unknown }).getAnimations; });

    it('中で作られた動きだけを止めておき、こまの間隔が戻ったら動かす。前からある動きには触れない', () => {
      const old = fake();
      anims.push(old);
      const made = fake();
      afterHeavyFrames(() => { anims.push(made); });
      expect(made.pause).toHaveBeenCalled();
      expect(old.pause).not.toHaveBeenCalled();
      tick(0);
      tick(70);
      tick(120);
      expect(made.play).not.toHaveBeenCalled();
      tick(136);
      expect(made.play).toHaveBeenCalledTimes(1);
      expect(old.play).not.toHaveBeenCalled();
      expect(frames).toHaveLength(0);
    });

    it('中で終わらせた動き（画面の入場など）は止めない。止めると、動かすときに頭からやり直す', () => {
      const done: Fake = { ...fake(), playState: 'finished' };
      const live = fake();
      afterHeavyFrames(() => { anims.push(done, live); });
      expect(done.pause).not.toHaveBeenCalled();
      expect(live.pause).toHaveBeenCalled();
    });

    it('重いこまが続いても、長く待たせない', () => {
      const made = fake();
      afterHeavyFrames(() => { anims.push(made); });
      for (let t = 0; t <= 400 && made.play.mock.calls.length === 0; t += 60) tick(t);
      expect(made.play).toHaveBeenCalledTimes(1);
    });

    it('名前の札も、動き出すまで飛ばない', () => {
      const target = div();
      afterHeavyFrames(() => { flyName({ text: '名前', rect, font: 15 }, target); });
      expect(frames).toHaveLength(1);
    });

    it('動きを減らす設定や getAnimations の無い環境では、そのまま呼ぶだけ', () => {
      delete (document as unknown as { getAnimations?: unknown }).getAnimations;
      const run = vi.fn();
      afterHeavyFrames(run);
      expect(run).toHaveBeenCalledTimes(1);
      expect(frames).toHaveLength(0);
    });
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
