import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { cleanSidebarWidth, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_MAX, sidebarWidthCss } from '../mediator/sidebar.ts';
import { initialState, transition } from '../mediator/transition.ts';
import { initialStore } from '../store/store.ts';
import { SidebarGrip } from './SidebarGrip.tsx';

afterEach(cleanup);

describe('サイドバーの幅（sidebar.width）', () => {
  const resize = (state: ReturnType<typeof initialState>, width: number) => transition(state, initialStore(), { kind: 'action', action: { type: 'sidebar.width', width } });
  it('既定は 208px', () => {
    expect(initialState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(SIDEBAR_WIDTH_DEFAULT).toBe(208);
  });
  it('幅を状態に入れて localStorage に残す。範囲の外は端に寄せ、端数は丸める', () => {
    const a = resize(initialState(), 300.4);
    expect(a.state.sidebarWidth).toBe(300);
    expect(a.effects).toContainEqual({ kind: 'storage.save', key: SIDEBAR_WIDTH_KEY, value: 300 });
    expect(resize(initialState(), 999).state.sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
    expect(resize(initialState(), 10).state.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
  it('同じ幅なら何もしない', () => {
    expect(resize(initialState(), SIDEBAR_WIDTH_DEFAULT).effects).toEqual([]);
  });
  it('壊れた保存値は既定に戻す', () => {
    expect(cleanSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(cleanSidebarWidth('300')).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(cleanSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(cleanSidebarWidth(320)).toBe(320);
    expect(cleanSidebarWidth(5000)).toBe(SIDEBAR_WIDTH_MAX);
  });
  it('窓が狭いときは窓の幅の 35% で頭打ちにする。ただし既定より狭くはしない', () => {
    expect(sidebarWidthCss(320)).toBe('clamp(208px, 35vw, 320px)');
  });
});

describe('サイドバーの縁（SidebarGrip）', () => {
  const mount = (width = 260, onAction = vi.fn()) => {
    const r = render(<div className="shell" style={{ ['--sidebar-w' as string]: sidebarWidthCss(width) }}><ActionRoot onAction={onAction}><SidebarGrip width={width} /></ActionRoot></div>);
    return { ...r, onAction, grip: screen.getByRole('separator') };
  };
  it('幅を読み上げに出す', () => {
    const { grip } = mount(260);
    expect(grip.getAttribute('aria-valuenow')).toBe('260');
    expect(grip.getAttribute('aria-valuemin')).toBe(String(SIDEBAR_WIDTH_DEFAULT));
    expect(grip.getAttribute('aria-valuemax')).toBe(String(SIDEBAR_WIDTH_MAX));
  });
  it('ダブルクリックで既定の幅に戻す', () => {
    const { grip, onAction } = mount(320);
    fireEvent.doubleClick(grip);
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.width', width: SIDEBAR_WIDTH_DEFAULT });
  });
  it('左右の矢印で 16px ずつ動かす', () => {
    const { grip, onAction } = mount(260);
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'sidebar.width', width: 276 });
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'sidebar.width', width: 244 });
  });
  it('ドラッグの途中は状態機械を回さず、離したときに 1 回だけ幅を出す', () => {
    const { grip, onAction, container } = mount(260);
    const shell = container.querySelector<HTMLElement>('.shell')!;
    fireEvent.pointerDown(grip, { clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 340 });
    fireEvent.pointerMove(window, { clientX: 360 });
    expect(onAction).not.toHaveBeenCalled();
    expect(shell.style.getPropertyValue('--sidebar-w')).toBe(sidebarWidthCss(320));
    expect(shell.dataset.sidebarDrag).toBe('true');
    fireEvent.pointerUp(window, { clientX: 360 });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.width', width: 320 });
    expect(shell.dataset.sidebarDrag).toBeUndefined();
  });
  it('動かさずに離したら何も出さない', () => {
    const { grip, onAction } = mount(260);
    fireEvent.pointerDown(grip, { clientX: 300 });
    fireEvent.pointerUp(window, { clientX: 300 });
    expect(onAction).not.toHaveBeenCalled();
  });
});
