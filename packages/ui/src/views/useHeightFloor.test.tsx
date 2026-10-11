import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHeightFloor } from './useHeightFloor.ts';

// jsdom には配置が無いので、中身の高さと幅を持つ箱を作る。最小の高さ（min-height）は箱の高さの下限として効かせる。
let content = { h: 100, w: 240 };
const observers: (() => void)[] = [];
const disconnects = vi.fn();

function stubLayout() {
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() { disconnects(); } });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const floor = parseFloat(this.style.minHeight) || 0;
    return { width: content.w, height: Math.max(content.h, floor), top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); observers.length = 0; disconnects.mockClear(); content = { h: 100, w: 240 }; });

function Box(props: { k: string }) {
  const ref = useHeightFloor<HTMLDivElement>(props.k);
  return <div ref={ref} data-box />;
}
const box = () => document.querySelector<HTMLElement>('[data-box]')!;
/** 中身が変わって ResizeObserver が呼ばれた形。 */
const resize = (next: Partial<typeof content>) => { content = { ...content, ...next }; for (const cb of observers) cb(); };

describe('useHeightFloor（札の高さは縮めない）', () => {
  it('描いた直後の高さを下限にする', () => {
    stubLayout();
    render(<Box k="s1" />);
    expect(box().style.minHeight).toBe('100px');
  });

  it('中身が伸びたら下限も伸び、縮んでも下限は下げない（下の目次が動かない）', () => {
    stubLayout();
    render(<Box k="s1" />);
    resize({ h: 160 });
    expect(box().style.minHeight).toBe('160px');
    resize({ h: 62 });
    expect(box().style.minHeight).toBe('160px');
    resize({ h: 120 });
    expect(box().style.minHeight).toBe('160px');
    resize({ h: 200 });
    expect(box().style.minHeight).toBe('200px');
  });

  it('端数の高さは切り上げる（下限が 1 コマごとに揺れない）', () => {
    stubLayout();
    content = { h: 100.2, w: 240 };
    render(<Box k="s1" />);
    expect(box().style.minHeight).toBe('101px');
    resize({});
    expect(box().style.minHeight).toBe('101px');
  });

  it('幅が変わったら、下限を捨てて測り直す（折り返しが変わるので、前の高さは当てにならない）', () => {
    stubLayout();
    render(<Box k="s1" />);
    resize({ h: 200 });
    expect(box().style.minHeight).toBe('200px');
    resize({ w: 320, h: 90 });
    expect(box().style.minHeight).toBe('90px');
  });

  it('セッションが替わったら、下限を捨てる', () => {
    stubLayout();
    const { rerender } = render(<Box k="s1" />);
    resize({ h: 200 });
    content = { h: 70, w: 240 };
    rerender(<Box k="s2" />);
    expect(box().style.minHeight).toBe('70px');
  });

  it('外すときは観測を止める', () => {
    stubLayout();
    const { unmount } = render(<Box k="s1" />);
    unmount();
    expect(disconnects).toHaveBeenCalled();
  });

  it('ResizeObserver が無い環境では何もしない', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<Box k="s1" />);
    expect(box().style.minHeight).toBe('');
  });
});
