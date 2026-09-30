import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Segmented } from './Segmented.tsx';

const periods = [{ value: '', label: '全期間' }, { value: '1', label: '今日' }, { value: '7', label: '7 日' }];

describe('Segmented', () => {
  it('radiogroup の中に radio を並べ、いまの値に aria-checked を付ける', () => {
    render(<Segmented label="期間" value="1" options={periods} onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: '期間' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['全期間', '今日', '7 日']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  });
  it('選んだ項目だけが Tab で届く', () => {
    render(<Segmented label="期間" value="7" options={periods} onChange={() => {}} />);
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });
  it('どれも選ばれていなければ、先頭が Tab で届く', () => {
    render(<Segmented label="期間" value="3" options={periods} onChange={() => {}} />);
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });
  it('押すと値を渡し、同じ値なら渡さない', () => {
    const onChange = vi.fn();
    render(<Segmented label="期間" value="" options={periods} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '全期間' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: '7 日' }));
    expect(onChange).toHaveBeenCalledWith('7');
  });
  it('← → で隣へ選び直し、端では反対の端へ回る', () => {
    const onChange = vi.fn();
    render(<Segmented label="期間" value="" options={periods} onChange={onChange} />);
    const group = screen.getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('1');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('7');
  });
  it('先頭の飾りは読み上げの名前に入れない', () => {
    render(<Segmented label="状態" value="" options={[{ value: '', label: 'すべて' }, { value: 'r', label: '実行中', lead: <span className="st-dot" /> }]} onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: '実行中' })).toBeInTheDocument();
  });
});
