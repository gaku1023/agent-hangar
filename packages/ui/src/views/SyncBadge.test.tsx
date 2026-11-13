import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { syncFixture } from '../test/syncProps.ts';
import { SyncStatus } from './SyncStatus.tsx';

const show = (badge: { ask?: number; quiet?: number }, onAction: (i: UiAction) => void = () => {}) => render(
  <ActionRoot onAction={onAction}>
    <SyncStatus {...syncFixture({ badge: { ask: badge.ask ? { n: badge.ask, label: `確認が必要な設定が ${badge.ask} 件あります` } : null, quiet: badge.quiet ? { n: badge.quiet, label: `自動で入った設定が ${badge.quiet} 件あります` } : null } })} />
  </ActionRoot>,
);

describe('ヘッダの設定の同期の札（P1）', () => {
  it('確認の件数と、自動で入った件数を別々の札で出す。0 の札は出さない', () => {
    const { unmount } = show({ ask: 3 });
    expect(screen.getByRole('button', { name: '確認が必要な設定が 3 件あります' })).toHaveAttribute('data-kind', 'ask');
    expect(screen.queryByRole('button', { name: /自動で入った/ })).toBeNull();
    unmount();
    show({ ask: 1, quiet: 2 });
    expect(screen.getByRole('button', { name: '自動で入った設定が 2 件あります' })).toHaveAttribute('data-kind', 'quiet');
  });
  it('札が無い props では何も足さない', () => {
    render(<ActionRoot onAction={() => {}}><SyncStatus {...syncFixture()} /></ActionRoot>);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('押すと設定の同期の節へ移る', () => {
    const onAction = vi.fn();
    show({ ask: 2 }, onAction);
    fireEvent.click(screen.getByRole('button', { name: /確認が必要な設定/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings', at: 'sync' } });
  });
});
