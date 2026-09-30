import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch.tsx';

describe('Switch', () => {
  it('switch の役割と、いまの値を aria-checked に出す', () => {
    render(<Switch label="Claude へ切り替える" checked onChange={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'Claude へ切り替える' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
  it('押すと反転した値を渡す', () => {
    const onChange = vi.fn();
    render(<Switch label="s" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 's' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it('押せないときは値を渡さない', () => {
    const onChange = vi.fn();
    render(<Switch label="s" checked={false} disabled onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 's' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
