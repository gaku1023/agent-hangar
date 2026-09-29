import { describe, expect, it, vi } from 'vitest';
import { FOCUS_TRIES, focusSoon } from './focusSoon.ts';

describe('focusSoon', () => {
  const frames = () => {
    const q: (() => void)[] = [];
    return { nextFrame: (cb: () => void) => { q.push(cb); }, tick: () => q.shift()?.(), pending: () => q.length };
  };
  it('要素が現れた描画でフォーカスを当てる', () => {
    const f = frames();
    const el = { focus: vi.fn() } as unknown as HTMLElement;
    let ready = false;
    focusSoon(() => (ready ? el : null), f.nextFrame);
    f.tick();
    f.tick();
    expect(el.focus).not.toHaveBeenCalled();
    ready = true;
    f.tick();
    expect(el.focus).toHaveBeenCalledTimes(1);
    expect(f.pending()).toBe(0);
  });
  it('決まった枚数だけ探して、現れなければやめる', () => {
    const f = frames();
    const find = vi.fn(() => null);
    focusSoon(find, f.nextFrame);
    for (let i = 0; i < FOCUS_TRIES + 5; i++) f.tick();
    expect(find).toHaveBeenCalledTimes(FOCUS_TRIES);
    expect(f.pending()).toBe(0);
  });
});
