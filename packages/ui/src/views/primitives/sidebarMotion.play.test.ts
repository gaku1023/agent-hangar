// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './layoutMotion.ts';
import { playSidebarMotion } from './sidebarMotion.ts';

// jsdom は --dur を読めず 0 になり、動きを作らずに返る。ここでは長さがある場合の組み立てを見る。
vi.mock('./motion.ts', () => ({ motionMs: () => 420, motionEase: () => 'ease-out' }));

type Call = { el: Element; keyframes: Keyframe[]; opts: KeyframeAnimationOptions };

function mount(collapsed: boolean) {
  document.body.innerHTML = `
    <div class="shell"${collapsed ? ' data-sidebar="collapsed"' : ''}>
      <nav class="sidebar"><div class="nav-row"><a class="nav-item"><svg></svg><span class="nav-label">ホーム</span></a><button class="btn sidebar-toggle"><svg></svg></button></div></nav>
      <header class="header"><div class="header-brand"><a class="brand"><img class="brand-mark"><span class="brand-word">Hangar</span></a></div></header>
    </div>`;
  const calls: Call[] = [];
  const anim = () => ({ finished: new Promise(() => {}), cancel: () => {} });
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, opts?: number | KeyframeAnimationOptions) {
    calls.push({ el: this, keyframes: keyframes as Keyframe[], opts: opts as KeyframeAnimationOptions });
    return anim() as unknown as Animation;
  };
  const shell = document.querySelector<HTMLElement>('.shell')!;
  shell.getAnimations = () => [];
  return { shell, calls };
}

afterEach(() => { delete (Element.prototype as { animate?: unknown }).animate; });

describe('サイドバーの開閉の動き（長さがあるとき）', () => {
  // 本文と検索欄の左の余白は --col1 から決まるので、列の幅と一緒に --col1 も動かす。列の幅だけだと、余白が動きの初めに跳ぶ。
  it('列の幅と --col1 を、同じ動きの中で動かす', () => {
    const { shell, calls } = mount(true);
    playSidebarMotion(shell);
    const cols = calls.find((c) => c.el === shell)!;
    expect(Object.keys(cols.keyframes[0]!)).toEqual(expect.arrayContaining(['--col1', 'gridTemplateColumns']));
  });
  // ロゴはヘッダにあって開閉では動かさない。図のハンガーだけが、帯に引かれて揺れる。
  it('ヘッダの図を、閉じると右へ、開くと左へ揺らし、ロゴの箱は動かさない', () => {
    for (const collapsed of [true, false]) {
      const { shell, calls } = mount(collapsed);
      playSidebarMotion(shell);
      const swing = calls.find((c) => c.el.classList.contains('brand-mark'))!;
      expect(swing.opts.composite).toBe('add');
      const first = swing.keyframes.find((k) => /rotate\((-?[\d.]+)deg\)/.exec(String(k.transform)) && Number(/rotate\((-?[\d.]+)deg\)/.exec(String(k.transform))![1]) !== 0)!;
      const deg = Number(/rotate\((-?[\d.]+)deg\)/.exec(String(first.transform))![1]);
      expect(Math.sign(deg)).toBe(collapsed ? 1 : -1);
      expect(calls.some((c) => c.el.classList.contains('brand'))).toBe(false);
    }
  });
  it('開閉のボタンも、項目と同じく箱を動かす', () => {
    const { shell, calls } = mount(false);
    playSidebarMotion(shell);
    expect(calls.some((c) => c.el.classList.contains('sidebar-toggle'))).toBe(true);
    expect(calls.some((c) => c.el.classList.contains('nav-item'))).toBe(true);
  });
  // 開閉し直すと前の動きは取り消される。その分の数も返さないと、新しい動きが終わっても印が残り続ける。
  it('途中で開閉し直しても、新しい動きが終わったら印が外れ、止まったことを 1 度だけ知らせる', async () => {
    const { shell } = mount(false);
    const cols: { resolve: () => void; reject: () => void }[] = [];
    Element.prototype.animate = function (this: Element) {
      if (this !== shell) return { finished: new Promise(() => {}), cancel: () => {} } as unknown as Animation;
      let resolve!: () => void; let reject!: () => void;
      const finished = new Promise<void>((res, rej) => { resolve = res; reject = () => rej(new Error('cancelled')); });
      cols.push({ resolve, reject });
      return { finished, cancel: () => {} } as unknown as Animation;
    };
    const settled = vi.fn();
    window.addEventListener(LAYOUT_SETTLED, settled);
    playSidebarMotion(shell);
    playSidebarMotion(shell);
    cols[0]!.reject();
    await Promise.resolve(); await Promise.resolve();
    expect(shell).toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).not.toHaveBeenCalled();
    cols[1]!.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(shell).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).toHaveBeenCalledTimes(1);
    window.removeEventListener(LAYOUT_SETTLED, settled);
  });
});
