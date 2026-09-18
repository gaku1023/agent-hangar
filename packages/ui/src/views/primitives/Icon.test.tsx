import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon, ICON_NAMES } from './Icon.tsx';

describe('Icon', () => {
  it('16px、線幅 1.5 の svg を描き、名前を data-icon に出す', () => {
    const { container } = render(<Icon name="fork" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('data-icon')).toBe('fork');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    expect(svg.getAttribute('stroke-width')).toBe('1.5');
    expect(svg.classList.contains('icon')).toBe(true);
  });
  it('ラベルが無ければ飾りとして読み上げから外す', () => {
    const { container } = render(<Icon name="stop" />);
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('ラベルがあれば画像として読み上げる', () => {
    render(<Icon name="warning" label="見つかりません" />);
    const img = screen.getByRole('img', { name: '見つかりません' });
    expect(img.getAttribute('aria-hidden')).toBeNull();
  });
  it('どの名前も描ける', () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      expect(container.querySelector(`svg[data-icon="${name}"]`), name).not.toBeNull();
      unmount();
    }
  });
});
