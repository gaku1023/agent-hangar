import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../../action/chain.tsx';
import type { State } from '../../mediator/types.ts';
import { CopiedContext, CopyButton } from './CommandLine.tsx';

function mount(copied: State['copied']) {
  const onAction = vi.fn();
  const ui = (c: State['copied']) => <ActionRoot onAction={onAction}><CopiedContext.Provider value={c}><CopyButton text="tok-abc" name="参加トークン" label="コピー" /></CopiedContext.Provider></ActionRoot>;
  const r = render(ui(copied));
  return { onAction, rerender: (c: State['copied']) => r.rerender(ui(c)) };
}

describe('CopyButton', () => {
  // 写せたかはランタイムが確かめて状態（copied）に返す。押しただけで「コピーしました」を出すと、写せなかったときに嘘になる。
  it('押しただけでは「コピーしました」を出さず、写せた知らせが来てから出す', () => {
    const { onAction, rerender } = mount(null);
    fireEvent.click(screen.getByRole('button', { name: '参加トークン をコピー' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: 'tok-abc' });
    expect(screen.queryByText('コピーしました')).toBeNull();
    rerender({ text: 'tok-abc', n: 1 });
    expect(screen.getByText('コピーしました')).toBeInTheDocument();
  });
  it('別の文を写せた知らせや、押す前の知らせでは出さない', () => {
    const { rerender } = mount({ text: 'tok-abc', n: 3 });
    expect(screen.queryByText('コピーしました')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '参加トークン をコピー' }));
    rerender({ text: 'brew install tmux', n: 4 });
    expect(screen.queryByText('コピーしました')).toBeNull();
  });
});
