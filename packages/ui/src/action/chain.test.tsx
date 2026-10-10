import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UiAction } from '@agent-hangar/shared';
import { ActionBoundary, ActionRoot, useEmit } from './chain.tsx';

function Button({ action, label }: { action: UiAction; label: string }) {
  const emit = useEmit();
  return <button onClick={() => emit(action)}>{label}</button>;
}

describe('UiAction chain', () => {
  it('View の UiAction は Root に届く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><Button action={{ type: 'palette.open' }} label="open" /></ActionRoot>);
    fireEvent.click(screen.getByText('open'));
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.open' });
  });
  it('中間層が処理した UiAction は上へ渡らず、処理しなかったものは渡る', () => {
    const onAction = vi.fn();
    const handle = vi.fn((i: UiAction) => ({ handled: i.type === 'split.toggle' }));
    render(
      <ActionRoot onAction={onAction}>
        <ActionBoundary handle={handle}>
          <Button action={{ type: 'split.toggle' }} label="split" />
          <Button action={{ type: 'palette.open' }} label="open" />
        </ActionBoundary>
      </ActionRoot>,
    );
    fireEvent.click(screen.getByText('split'));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('open'));
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.open' });
    expect(handle).toHaveBeenCalledTimes(2);
  });
  it('Root の外では何も起きない', () => {
    render(<Button action={{ type: 'palette.open' }} label="open" />);
    expect(() => fireEvent.click(screen.getByText('open'))).not.toThrow();
  });
});
