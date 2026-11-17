import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { cleanOrchWidth, ORCH_WIDTH_DEFAULT, ORCH_WIDTH_KEY, ORCH_WIDTH_MAX, orchWidthCss } from '../mediator/orchestrator.ts';
import { initialState, transition } from '../mediator/transition.ts';
import { initialStore } from '../store/store.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { OrchestratorGrip } from './OrchestratorGrip.tsx';

afterEach(cleanup);

describe('統括の柱の幅（orchestrator.width）', () => {
  const resize = (state: ReturnType<typeof initialState>, width: number) => transition(state, initialStore(), { kind: 'action', action: { type: 'orchestrator.width', width } });
  it('既定は今の柱の幅 340px', () => {
    expect(initialState().orchestratorWidth).toBe(ORCH_WIDTH_DEFAULT);
    expect(ORCH_WIDTH_DEFAULT).toBe(340);
  });
  it('幅を状態に入れて localStorage に残す。範囲の外は端に寄せ、端数は丸める', () => {
    const a = resize(initialState(), 420.4);
    expect(a.state.orchestratorWidth).toBe(420);
    expect(a.effects).toContainEqual({ kind: 'storage.save', key: ORCH_WIDTH_KEY, value: 420 });
    expect(resize(initialState(), 9999).state.orchestratorWidth).toBe(ORCH_WIDTH_MAX);
    expect(resize(initialState(), 10).state.orchestratorWidth).toBe(ORCH_WIDTH_DEFAULT);
  });
  it('同じ幅なら何もしない', () => {
    expect(resize(initialState(), ORCH_WIDTH_DEFAULT).effects).toEqual([]);
  });
  it('壊れた保存値は既定に戻す', () => {
    expect(cleanOrchWidth(undefined)).toBe(ORCH_WIDTH_DEFAULT);
    expect(cleanOrchWidth('400')).toBe(ORCH_WIDTH_DEFAULT);
    expect(cleanOrchWidth(420)).toBe(420);
    expect(cleanOrchWidth(5000)).toBe(ORCH_WIDTH_MAX);
  });
  it('窓が狭いときは窓の幅の 40% で頭打ちにする。ただし既定より狭くはしない', () => {
    expect(orchWidthCss(560)).toBe('clamp(340px, 40vw, 560px)');
  });
});

describe('柱の左の縁（OrchestratorGrip）', () => {
  const mount = (width = 400, onAction = vi.fn()) => {
    const r = render(<LanguageRoot language="ja"><div className="shell" style={{ ['--orch-w' as string]: orchWidthCss(width) }}><ActionRoot onAction={onAction}><OrchestratorGrip width={width} /></ActionRoot></div></LanguageRoot>);
    return { ...r, onAction, grip: screen.getByRole('separator') };
  };
  it('幅を読み上げに出す', () => {
    const { grip } = mount(400);
    expect(grip.getAttribute('aria-valuenow')).toBe('400');
    expect(grip.getAttribute('aria-valuemin')).toBe(String(ORCH_WIDTH_DEFAULT));
    expect(grip.getAttribute('aria-valuemax')).toBe(String(ORCH_WIDTH_MAX));
  });
  it('ダブルクリックで既定の幅に戻す', () => {
    const { grip, onAction } = mount(500);
    fireEvent.doubleClick(grip);
    expect(onAction).toHaveBeenCalledWith({ type: 'orchestrator.width', width: ORCH_WIDTH_DEFAULT });
  });
  it('左の矢印で広げ、右の矢印で狭める（16px ずつ）', () => {
    const { grip, onAction } = mount(400);
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'orchestrator.width', width: 416 });
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'orchestrator.width', width: 384 });
  });
  it('ドラッグの途中は状態機械を回さず、離したときに 1 回だけ幅を出す。左へ動かすと広がる', () => {
    Object.defineProperty(window, 'innerWidth', { value: 2000, configurable: true });
    const { grip, onAction, container } = mount(400);
    const shell = container.querySelector<HTMLElement>('.shell')!;
    fireEvent.pointerDown(grip, { clientX: 800 });
    fireEvent.pointerMove(window, { clientX: 760 });
    fireEvent.pointerMove(window, { clientX: 720 });
    expect(onAction).not.toHaveBeenCalled();
    expect(shell.style.getPropertyValue('--orch-w')).toBe(orchWidthCss(480));
    expect(shell.dataset.orchDrag).toBe('true');
    expect(shell.hasAttribute('data-layout-moving')).toBe(true);
    fireEvent.pointerUp(window, { clientX: 720 });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ type: 'orchestrator.width', width: 480 });
    expect(shell.dataset.orchDrag).toBeUndefined();
    expect(shell.hasAttribute('data-layout-moving')).toBe(false);
  });
  it('動かさずに離したら何も出さず、書き換えた値を戻す', () => {
    const { grip, onAction, container } = mount(400);
    const shell = container.querySelector<HTMLElement>('.shell')!;
    fireEvent.pointerDown(grip, { clientX: 800 });
    fireEvent.pointerUp(window, { clientX: 800 });
    expect(onAction).not.toHaveBeenCalled();
    expect(shell.style.getPropertyValue('--orch-w')).toBe(orchWidthCss(400));
  });
});
