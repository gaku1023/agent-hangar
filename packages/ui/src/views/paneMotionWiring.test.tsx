import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paneDrag } from './paneDrag.ts';

const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }));
let values: Record<string, string> = {};
const on = (dur: string) => { values = { '--dur': dur, '--dur-fast': dur, '--dur-exit': dur, '--ease-out': 'ease-out', '--ease-in': 'ease-in' }; };
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ getPropertyValue: (n: string) => values[n] ?? '' }) as unknown as CSSStyleDeclaration);
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  animate.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; paneDrag.cancel(); paneDrag.landed(); document.body.innerHTML = ''; });

describe('ドラッグの札の終わり', () => {
  const src = { kind: 'session' as const, sessionId: 's1', name: 'x' };
  it('動くときは、離しても行き先を残す（吸い込み）。landed で消える。やめたときも同じ', () => {
    on('420ms');
    paneDrag.move(src, 5, 5);
    act(() => { paneDrag.finish(); });
    expect(paneDrag.get()).toBeNull();
    expect(paneDrag.landing()).toMatchObject({ ok: false, x: 5, y: 5 });
    act(() => paneDrag.landed());
    expect(paneDrag.landing()).toBeNull();
    paneDrag.move(src, 1, 1);
    act(() => paneDrag.cancel());
    expect(paneDrag.landing()).toMatchObject({ ok: false });
    // 新しいドラッグが始まったら、前の札の動きは捨てる。
    paneDrag.move(src, 2, 2);
    expect(paneDrag.landing()).toBeNull();
  });
  it('動きを減らす設定では、行き先を残さず札はすぐ消える', () => {
    on('0ms');
    paneDrag.move(src, 5, 5);
    paneDrag.finish();
    expect(paneDrag.landing()).toBeNull();
    paneDrag.move(src, 5, 5);
    paneDrag.cancel();
    expect(paneDrag.landing()).toBeNull();
  });
});
