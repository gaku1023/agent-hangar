import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeMotionTokens } from '../../test/motion.ts';
import { FoldBox } from './FoldBox.tsx';

// 開く・折りたたむ箱。畳む途中で開き直したときに、0 へ跳ばずにいまの高さから伸び直すこと。

type Made = { el: Element; frames: Keyframe[]; playState: string; cancel: () => void };

describe('FoldBox', () => {
  let restore: (() => void) | null = null;
  let made: Made[] = [];
  beforeEach(() => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    made = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
      const a: Made = { el: this, frames, playState: 'running', cancel: () => { a.playState = 'idle'; } };
      made.push(a);
      return { finished: new Promise(() => {}), cancel: a.cancel, get playState() { return a.playState; } };
    };
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = function (this: Element) {
      return made.filter((a) => a.el === this && a.playState !== 'idle').map((a) => ({ cancel: a.cancel, get playState() { return a.playState; } }));
    };
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  });
  const box = (open: boolean) => <FoldBox open={open} keep className="fb">中身</FoldBox>;

  it('畳む途中で開き直すと、畳む動きを取り消し、いまの高さから伸び直す', () => {
    const { rerender, container } = render(box(true));
    const el = container.querySelector<HTMLElement>('.fb')!;
    rerender(box(false));
    const collapse = made.at(-1)!;
    expect(collapse.frames.at(-1)).toMatchObject({ height: '0px' });
    // 途中まで畳んだ形。
    el.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
    rerender(box(true));
    expect(collapse.playState).toBe('idle');
    const grow = made.at(-1)!;
    expect(grow).not.toBe(collapse);
    expect(grow.frames[0]).toMatchObject({ height: '30px' });
  });
  it('畳み終えて隠れた箱を開くときは、0 から伸ばす', () => {
    const { rerender, container } = render(box(false));
    const el = container.querySelector<HTMLElement>('.fb')!;
    expect(el).toHaveAttribute('hidden');
    el.getBoundingClientRect = () => ({ width: 200, height: 30 }) as DOMRect;
    rerender(box(true));
    expect(made.at(-1)!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
  });
  it('動きを減らす設定（長さ 0）では、動かさずにすぐ切り替える', () => {
    restore?.();
    restore = fakeMotionTokens({ '--dur-fast': '0ms', '--dur': '0ms', '--dur-exit': '0ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '0px', '--blur-in': '0px' }, { everywhere: true });
    const { rerender, container } = render(box(true));
    const el = container.querySelector<HTMLElement>('.fb')!;
    rerender(box(false));
    expect(el).toHaveAttribute('hidden');
    rerender(box(true));
    expect(el).not.toHaveAttribute('hidden');
    expect(made).toHaveLength(0);
  });
});
