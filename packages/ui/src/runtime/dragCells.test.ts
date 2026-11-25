import { describe, expect, it } from 'vitest';
import { DRAG_COPY_MS, trackDrag } from './dragCells.ts';

const cell = (x: number, y: number) => ({ x: Math.floor(x / 10), y: Math.floor(y / 20) });
const mouse = (type: string, button: number, clientX: number, clientY: number) => Object.assign(new Event(type), { button, clientX, clientY });

describe('trackDrag', () => {
  it('押し下げから放しまでのマスを覚え、放してから決まった間だけ返す', () => {
    const el = new EventTarget();
    const win = new EventTarget();
    let t = 1000;
    const d = trackDrag(el, win, cell, () => t);
    expect(d.recent()).toBeNull();
    el.dispatchEvent(mouse('mousedown', 0, 25, 45));
    // 放すのは端末の外でもよい。
    win.dispatchEvent(mouse('mouseup', 0, 95, 85));
    expect(d.recent()).toEqual({ start: { x: 2, y: 2 }, end: { x: 9, y: 4 } });
    t += DRAG_COPY_MS + 1;
    expect(d.recent()).toBeNull();
    d.dispose();
  });

  it('右ボタンは数えず、押し下げのたびに前のドラッグを忘れる', () => {
    const el = new EventTarget();
    const win = new EventTarget();
    const d = trackDrag(el, win, cell, () => 0);
    el.dispatchEvent(mouse('mousedown', 0, 0, 0));
    win.dispatchEvent(mouse('mouseup', 0, 30, 0));
    el.dispatchEvent(mouse('mousedown', 2, 0, 0));
    expect(d.recent()).not.toBeNull();
    el.dispatchEvent(mouse('mousedown', 0, 0, 0));
    expect(d.recent()).toBeNull();
    d.dispose();
  });
});
