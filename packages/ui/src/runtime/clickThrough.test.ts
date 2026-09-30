// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clickThrough, type ClickLike } from './clickThrough.ts';

const click = (over: Partial<ClickLike> = {}): ClickLike => ({
  isTrusted: true, target: document.documentElement, clientX: 40, clientY: 60, button: 0,
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over,
});

beforeEach(() => { document.body.innerHTML = '<a id="nav" href="#/projects">Projects</a>'; });

describe('clickThrough', () => {
  it('遷移の写しに当たったクリックは、遷移を終わらせて、同じ位置の部品へ渡し直す', () => {
    const nav = document.getElementById('nav')!;
    const got: MouseEvent[] = [];
    nav.addEventListener('click', (e) => { got.push(e); e.preventDefault(); });
    const skip = vi.fn(() => true);
    const hit = vi.fn(() => nav);
    const e = click({ metaKey: true });
    clickThrough(e, { root: document.documentElement, skip, hit });
    expect(skip).toHaveBeenCalledTimes(1);
    expect(hit).toHaveBeenCalledWith(40, 60);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ clientX: 40, clientY: 60, metaKey: true, bubbles: true });
  });
  it('遷移が動いていなければ、クリックに触らない', () => {
    const hit = vi.fn();
    const e = click();
    clickThrough(e, { root: document.documentElement, skip: () => false, hit });
    expect(hit).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });
  it.each([
    ['部品に直接当たったクリック', { target: document.body }],
    ['渡し直したクリック（信頼されていない）', { isTrusted: false }],
  ])('%s には触らず、遷移も終わらせない', (_label, over) => {
    const skip = vi.fn(() => true);
    const e = click(over);
    clickThrough(e, { root: document.documentElement, skip, hit: vi.fn() });
    expect(skip).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });
});
