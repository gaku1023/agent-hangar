import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNow, type VisibilitySource } from './useNow.ts';

/** document の代わり。visibilityState を書き換え、visibilitychange を起こす。 */
function fakeDoc(): VisibilitySource & { set(state: 'visible' | 'hidden'): void; listeners: number } {
  const ls = new Set<() => void>();
  const d = {
    visibilityState: 'visible' as string,
    addEventListener: (_t: 'visibilitychange', cb: () => void) => { ls.add(cb); },
    removeEventListener: (_t: 'visibilitychange', cb: () => void) => { ls.delete(cb); },
    set(state: 'visible' | 'hidden') { d.visibilityState = state; for (const cb of [...ls]) cb(); },
    get listeners() { return ls.size; },
  };
  return d;
}

describe('useNow', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('見えている間は間隔ごとに進む', () => {
    const doc = fakeDoc();
    const { result } = renderHook(() => useNow(1000, { source: doc }));
    expect(result.current).toBe(1_000_000);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(1_001_000);
  });

  it('隠れている間は時計を止めて描き直さず、見えたときに 1 回だけ今の時刻へ進める', () => {
    const doc = fakeDoc();
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useNow(1000, { source: doc }); });
    const before = renders;
    act(() => { doc.set('hidden'); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(renders).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    act(() => { doc.set('visible'); });
    expect(result.current).toBe(1_060_000);
    expect(renders).toBe(before + 1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(1_061_000);
  });

  it('sync が変わったら、今の時刻へ合わせ直す', () => {
    const doc = fakeDoc();
    const { result, rerender } = renderHook((p: { at: number }) => useNow(1000, { source: doc, sync: p.at }), { initialProps: { at: 1 } });
    vi.setSystemTime(1_000_400);
    rerender({ at: 2 });
    expect(result.current).toBe(1_000_400);
  });

  it('active が偽の間は時計を回さない', () => {
    const doc = fakeDoc();
    renderHook(() => useNow(1000, { active: false, source: doc }));
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.listeners).toBe(0);
  });

  it('外したら時計と受け口を片付ける', () => {
    const doc = fakeDoc();
    const { unmount } = renderHook(() => useNow(1000, { source: doc }));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.listeners).toBe(0);
  });
});
