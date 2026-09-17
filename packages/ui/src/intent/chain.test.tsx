import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Intent } from '@agent-hangar/shared';
import { IntentBoundary, IntentRoot, useEmit } from './chain.tsx';

function Button({ intent, label }: { intent: Intent; label: string }) {
  const emit = useEmit();
  return <button onClick={() => emit(intent)}>{label}</button>;
}

describe('Intent chain', () => {
  it('View の Intent は Root に届く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Button intent={{ type: 'palette.open' }} label="open" /></IntentRoot>);
    fireEvent.click(screen.getByText('open'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.open' });
  });
  it('中間層が処理した Intent は上へ渡らず、処理しなかったものは渡る', () => {
    const onIntent = vi.fn();
    const handle = vi.fn((i: Intent) => ({ handled: i.type === 'split.toggle' }));
    render(
      <IntentRoot onIntent={onIntent}>
        <IntentBoundary handle={handle}>
          <Button intent={{ type: 'split.toggle' }} label="split" />
          <Button intent={{ type: 'palette.open' }} label="open" />
        </IntentBoundary>
      </IntentRoot>,
    );
    fireEvent.click(screen.getByText('split'));
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('open'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.open' });
    expect(handle).toHaveBeenCalledTimes(2);
  });
  it('Root の外では何も起きない', () => {
    render(<Button intent={{ type: 'palette.open' }} label="open" />);
    expect(() => fireEvent.click(screen.getByText('open'))).not.toThrow();
  });
});
