import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resizeFrom } from './primitives/motionKit.ts';
import { useCardHeight } from './useCardHeight.ts';

// 背の動きは motionKit の resizeFrom に任せる。ここでは、いつ、どの背から動かすかだけを見る。
const cancel = vi.fn();
vi.mock('./primitives/motionKit.ts', () => ({ resizeFrom: vi.fn(() => ({ cancel })) }));
const moved = vi.mocked(resizeFrom);

// jsdom には配置が無いので、中身の箱（.nc-body に当たる）の背と幅、右の列の背を決めて返す。
// 札の背は style.height に書いた値をそのまま返す（書く前は 0）。
let content = { h: 100, w: 240 };
let column = 0;
const observers: (() => void)[] = [];
const disconnects = vi.fn();

function stubLayout() {
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() { disconnects(); } });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const card = this.hasAttribute('data-card');
    const h = card ? parseFloat(this.style.height) || 0 : content.h;
    return { width: content.w, height: h, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-column') ? column : 0;
  });
}
beforeEach(() => { moved.mockClear(); cancel.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); observers.length = 0; disconnects.mockClear(); content = { h: 100, w: 240 }; column = 0; });

function Card(props: { s: string; k: string }) {
  const { card, body } = useCardHeight<HTMLElement, HTMLDivElement>(props.s, props.k);
  return <div data-column><section ref={card} data-card><div ref={body} data-body /></section></div>;
}
const card = () => document.querySelector<HTMLElement>('[data-card]')!;
/** 中身が変わって ResizeObserver が呼ばれた形。 */
const resize = (next: Partial<typeof content>) => { content = { ...content, ...next }; for (const cb of observers) cb(); };

describe('useCardHeight（札の背は伸びるとすぐ、縮むのは節目だけ）', () => {
  it('描いた直後は中身の背に合わせ、動かさない', () => {
    stubLayout();
    render(<Card s="s1" k="0" />);
    expect(card().style.height).toBe('100px');
    expect(moved).not.toHaveBeenCalled();
  });

  it('中身が伸びたら、すぐ前の背から動かして伸ばす', () => {
    stubLayout();
    render(<Card s="s1" k="0" />);
    resize({ h: 160 });
    expect(card().style.height).toBe('160px');
    expect(moved).toHaveBeenCalledTimes(1);
    expect(moved).toHaveBeenCalledWith(card(), 100);
  });

  it('中身が縮んでも、節目の鍵が同じあいだは背を保つ（時間では縮めない）', () => {
    stubLayout();
    const { rerender } = render(<Card s="s1" k="0" />);
    resize({ h: 160 });
    moved.mockClear();
    resize({ h: 62 });
    expect(card().style.height).toBe('160px');
    resize({ h: 120 });
    rerender(<Card s="s1" k="0" />);
    expect(card().style.height).toBe('160px');
    expect(moved).not.toHaveBeenCalled();
    resize({ h: 200 });
    expect(card().style.height).toBe('200px');
  });

  it('節目の鍵が替わったら、中身の背まで動かして縮める', () => {
    stubLayout();
    const { rerender } = render(<Card s="s1" k="0" />);
    resize({ h: 160 });
    resize({ h: 62 });
    moved.mockClear();
    rerender(<Card s="s1" k="1" />);
    expect(card().style.height).toBe('62px');
    expect(moved).toHaveBeenCalledWith(card(), 160);
    // 節目の後は、また伸びるだけになる。
    resize({ h: 40 });
    expect(card().style.height).toBe('62px');
  });

  it('保つ背には右の列の 6 割の上限を掛け、中身がそれより高ければ中身に合わせる', () => {
    stubLayout();
    column = 200;
    render(<Card s="s1" k="0" />);
    resize({ h: 160 });
    expect(card().style.height).toBe('160px');
    resize({ h: 62 });
    expect(card().style.height).toBe('120px');
    resize({ h: 130 });
    expect(card().style.height).toBe('130px');
  });

  it('端数の背は切り上げる（背が 1 コマごとに揺れない）', () => {
    stubLayout();
    content = { h: 100.2, w: 240 };
    render(<Card s="s1" k="0" />);
    expect(card().style.height).toBe('101px');
    resize({});
    expect(card().style.height).toBe('101px');
  });

  it('幅が替わったら、保った背を捨て、動かさずに中身へ合わせ直す（折り返しが替わるため）', () => {
    stubLayout();
    render(<Card s="s1" k="0" />);
    resize({ h: 200 });
    moved.mockClear();
    resize({ w: 320, h: 90 });
    expect(card().style.height).toBe('90px');
    expect(moved).not.toHaveBeenCalled();
  });

  it('セッションが替わったら、保った背を捨て、動かさずに中身へ合わせ直す', () => {
    stubLayout();
    const { rerender } = render(<Card s="s1" k="3" />);
    resize({ h: 200 });
    moved.mockClear();
    content = { h: 70, w: 240 };
    rerender(<Card s="s2" k="0" />);
    expect(card().style.height).toBe('70px');
    expect(moved).not.toHaveBeenCalled();
  });

  it('動いている途中で背を替えるときは、前の動きを取り消してから動かす', () => {
    stubLayout();
    render(<Card s="s1" k="0" />);
    resize({ h: 160 });
    expect(cancel).not.toHaveBeenCalled();
    resize({ h: 220 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(moved).toHaveBeenLastCalledWith(card(), 160);
  });

  it('外すときは観測を止め、書いた背を消す', () => {
    stubLayout();
    const { unmount } = render(<Card s="s1" k="0" />);
    const el = card();
    unmount();
    expect(disconnects).toHaveBeenCalled();
    expect(el.style.height).toBe('');
  });

  it('ResizeObserver が無い環境では何もしない', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<Card s="s1" k="0" />);
    expect(card().style.height).toBe('');
  });
});
