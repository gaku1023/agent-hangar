import { render } from '@testing-library/react';
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

describe('VirtualList の並び替えの知らせ（⑤ の c）', () => {
  let restore: (() => void) | null = null;
  let animations: Element[] = [];
  beforeEach(() => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    animations = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element) {
      animations.push(this);
      return { finished: new Promise<void>(() => {}), cancel: vi.fn() };
    };
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  });
  const ui = (keys: string[], scope?: string) => <VirtualList items={keys} rowHeight={56} height={400} keyOf={(k) => k} scope={scope} render={(k) => <span>{k}</span>} />;
  const hit = (c: HTMLElement) => [...c.querySelectorAll('span[data-hit]')].map((e) => e.textContent);

  it('同じ範囲のまま並びが替わったら、並びはいきなり替え、上がった行と新しい行の中身だけに淡い黄の印を付ける', () => {
    const { container, rerender } = render(ui(['a', 'b', 'c', 'd'], 's'));
    expect(hit(container)).toEqual([]);
    rerender(ui(['n', 'c', 'a', 'b', 'd'], 's'));
    expect(hit(container).sort()).toEqual(['c', 'n']);
    // 滑らせも浮かべもしない。
    expect(animations).toHaveLength(0);
    expect(container.querySelector('.list-scroll')).not.toHaveAttribute('data-glide');
  });

  it('行が消えて詰まっただけの描画では、印を付けない', () => {
    const { container, rerender } = render(ui(['a', 'b', 'c'], 's'));
    rerender(ui(['a', 'c'], 's'));
    expect(hit(container)).toEqual([]);
  });

  it('範囲が替わった描画、key が全部替わった描画、空から埋まった描画では、印を付けない', () => {
    const { container, rerender } = render(ui(['a', 'b'], 's'));
    rerender(ui(['c', 'b', 'a'], 't'));
    rerender(ui(['x', 'y'], 't'));
    rerender(ui([], 't'));
    rerender(ui(['p', 'q'], 't'));
    expect(hit(container)).toEqual([]);
  });

  it('scope を渡さなければ、印を付けない', () => {
    const { container, rerender } = render(ui(['a', 'b']));
    rerender(ui(['n', 'b', 'a']));
    expect(hit(container)).toEqual([]);
  });
});
