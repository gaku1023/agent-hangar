import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../../test/motion.ts';
import { StatusDot } from './StatusDot.tsx';

describe('StatusDot', () => {
  let restore = () => {};
  const animate = vi.fn();
  beforeEach(() => { restore = fakeMotionTokens(); (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate; });
  afterEach(() => { restore(); animate.mockReset(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

  it('状態が変わる瞬間に 1 度だけ膨らむ。最初の描画と、同じ状態の描き直しでは膨らまない', () => {
    const { rerender, container } = render(<StatusDot status="busy" />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<StatusDot status="busy" />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<StatusDot status="waiting" />);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(container.querySelector('.dot'));
    expect(animate.mock.calls[0]![1]).toEqual({ duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    rerender(<StatusDot status={null} />);
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it('許可待ちは盾、使用制限は砂時計の印にし、読み上げの名前も理由の語にする。リセット済みは入力待ちの点', () => {
    const { container, rerender } = render(<StatusDot status="waiting" reason="permission" />);
    const dot = () => container.querySelector('.dot')!;
    expect(dot().getAttribute('data-reason')).toBe('permission');
    expect(dot().querySelector('svg')).not.toBeNull();
    expect(dot().getAttribute('aria-label')).toBe('許可待ち');
    rerender(<StatusDot status="idle" reason="limit" />);
    expect(dot().getAttribute('data-reason')).toBe('limit');
    expect(dot().querySelector('svg')).not.toBeNull();
    expect(dot().getAttribute('aria-label')).toBe('使用制限');
    rerender(<StatusDot status="waiting" reason="reset" />);
    expect(dot().querySelector('svg')).toBeNull();
    expect(dot().getAttribute('aria-label')).toBe('リセット済み');
    // 印が変わる瞬間も 1 度だけ膨らむ。
    expect(animate).toHaveBeenCalled();
  });
});
