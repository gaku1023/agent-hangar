import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { HeldEventsCardProps } from '../presenters/heldEvents.ts';
import type { ToastsProps } from '../presenters/toasts.ts';
import { ToastStack } from './ToastStack.tsx';

const card = (over: Partial<HeldEventsCardProps> = {}): HeldEventsCardProps => ({
  head: '閉じている間に 4 件のイベントが届きました',
  groups: [
    { bindingId: 'b1', label: 'octo/demo #7', count: 3, items: [{ text: 'CI 完了', at: '2026-11-10 09:00' }, { text: 'CI 失敗', at: '2026-11-10 09:05' }, { text: 'マージ', at: '2026-11-10 09:10' }] },
    { bindingId: 'b2', label: 'webhook', count: 1, items: [{ text: 'webhook', at: '2026-11-10 09:12' }] },
  ],
  ...over,
});
const props = (over: Partial<ToastsProps> = {}): ToastsProps => ({ toasts: [], waiting: [], more: 0, blocked: false, arrived: null, update: null, whatsNew: null, join: null, phoneUndo: null, phoneLaunches: [], ...over });
function mount(p: ToastsProps) {
  const onAction = vi.fn();
  const r = render(<ActionRoot onAction={onAction}><ToastStack {...p} /></ActionRoot>);
  return { onAction, rerender: (q: ToastsProps) => r.rerender(<ActionRoot onAction={onAction}><ToastStack {...q} /></ActionRoot>) };
}

afterEach(() => { vi.useRealTimers(); });

describe('溜まったイベントの札', () => {
  it('does not send twice while the first send is in flight, and works again after a failed send', () => {
    vi.useFakeTimers();
    const { onAction } = mount(props({ heldEvents: card() }));
    const runAll = screen.getByRole('button', { name: 'すべて実行' });
    fireEvent.click(runAll);
    fireEvent.click(runAll);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(runAll).toBeDisabled();
    expect(screen.getByRole('button', { name: '選ぶ' })).toBeDisabled();
    // 送れずに札が残ったときは、もう一度押せる。
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('button', { name: 'すべて実行' })).toBeEnabled();
  });
  it('card appears only when held events exist', () => {
    const { rerender } = mount(props({ heldEvents: null }));
    expect(screen.queryByText(/件のイベントが届きました/)).toBeNull();
    rerender(props({ heldEvents: card() }));
    expect(screen.getByText('閉じている間に 4 件のイベントが届きました')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'すべて実行' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '選ぶ' })).toBeInTheDocument();
    // モーダルにしない（背面を覆わず、ダイアログの役も持たない）。
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('run all sends latest for every binding', () => {
    const { onAction } = mount(props({ heldEvents: card() }));
    fireEvent.click(screen.getByRole('button', { name: 'すべて実行' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'heldEvents.run', choices: [{ bindingId: 'b1', mode: 'latest' }, { bindingId: 'b2', mode: 'latest' }] });
    expect(onAction).toHaveBeenCalledTimes(1);
  });
  it('choose expands grouped list and sends chosen modes', () => {
    const { onAction } = mount(props({ heldEvents: card() }));
    expect(screen.queryByText('octo/demo #7')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '選ぶ' }));
    // 結び付けごとに畳んだ群。群の見出しに名前と件数、選びは「最新のみ / すべて / 実行しない」。
    const g1 = screen.getByRole('group', { name: 'octo/demo #7' });
    expect(within(g1).getByText('3')).toBeInTheDocument();
    expect(within(g1).getByRole('button', { name: '最新のみ' })).toHaveAttribute('aria-pressed', 'true');
    // 選ぶボタンと「すべて実行」は、広げたあとは「今すぐ実行」に替わる。
    expect(screen.queryByRole('button', { name: 'すべて実行' })).toBeNull();
    fireEvent.click(within(g1).getByRole('button', { name: 'すべて' }));
    expect(within(g1).getByRole('button', { name: 'すべて' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(g1).getByRole('button', { name: '最新のみ' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(within(screen.getByRole('group', { name: 'webhook' })).getByRole('button', { name: '実行しない' }));
    fireEvent.click(screen.getByRole('button', { name: '今すぐ実行' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'heldEvents.run', choices: [{ bindingId: 'b1', mode: 'all' }, { bindingId: 'b2', mode: 'skip' }] });
  });
  it('選びは、山が読み直されても残る。新しく増えた結び付けは最新のみから始める', () => {
    const { onAction, rerender } = mount(props({ heldEvents: card() }));
    fireEvent.click(screen.getByRole('button', { name: '選ぶ' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'octo/demo #7' })).getByRole('button', { name: 'すべて' }));
    const more = card();
    rerender(props({ heldEvents: card({ groups: [...more.groups, { bindingId: 'b3', label: 'octo/other #2', count: 1, items: [{ text: 'レビュー', at: '2026-11-10 09:20' }] }] }) }));
    fireEvent.click(screen.getByRole('button', { name: '今すぐ実行' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'heldEvents.run', choices: [{ bindingId: 'b1', mode: 'all' }, { bindingId: 'b2', mode: 'latest' }, { bindingId: 'b3', mode: 'latest' }] });
  });
  it('見出しを押すと、広げた群を畳める', () => {
    mount(props({ heldEvents: card() }));
    const choose = screen.getByRole('button', { name: '選ぶ' });
    fireEvent.click(choose);
    expect(screen.getByRole('group', { name: 'webhook' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /閉じている間に 4 件/ }));
    expect(screen.queryByRole('group', { name: 'webhook' })).toBeNull();
  });
});
