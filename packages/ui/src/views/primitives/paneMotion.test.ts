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
});
