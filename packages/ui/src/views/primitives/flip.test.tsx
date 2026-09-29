import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../../test/motion.ts';
import { useFlip } from './flip.ts';

function Cards(props: { keys: string[] }) {
  const ref = useFlip(props.keys);
  return <div>{props.keys.map((k) => <div key={k} data-k={k} ref={ref(k)} />)}</div>;
}

describe('useFlip', () => {
  let restore = () => {};
  const animate = vi.fn();
  beforeEach(() => { restore = fakeMotionTokens(); (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate; });
  afterEach(() => { restore(); animate.mockReset(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

  it('新しく入った札だけが、ぼかしから現れる。最初の描画では動かさない', () => {
    const { rerender, container } = render(<Cards keys={['a', 'b']} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Cards keys={['a', 'b', 'c']} />);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(container.querySelector('[data-k="c"]'));
    const [frames, opts] = animate.mock.calls[0]!;
    expect(frames[0]).toEqual({ opacity: 0, transform: 'translateY(6px)', filter: 'blur(6px)' });
    // ぼかしは 20% で晴らし切る（WebKit が細いぼかしを 1px に丸め、もやが終わりまで残るため）。
    expect(frames[1]).toEqual({ offset: 0.2, filter: 'none' });
    expect(opts).toEqual({ duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  });
});
