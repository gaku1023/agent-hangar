import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../../test/motion.ts';

// jsdom では要素の高さが 0 で、仮想リストは何も描かない。useVirtualizer に渡す引数だけを受け取って確かめる。
const seen = vi.hoisted(() => ({ opts: [] as { count: number; getItemKey?: (i: number) => unknown; estimateSize: (i: number) => number }[] }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: (typeof seen.opts)[number]) => {
    seen.opts.push(opts);
    return { getVirtualItems: () => [], getTotalSize: () => 0 };
  },
}));

const { VirtualList } = await import('./VirtualList.tsx');

describe('VirtualList', () => {
  // 裁定 2C：@tanstack/virtual は件数と鍵が変わらなければ、estimateSize が変わっても高さを測り直さない。
  // 見出しを挟んだ一覧で、件数が同じまま行と見出しの並びが変わると、古い高さのまま重なって描かれる。
  it('項目の鍵を getItemKey に渡し、並びが変われば鍵も変わる', () => {
    type It = { k: string; h: number };
    const ui = (items: It[]) => <VirtualList items={items} rowHeight={(it) => it.h} height={400} keyOf={(it) => it.k} render={(it) => <span>{it.k}</span>} />;
    const { rerender } = render(ui([{ k: 'head:done', h: 32 }, { k: 'a', h: 56 }]));
    const first = seen.opts.at(-1)!;
    expect([0, 1].map((i) => first.getItemKey?.(i))).toEqual(['head:done', 'a']);
    expect([0, 1].map((i) => first.estimateSize(i))).toEqual([32, 56]);
    rerender(ui([{ k: 'a', h: 56 }, { k: 'head:done', h: 32 }]));
    const next = seen.opts.at(-1)!;
    expect(next.count).toBe(2);
    expect([0, 1].map((i) => next.getItemKey?.(i))).toEqual(['a', 'head:done']);
  });
});

describe('VirtualList の並び替えの滑り（glide）', () => {
  let restore: (() => void) | null = null;
  let animations: { el: Element; frames: Keyframe[] }[] = [];
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    animations = []; frames = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, f: Keyframe[]) {
      animations.push({ el: this, frames: f });
      return { finished: new Promise<void>(() => {}), cancel: vi.fn() };
    };
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });
  afterEach(() => {
    restore?.(); restore = null;
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  });
  const flush = () => act(() => { const now = frames; frames = []; now.forEach((f) => f(0)); });
  const ui = (keys: string[], glide?: string) => <VirtualList items={keys} rowHeight={56} height={400} keyOf={(k) => k} glide={glide} render={(k) => <span>{k}</span>} />;
  const scroller = (c: HTMLElement) => c.querySelector('.list-scroll')!;

  it('glide を渡すと、一覧の器に data-glide を付ける。glide が替わった描画（タブやページの切替）では、2 コマのあいだ外す', () => {
    const { container, rerender } = render(ui(['a', 'b'], 'all|1'));
    expect(scroller(container)).toHaveAttribute('data-glide');
    rerender(ui(['b', 'c'], 'done|1'));
    expect(scroller(container)).not.toHaveAttribute('data-glide');
    flush();
    expect(scroller(container)).not.toHaveAttribute('data-glide');
    flush();
    expect(scroller(container)).toHaveAttribute('data-glide');
  });

  it('同じ glide のまま新しい key が来たら、その行の中身だけを浮かべて入れる', () => {
    const { rerender } = render(ui(['a', 'b'], 's'));
    expect(animations).toHaveLength(0);
    rerender(ui(['n', 'a', 'b'], 's'));
    expect(animations.map((x) => x.el.textContent)).toEqual(['n']);
    expect(animations[0]!.el.tagName).toBe('SPAN');
    expect(animations[0]!.frames[0]).toMatchObject({ opacity: 0, transform: 'translateY(6px)' });
  });

  it('glide が替わった描画、key が全部替わった描画、空から埋まった描画では、行を浮かべない', () => {
    const { rerender } = render(ui(['a', 'b'], 's'));
    rerender(ui(['c', 'a'], 't'));
    rerender(ui(['x', 'y'], 't'));
    rerender(ui([], 't'));
    rerender(ui(['p', 'q'], 't'));
    expect(animations).toHaveLength(0);
  });

  it('glide を渡さなければ、印も動きも持たない', () => {
    const { container, rerender } = render(ui(['a']));
    rerender(ui(['n', 'a']));
    expect(scroller(container)).not.toHaveAttribute('data-glide');
    expect(animations).toHaveLength(0);
  });
});
