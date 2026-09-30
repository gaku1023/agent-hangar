import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Stepper } from './Stepper.tsx';

describe('Stepper', () => {
  it('数の入力欄を残し、範囲と刻みをそのまま持つ', () => {
    render(<Stepper label="1 時間の上限" value="20" min={1} max={200} onChange={() => {}} />);
    const box = screen.getByLabelText('1 時間の上限') as HTMLInputElement;
    expect(box.type).toBe('number');
    expect([box.min, box.max, box.step]).toEqual(['1', '200', '1']);
  });
  it('− と ＋ で 1 ずつ動かす', () => {
    const onChange = vi.fn();
    render(<Stepper label="上限" value="20" min={1} max={200} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '上限を減らす' }));
    expect(onChange).toHaveBeenLastCalledWith('19');
    fireEvent.click(screen.getByRole('button', { name: '上限を増やす' }));
    expect(onChange).toHaveBeenLastCalledWith('21');
  });
  it('端では止まり、止まった側は押せない', () => {
    const { rerender } = render(<Stepper label="上限" value="1" min={1} max={200} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '上限を減らす' })).toBeDisabled();
    rerender(<Stepper label="上限" value="200" min={1} max={200} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '上限を増やす' })).toBeDisabled();
  });
  it('読めない値からは最小値を起点に動かし、範囲の外からは範囲へ戻す', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Stepper label="上限" value="" min={1} max={200} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '上限を増やす' }));
    expect(onChange).toHaveBeenLastCalledWith('2');
    rerender(<Stepper label="上限" value="500" min={1} max={200} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '上限を減らす' }));
    expect(onChange).toHaveBeenLastCalledWith('199');
  });
  it('打った文字列はそのまま渡す（検め方は呼び出し側が持つ）', () => {
    const onChange = vi.fn();
    render(<Stepper label="上限" value="20" min={1} max={200} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('上限'), { target: { value: '1.5' } });
    expect(onChange).toHaveBeenCalledWith('1.5');
  });
});
