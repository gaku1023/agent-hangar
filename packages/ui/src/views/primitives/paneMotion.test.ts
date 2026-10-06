import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_MOVING_ATTR, LAYOUT_SETTLED } from './layoutMotion.ts';
import { PANE_SHAPE, playPaneMotion } from './paneMotion.ts';

afterEach(() => { document.documentElement.removeAttribute('style'); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

describe('playPaneMotion', () => {
  it('動かない環境では null を返し、印を付けない', () => {
    const box = document.createElement('div');
    expect(playPaneMotion(box, PANE_SHAPE.split.open, null, false)).toBeNull();
    expect(box).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
  });
  it('前の形を一瞬当てて測り、インラインの値は元に戻す。動いている間は印を付け、終わったら外して知らせる', async () => {
    for (const [k, v] of Object.entries({ '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--blur-in': '6px' })) document.documentElement.style.setProperty(k, v);
    const frames: Keyframe[][] = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (f: Keyframe[]) { frames.push(f); return { finished: Promise.resolve(), cancel: vi.fn() }; };
    const box = document.createElement('div');
    box.style.gridTemplateColumns = 'minmax(0, 1fr) 0px';
    document.body.appendChild(box);
    const settled = vi.fn();
    window.addEventListener(LAYOUT_SETTLED, settled);
    const p = playPaneMotion(box, PANE_SHAPE.split.open, null, false);
    expect(box).toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(box.style.gridTemplateColumns).toBe('minmax(0, 1fr) 0px');
    await p;
    expect(box).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(frames[0]![0]).toHaveProperty('gridTemplateColumns');
    window.removeEventListener(LAYOUT_SETTLED, settled);
    box.remove();
  });
  it('中身は幅だけを留める。flex には触れず（縦の伸びを奪わない）、終わったら幅の固定を外す', async () => {
    for (const [k, v] of Object.entries({ '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--blur-in': '6px' })) document.documentElement.style.setProperty(k, v);
    let finish: () => void = () => {};
    const finished = new Promise<void>((r) => { finish = r; });
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { return { finished, cancel: vi.fn() }; };
    const box = document.createElement('div');
    const inner = document.createElement('div');
    inner.getBoundingClientRect = () => ({ width: 300 }) as DOMRect;
    box.appendChild(inner);
    document.body.appendChild(box);
    const p = playPaneMotion(box, PANE_SHAPE.split.open, inner, false);
    expect(inner.style.width).toBe('300px');
    expect(inner.style.minWidth).toBe('300px');
    expect(inner.style.flex).toBe('');
    finish();
    await p;
    expect(inner.style.width).toBe('');
    expect(inner.style.minWidth).toBe('');
    expect(inner.style.flex).toBe('');
    box.remove();
  });
  it('動きの途中でもう一度呼ぶと、前の動きを捨ててから測る（素早く 2 回押したとき）', () => {
    for (const [k, v] of Object.entries({ '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--blur-in': '6px' })) document.documentElement.style.setProperty(k, v);
    const made: { id?: string; cancel: ReturnType<typeof vi.fn> }[] = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (_f: Keyframe[], o: KeyframeAnimationOptions) { const a = { id: o.id, cancel: vi.fn(), finished: new Promise(() => {}) }; made.push(a); return a; };
    const box = document.createElement('div');
    (box as unknown as { getAnimations: unknown }).getAnimations = () => made;
    document.body.appendChild(box);
    void playPaneMotion(box, PANE_SHAPE.split.open, null, false);
    void playPaneMotion(box, PANE_SHAPE.split.closed, null, true);
    expect(made[0]!.cancel).toHaveBeenCalled();
    // 捨てられた動きの後始末で印が外れても、新しい動きの印は付いたまま。
    expect(box).toHaveAttribute('data-layout-moving');
    box.remove();
  });
  // 重なった動きの片方が先に終わっても、もう片方が終わるまで印を残す。端末は止まってから 1 度だけ合わせる。
  it('2 回重ねて呼ぶと、捨てた動きの後始末では印が外れず、新しい動きが終わってから外れて 1 度だけ知らせる', async () => {
    for (const [k, v] of Object.entries({ '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--blur-in': '6px' })) document.documentElement.style.setProperty(k, v);
    const ctl: { resolve: () => void; reject: () => void }[] = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (_f: Keyframe[], o: KeyframeAnimationOptions) {
      if (o.id !== 'pane-motion') return { finished: new Promise(() => {}), cancel: vi.fn() };
      let resolve!: () => void; let reject!: () => void;
      const finished = new Promise<void>((res, rej) => { resolve = res; reject = () => rej(new Error('cancelled')); });
      ctl.push({ resolve, reject });
      return { finished, cancel: vi.fn() };
    };
    const box = document.createElement('div');
    document.body.appendChild(box);
    const settled = vi.fn();
    window.addEventListener(LAYOUT_SETTLED, settled);
    const p1 = playPaneMotion(box, PANE_SHAPE.split.open, null, false)!;
    const p2 = playPaneMotion(box, PANE_SHAPE.split.closed, null, true)!;
    ctl[0]!.reject();
    await p1;
    expect(box).toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).not.toHaveBeenCalled();
    ctl[1]!.resolve();
    await p2;
    expect(box).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(settled).toHaveBeenCalledTimes(1);
    window.removeEventListener(LAYOUT_SETTLED, settled);
    box.remove();
  });
});
