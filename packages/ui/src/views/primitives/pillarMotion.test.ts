import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_MOVING_ATTR } from './layoutMotion.ts';
import { pillarClose, pillarOpen } from './pillarMotion.ts';

const tokens = { '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in' };
afterEach(() => { document.documentElement.removeAttribute('style'); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

function setup(width: number) {
  for (const [k, v] of Object.entries(tokens)) document.documentElement.style.setProperty(k, v);
  const frames: Keyframe[][] = [];
  const opts: KeyframeAnimationOptions[] = [];
  const cancel = vi.fn();
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (f: Keyframe[], o: KeyframeAnimationOptions) { frames.push(f); opts.push(o); return { finished: Promise.resolve(), cancel }; };
  const panel = document.createElement('section');
  const inner = document.createElement('div');
  panel.getBoundingClientRect = () => ({ width }) as DOMRect;
  inner.getBoundingClientRect = () => ({ width }) as DOMRect;
  panel.appendChild(inner);
  document.body.appendChild(panel);
  return { panel, inner, frames, opts, cancel };
}

describe('柱の開閉の動き', () => {
  it('動かない環境では null を返し、印も固定も付けない', () => {
    const panel = document.createElement('section');
    expect(pillarOpen(panel, null)).toBeNull();
    expect(pillarClose(panel, null)).toBeNull();
    expect(panel).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
  });
  it('開くときは外側の幅だけ 0 から広げ、中身は開いたときの幅に留め、終わったら固定と動きを外す', async () => {
    const { panel, inner, frames, opts, cancel } = setup(340);
    const p = pillarOpen(panel, inner);
    expect(panel).toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(inner.style.width).toBe('340px');
    expect(frames[0]).toEqual([{ width: '0px', opacity: 0 }, { width: '340px', opacity: 1 }]);
    expect(opts[0]).toMatchObject({ duration: 420, easing: 'ease-out' });
    await p;
    expect(panel).not.toHaveAttribute(LAYOUT_MOVING_ATTR);
    expect(inner.style.width).toBe('');
    expect(cancel).toHaveBeenCalled();
  });
  it('閉じるときも同じ長さと曲線で、中身の幅を留めたまま外側を 0 へ畳み、畳んだ形を残す', async () => {
    const { panel, inner, frames, opts, cancel } = setup(340);
    const p = pillarClose(panel, inner);
    expect(inner.style.width).toBe('340px');
    expect(frames[0]![1]).toEqual({ width: '0px', opacity: 0 });
    expect(opts[0]).toMatchObject({ duration: 420, easing: 'ease-out', fill: 'forwards' });
    await p;
    expect(cancel).not.toHaveBeenCalled();
    expect(inner.style.width).toBe('340px');
  });
});
