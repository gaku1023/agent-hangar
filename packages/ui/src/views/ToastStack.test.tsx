import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { Toast } from '../mediator/types.ts';
import type { ToastsProps, WaitingCardProps } from '../presenters/toasts.ts';
import { INFO_TOAST_MS, ToastStack } from './ToastStack.tsx';

const card = (id: string, over: Partial<WaitingCardProps> = {}): WaitingCardProps => ({ sessionId: id, name: `名前 ${id}`, waited: '2 分', question: `問い ${id}`, ...over });
const props = (over: Partial<ToastsProps> = {}): ToastsProps => ({ toasts: [], waiting: [], more: 0, blocked: false, arrived: null, ...over });
function mount(p: ToastsProps) {
  const onAction = vi.fn();
  const r = render(<ActionRoot onAction={onAction}><ToastStack {...p} /></ActionRoot>);
  return { onAction, rerender: (q: ToastsProps) => r.rerender(<ActionRoot onAction={onAction}><ToastStack {...q} /></ActionRoot>) };
}

describe('入力待ちのカード', () => {
  it('見出しにラベル、名前、待っている時間を、その下に問いを出し、押すとそのセッションを開く', () => {
    const { onAction } = mount(props({ waiting: [card('s1')] }));
    const c = screen.getByRole('button', { name: '名前 s1 が入力待ちです：問い s1' });
    const head = within(c.querySelector<HTMLElement>('.notice-head')!);
    expect(head.getByText('入力待ち')).toBeInTheDocument();
    expect(head.getByText('名前 s1')).toBeInTheDocument();
    expect(head.getByText('2 分')).toBeInTheDocument();
    expect(c.querySelector('.notice-title')).toHaveTextContent('問い s1');
    fireEvent.click(c);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 's1', focus: 'terminal' });
  });
  it('カードのどこを押しても開く', () => {
    const { onAction } = mount(props({ waiting: [card('s1')] }));
    fireEvent.click(screen.getByText('問い s1'));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 's1', focus: 'terminal' });
  });
  // 問いが取れない入力待ち（許可待ちなど）は、決まり文句で段を埋めず、名前を主役の段へ上げる。
  it('問いがなければ、見出しはラベルと時間だけにして、名前を問いの段に出す', () => {
    mount(props({ waiting: [card('s1', { question: null })] }));
    const c = screen.getByRole('button', { name: '名前 s1 が入力待ちです' });
    expect(within(c).getAllByText('名前 s1')).toHaveLength(1);
    expect(c.querySelector('.notice-title')).toHaveTextContent('名前 s1');
    expect(within(c.querySelector<HTMLElement>('.notice-head')!).getByText('2 分')).toBeInTheDocument();
  });
  it('ボタンの段と「答えるまで残ります」の注記は持たない', () => {
    mount(props({ waiting: [card('s1')] }));
    expect(screen.queryByRole('button', { name: 'ターミナルで答える' })).toBeNull();
    expect(screen.queryByText('答えるまで残ります')).toBeNull();
  });
  it('時間では消えない', () => {
    vi.useFakeTimers();
    try {
      const { onAction } = mount(props({ waiting: [card('s1')] }));
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(onAction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('並べきれない分は「ほか N 件をホームで見る」にまとめ、押すとホームへ移る', () => {
    const { onAction } = mount(props({ waiting: [card('s3'), card('s4'), card('s5')], more: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'ほか 2 件をホームで見る' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'home' } });
  });
  // 通知の誘いはベルの一覧の行になった（PR 29）。右下には積まない。
  it('通知の誘いも戻る時刻の札も積まない', () => {
    mount(props({ waiting: [card('s1'), card('s2')] }));
    expect(screen.queryByRole('button', { name: '通知を受け取る' })).toBeNull();
    expect(document.querySelector('.notice[data-kind="return"]')).toBeNull();
  });
  it('ダイアログが開いている間は、カードも「ほか N 件」も押せず、理由は乗せたときの説明に出す', () => {
    const { onAction } = mount(props({ waiting: [card('s1')], more: 2, blocked: true }));
    const c = screen.getByRole('button', { name: '名前 s1 が入力待ちです：問い s1' });
    expect(c).toBeDisabled();
    expect(c).toHaveAttribute('title', 'ダイアログを閉じると開けます');
    expect(screen.queryByText('ダイアログを閉じると開けます')).toBeNull();
    expect(screen.getByRole('button', { name: 'ほか 2 件をホームで見る' })).toBeDisabled();
    fireEvent.click(screen.getByText('問い s1'));
    expect(onAction).not.toHaveBeenCalled();
  });
  it('押せる間は、乗せたときの説明を付けない', () => {
    mount(props({ waiting: [card('s1')] }));
    expect(screen.getByRole('button', { name: '名前 s1 が入力待ちです：問い s1' })).not.toHaveAttribute('title');
  });
});

describe('info と error のトースト', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const info = (id: string, message = `知らせ ${id}`): Toast => ({ id, level: 'info', message });
  const error = (id: string, message = `失敗 ${id}`): Toast => ({ id, level: 'error', message });

  it('info は「お知らせ」、error は「エラー」の見出しを持つ', () => {
    mount(props({ toasts: [info('1'), error('2')] }));
    expect(within(screen.getByRole('status').querySelector<HTMLElement>('.notice-head')!).getByText('お知らせ')).toBeInTheDocument();
    expect(within(screen.getByRole('alert').querySelector<HTMLElement>('.notice-head')!).getByText('エラー')).toBeInTheDocument();
  });
  it('info は role="status" で、時間が来たら消す', () => {
    const { onAction } = mount(props({ toasts: [info('1')] }));
    expect(screen.getByRole('status')).toHaveTextContent('知らせ 1');
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS - 1); });
    expect(onAction).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('時間切れはトーストごとに数える', () => {
    const { onAction, rerender } = mount(props({ toasts: [info('1')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS / 2); });
    rerender(props({ toasts: [info('1'), info('2')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS / 2); });
    expect(onAction.mock.calls).toEqual([[{ type: 'toast.dismiss', id: '1' }]]);
    rerender(props({ toasts: [info('2')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS / 2); });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'toast.dismiss', id: '2' });
  });
  it('マウスを乗せている間は止め、離したら残りの時間で消す', () => {
    const { onAction } = mount(props({ toasts: [info('1')] }));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS - 1000); });
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(INFO_TOAST_MS * 3); });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(999); });
    expect(onAction).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('info は押しても消せる', () => {
    const { onAction } = mount(props({ toasts: [info('1')] }));
    fireEvent.click(screen.getByText('知らせ 1'));
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
  it('error は role="alert" で、時間では消えず、閉じるで消す', () => {
    const { onAction } = mount(props({ toasts: [error('1')] }));
    const alert = screen.getByRole('alert');
    act(() => { vi.advanceTimersByTime(60_000); });
    fireEvent.click(within(alert).getByText('失敗 1'));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
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
