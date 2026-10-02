import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePresence } from './usePresence.ts';

function Box(props: { open: boolean; exit: (el: HTMLDivElement) => Promise<unknown> | null }) {
  const p = usePresence<HTMLDivElement>(props.open, props.exit);
  return p.mounted ? <div ref={p.ref} data-testid="box" data-leaving={p.leaving ? 'true' : undefined} /> : null;
}

describe('usePresence', () => {
  it('出る動きが無ければ、閉じた描画で外す', () => {
    const { rerender, queryByTestId } = render(<Box open exit={() => null} />);
    expect(queryByTestId('box')).not.toBeNull();
    rerender(<Box open={false} exit={() => null} />);
    expect(queryByTestId('box')).toBeNull();
  });
  it('出る動きの間は leaving で描き続け、終わったら外す', async () => {
    let done!: () => void;
    const exit = () => new Promise<void>((r) => { done = r; });
    const { rerender, queryByTestId } = render(<Box open exit={exit} />);
    rerender(<Box open={false} exit={exit} />);
    expect(queryByTestId('box')).toHaveAttribute('data-leaving', 'true');
    await act(async () => { done(); });
    expect(queryByTestId('box')).toBeNull();
  });
  it('出る途中で開き直したら、外さずに戻す', async () => {
    let done!: () => void;
    const exit = () => new Promise<void>((r) => { done = r; });
    const { rerender, queryByTestId } = render(<Box open exit={exit} />);
    rerender(<Box open={false} exit={exit} />);
    rerender(<Box open exit={exit} />);
    await act(async () => { done(); });
    expect(queryByTestId('box')).not.toBeNull();
    expect(queryByTestId('box')).not.toHaveAttribute('data-leaving');
  });
  it('最初から閉じていれば何も描かない', () => {
    const { queryByTestId } = render(<Box open={false} exit={() => null} />);
    expect(queryByTestId('box')).toBeNull();
  });
});
