import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { Toast } from '../mediator/types.ts';
import type { ToastsProps, WaitingCardProps } from '../presenters/toasts.ts';
import { INFO_TOAST_MS, ToastStack } from './ToastStack.tsx';

const card = (id: string, over: Partial<WaitingCardProps> = {}): WaitingCardProps => ({ sessionId: id, name: `名前 ${id}`, projectName: 'shop-web', waited: '2 分', question: `問い ${id}`, ...over });
const props = (over: Partial<ToastsProps> = {}): ToastsProps => ({ toasts: [], waiting: [], more: 0, offerNotify: false, blocked: false, ...over });
function mount(p: ToastsProps) {
  const onIntent = vi.fn();
  const r = render(<IntentRoot onIntent={onIntent}><ToastStack {...p} /></IntentRoot>);
  return { onIntent, rerender: (q: ToastsProps) => r.rerender(<IntentRoot onIntent={onIntent}><ToastStack {...q} /></IntentRoot>) };
}

describe('入力待ちのカード', () => {
  it('名前、プロジェクト、待っている時間、問いを出し、「ターミナルで答える」でそのセッションを開く', () => {
    const { onIntent } = mount(props({ waiting: [card('s1')] }));
    const c = within(screen.getByRole('group', { name: '名前 s1 が入力を待っています' }));
    expect(c.getByText('shop-web')).toBeInTheDocument();
    expect(c.getByText('2 分待っている')).toBeInTheDocument();
    expect(c.getByText('問い s1')).toBeInTheDocument();
    fireEvent.click(c.getByRole('button', { name: 'ターミナルで答える' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1', focus: 'terminal' });
  });
  it('カードのどこを押しても開く', () => {
    const { onIntent } = mount(props({ waiting: [card('s1')] }));
    fireEvent.click(screen.getByText('問い s1'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1', focus: 'terminal' });
  });
  it('時間では消えない', () => {
    vi.useFakeTimers();
    try {
      const { onIntent } = mount(props({ waiting: [card('s1')] }));
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(onIntent).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('並べきれない分は「ほか N 件をホームで見る」にまとめ、押すとホームへ移る', () => {
    const { onIntent } = mount(props({ waiting: [card('s3'), card('s4'), card('s5')], more: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'ほか 2 件をホームで見る' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'home' } });
  });
  it('通知を受け取っていなければ「通知を受け取る」を添え、押してもセッションは開かない', () => {
    const { onIntent } = mount(props({ waiting: [card('s1')], offerNotify: true }));
    fireEvent.click(screen.getByRole('button', { name: '通知を受け取る' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'notify.set', on: true });
    expect(onIntent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
  it('ダイアログが開いている間は、カードもボタンも押せず、何も出さない', () => {
    const { onIntent } = mount(props({ waiting: [card('s1')], more: 2, blocked: true }));
    const c = within(screen.getByRole('group', { name: '名前 s1 が入力を待っています' }));
    expect(c.getByRole('button', { name: 'ターミナルで答える' })).toBeDisabled();
    expect(c.getByText('ダイアログを閉じると開けます')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ほか 2 件をホームで見る' })).toBeDisabled();
    fireEvent.click(screen.getByText('問い s1'));
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('受け取っていれば添えない', () => {
    mount(props({ waiting: [card('s1')] }));
    expect(screen.queryByRole('button', { name: '通知を受け取る' })).toBeNull();
  });
});

describe('info と error のトースト', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const info = (id: string, message = `知らせ ${id}`): Toast => ({ id, level: 'info', message });
  const error = (id: string, message = `失敗 ${id}`): Toast => ({ id, level: 'error', message });

  it('info は role="status" で、時間が来たら消す', () => {
    const { onIntent } = mount(props({ toasts: [info('1')] }));
    expect(screen.getByRole('status')).toHaveTextContent('知らせ 1');
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS - 1); });
    expect(onIntent).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onIntent).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('時間切れはトーストごとに数える', () => {
    const { onIntent, rerender } = mount(props({ toasts: [info('1')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS / 2); });
    rerender(props({ toasts: [info('1'), info('2')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS / 2); });
    expect(onIntent.mock.calls).toEqual([[{ type: 'toast.dismiss', id: '1' }]]);
    rerender(props({ toasts: [info('2')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS / 2); });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'toast.dismiss', id: '2' });
  });
  it('マウスを乗せている間は止め、離したら残りの時間で消す', () => {
    const { onIntent } = mount(props({ toasts: [info('1')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS - 1000); });
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS * 3); });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(999); });
    expect(onIntent).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onIntent).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('info は押しても消せる', () => {
    const { onIntent } = mount(props({ toasts: [info('1')] }));
    fireEvent.click(screen.getByText('知らせ 1'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('error は role="alert" で、時間では消えず、閉じるで消す', () => {
    const { onIntent } = mount(props({ toasts: [error('1')] }));
    const alert = screen.getByRole('alert');
    act(() => { vi.advanceTimersByTime(60_000); });
    fireEvent.click(within(alert).getByText('失敗 1'));
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: '閉じる' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('error の本文が 2 行に収まらないときは「詳しく」で開く', () => {
    const tall = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
    const box = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    try {
      mount(props({ toasts: [error('1', '長い失敗の文')] }));
      const more = screen.getByRole('button', { name: '詳しく' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(more);
      expect(more).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('alert')).toHaveAttribute('data-open', 'true');
    } finally { tall.mockRestore(); box.mockRestore(); }
  });
  it('2 行に収まる error には「詳しく」を出さない', () => {
    mount(props({ toasts: [error('1')] }));
    expect(screen.queryByRole('button', { name: '詳しく' })).toBeNull();
  });
});
