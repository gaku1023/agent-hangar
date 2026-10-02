import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { PagerProps } from '../presenters/pager.ts';
import { Pager, pageButtons } from './Pager.tsx';

const props = (over: Partial<PagerProps> = {}): PagerProps => ({ page: 1, pageCount: 25, size: 50, sizes: [25, 50, 100, 200], from: 1, to: 50, total: 1223, ...over });

describe('ページ送りの帯（A4）', () => {
  it('範囲・番号・ページの入力・件数を 1 本の帯に並べる', () => {
    render(<Pager label="セッション" pager={props({ page: 3, from: 101, to: 150 })} onPage={vi.fn()} onSize={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'セッションのページ' });
    expect(within(nav).getByText('101–150')).toBeInTheDocument();
    expect(nav).toHaveTextContent('/ 1,223 件');
    expect(within(nav).getByRole('button', { name: '3 ページ目' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('spinbutton', { name: 'ページの番号' })).toHaveValue(3);
    expect(nav).toHaveTextContent('/ 25');
    expect(within(nav).getByRole('button', { name: '1 ページの件数' })).toHaveTextContent('50 件ずつ');
  });

  it('番号と前後のボタンでページを移る。端では前後が押せない', () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pager label="x" pager={props()} onPage={onPage} onSize={vi.fn()} />);
    expect(screen.getByRole('button', { name: '前のページ' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '次のページ' }));
    expect(onPage).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: '25 ページ目' }));
    expect(onPage).toHaveBeenLastCalledWith(25);
    rerender(<Pager label="x" pager={props({ page: 25, from: 1201, to: 1223 })} onPage={onPage} onSize={vi.fn()} />);
    expect(screen.getByRole('button', { name: '次のページ' })).toBeDisabled();
  });

  it('ページの番号を打って Enter で跳ぶ。範囲の外は端に丸める', () => {
    const onPage = vi.fn();
    render(<Pager label="x" pager={props()} onPage={onPage} onSize={vi.fn()} />);
    const input = screen.getByRole('spinbutton', { name: 'ページの番号' });
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPage).toHaveBeenLastCalledWith(12);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPage).toHaveBeenLastCalledWith(25);
  });

  it('件数を選ぶ', () => {
    const onSize = vi.fn();
    render(<Pager label="x" pager={props()} onPage={vi.fn()} onSize={onSize} />);
    fireEvent.click(screen.getByRole('button', { name: '1 ページの件数' }));
    fireEvent.click(screen.getByRole('option', { name: '100 件ずつ' }));
    expect(onSize).toHaveBeenCalledWith(100);
  });

  it('番号は両端と前後 1 つを残し、間は … で詰める', () => {
    expect(pageButtons(1, 25)).toEqual([1, 2, 3, 4, '…', 25]);
    expect(pageButtons(12, 25)).toEqual([1, '…', 11, 12, 13, '…', 25]);
    expect(pageButtons(25, 25)).toEqual([1, '…', 22, 23, 24, 25]);
    expect(pageButtons(2, 3)).toEqual([1, 2, 3]);
  });
});
