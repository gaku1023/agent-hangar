import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChoiceChips, ToggleChip } from './Chip.tsx';

const models = [{ value: '', label: '既定' }, { value: 'opus', label: 'opus' }, { value: 'sonnet', label: 'sonnet' }];
function Models(props: { initial?: string; onChange?: (v: string) => void }) {
  const [v, setV] = useState(props.initial ?? '');
  return <ChoiceChips label="model" value={v} options={models} other={{ label: 'ほか', placeholder: 'model の名前' }} onChange={(x) => { setV(x); props.onChange?.(x); }} />;
}

describe('ToggleChip', () => {
  it('読み上げの名前と、押した状態を aria-pressed に出す', () => {
    render(<ToggleChip label="思考を表示" text="思考" pressed={false} onChange={() => {}} />);
    const chip = screen.getByRole('button', { name: '思考を表示' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip).toHaveTextContent('思考');
  });
  it('押すと反転した値を渡す', () => {
    const onChange = vi.fn();
    render(<ToggleChip label="生の記録を表示" text="生の記録" pressed onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '生の記録を表示' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('ChoiceChips', () => {
  it('radiogroup の中の radio で、いまの値に aria-checked を付ける', () => {
    render(<Models initial="opus" />);
    const group = screen.getByRole('radiogroup', { name: 'model' });
    expect(within(group).getAllByRole('radio').map((r) => `${r.textContent}:${r.getAttribute('aria-checked')}`)).toEqual(['既定:false', 'opus:true', 'sonnet:false']);
  });
  it('押すと値を渡す', () => {
    const onChange = vi.fn();
    render(<Models onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'sonnet' }));
    expect(onChange).toHaveBeenCalledWith('sonnet');
  });
  it('「ほか」を押すと入力欄に変わってフォーカスが入り、打った名前を渡す', () => {
    const onChange = vi.fn();
    render(<Models initial="opus" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'ほか' }));
    const box = screen.getByRole('textbox', { name: 'model の名前' });
    expect(box).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('');
    fireEvent.change(box, { target: { value: 'claude-opus-5-5' } });
    expect(onChange).toHaveBeenLastCalledWith('claude-opus-5-5');
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });
  it('打った名前を消しても入力欄のまま残り、チップを押すと戻る', () => {
    render(<Models />);
    fireEvent.click(screen.getByRole('button', { name: 'ほか' }));
    const box = screen.getByRole('textbox', { name: 'model の名前' });
    fireEvent.change(box, { target: { value: 'x' } });
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByRole('textbox', { name: 'model の名前' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'opus' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('radio', { name: 'opus' })).toHaveAttribute('aria-checked', 'true');
  });
  it('選択肢に無い値を受け取ったら、最初から入力欄で出す（フォーカスは奪わない）', () => {
    render(<Models initial="claude-haiku-4-5" />);
    const box = screen.getByRole('textbox', { name: 'model の名前' });
    expect(box).toHaveValue('claude-haiku-4-5');
    expect(box).not.toHaveFocus();
  });
});
