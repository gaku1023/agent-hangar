import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePresence } from './usePresence.ts';

function Box(props: { open: boolean; exit: (el: HTMLDivElement) => Promise<unknown> | null }) {
  const p = usePresence<HTMLDivElement>(props.open, props.exit);
  return p.mounted ? <div ref={p.ref} data-testid="box" data-leaving={p.leaving ? 'true' : undefined} /> : null;
}

afterEach(() => {
  delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  delete (globalThis as { CSSAnimation?: unknown }).CSSAnimation;
  delete (globalThis as { CSSTransition?: unknown }).CSSTransition;
});

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
  it('出る途中で開き直したら、出る動きを取り消す（最後の形を残さない）', async () => {
    const cancel = vi.fn();
    const getAnimations = vi.fn(() => [{ cancel }]);
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = getAnimations;
    const exit = () => new Promise<void>(() => {});
    const { rerender } = render(<Box open exit={exit} />);
    rerender(<Box open exit={exit} />);
    expect(cancel).not.toHaveBeenCalled();
    rerender(<Box open={false} exit={exit} />);
    expect(cancel).not.toHaveBeenCalled();
    rerender(<Box open exit={exit} />);
    expect(getAnimations).toHaveBeenCalledWith({ subtree: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('開き直して取り消すのは Web Animations だけで、CSS の animation と transition（灯の脈など）は止めない', () => {
    class FakeCSSAnimation { cancel = vi.fn(); }
    class FakeCSSTransition { cancel = vi.fn(); }
    (globalThis as { CSSAnimation?: unknown }).CSSAnimation = FakeCSSAnimation;
    (globalThis as { CSSTransition?: unknown }).CSSTransition = FakeCSSTransition;
    const css = new FakeCSSAnimation();
    const tr = new FakeCSSTransition();
    const web = { cancel: vi.fn() };
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [css, tr, web];
    const exit = () => new Promise<void>(() => {});
    const { rerender } = render(<Box open exit={exit} />);
    rerender(<Box open={false} exit={exit} />);
    rerender(<Box open exit={exit} />);
    expect(web.cancel).toHaveBeenCalledTimes(1);
    expect(css.cancel).not.toHaveBeenCalled();
    expect(tr.cancel).not.toHaveBeenCalled();
  });
});
