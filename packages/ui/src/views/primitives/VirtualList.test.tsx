import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
