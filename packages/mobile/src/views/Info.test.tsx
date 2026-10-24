import { act, fireEvent, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { InfoButton, InfoPanel, useInfo } from './Info.tsx';

function Harness(): ReactNode {
  const info = useInfo();
  return (
    <section>
      <div className="info-head">
        <h2>接続</h2>
        <InfoButton info={info} label="接続の説明" />
      </div>
      <InfoPanel info={info}>
        <p>30 日使わないと切れます</p>
      </InfoPanel>
    </section>
  );
}

const btn = () => screen.getByRole('button', { name: '接続の説明' });

describe('ⓘ（InfoButton と InfoPanel）', () => {
  it('最初は閉じていて、説明を出さない', () => {
    render(<Harness />);
    expect(btn()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('30 日使わないと切れます')).not.toBeInTheDocument();
  });

  it('押すと見出しの下に伸びて開き（m-grow）、aria-controls が説明の箱を指す', () => {
    render(<Harness />);
    fireEvent.click(btn());
    expect(btn()).toHaveAttribute('aria-expanded', 'true');
    const text = screen.getByText('30 日使わないと切れます');
    const target = document.getElementById(btn().getAttribute('aria-controls')!);
    expect(target).not.toBeNull();
    expect(target).toContainElement(text);
    expect(text.closest('.fold')).toHaveClass('m-grow');
  });

  it('もう一度押すと閉じる（動きが 0 ならすぐ外す）', () => {
    render(<Harness />);
    fireEvent.click(btn());
    fireEvent.click(btn());
    expect(btn()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('30 日使わないと切れます')).not.toBeInTheDocument();
  });

  it('動きの長さがあるときは、畳む動き（m-collapse）の間だけ残してから外す', () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty('--dur-exit', '250ms');
    document.documentElement.style.setProperty('--dur-fast', '200ms');
    try {
      render(<Harness />);
      fireEvent.click(btn());
      fireEvent.click(btn());
      expect(btn()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByText('30 日使わないと切れます').closest('.fold')).toHaveClass('m-collapse');
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryByText('30 日使わないと切れます')).not.toBeInTheDocument();
    } finally {
      document.documentElement.style.removeProperty('--dur-exit');
      document.documentElement.style.removeProperty('--dur-fast');
      vi.useRealTimers();
    }
  });

  it('押す的は 44px 四方を取る（見た目の丸は小さくてよい）', () => {
    const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'styles.css'), 'utf8');
    const rule = /(?:^|\n)\.info-btn \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(rule).toContain('width: 44px');
    expect(rule).toContain('height: 44px');
  });
});
