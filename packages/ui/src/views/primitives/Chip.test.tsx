import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { LanguageRoot } from './language.tsx';
import { ChoiceChips, CountChip, SettingChip, ToggleChip } from './Chip.tsx';

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
  it('「ほか」から打った名前が選択肢に有る値に達しても、入力欄は消えず、テキストも消えない', () => {
    const onChange = vi.fn();
    render(<Models onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'ほか' }));
    const box = screen.getByRole('textbox', { name: 'model の名前' });
    fireEvent.change(box, { target: { value: 'opus' } });
    expect(box).toHaveValue('opus');
    expect(onChange).toHaveBeenLastCalledWith('opus');
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });
});

describe('CountChip（数の札）', () => {
  it('押せないときは、名前と数を読むだけの札で、ボタンにしない', () => {
    render(<CountChip label="確認待ち" count={3} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('確認待ち').closest('.count-chip')).toHaveTextContent('確認待ち 3');
    expect(screen.getByText('3')).toHaveAttribute('data-count', 'true');
  });
  it('押せるときはボタンで、名前に数が入る。押すと呼ぶ', () => {
    const onClick = vi.fn();
    render(<CountChip label="要対応" count={4} onClick={onClick} />);
    const chip = screen.getByRole('button', { name: '要対応 4' });
    expect(chip).toHaveAttribute('type', 'button');
    expect(chip).not.toHaveAttribute('aria-expanded');
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('expanded を渡すと aria-expanded に出し、矢印は閉じていれば右、開いていれば下を向く', () => {
    const { rerender } = render(<CountChip label="実行中" count={2} expanded={false} onClick={() => {}} />);
    const chip = screen.getByRole('button', { name: '実行中 2' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip.querySelector('[data-icon="chevron"]')).not.toBeNull();
    rerender(<CountChip label="実行中" count={2} expanded onClick={() => {}} />);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(chip.querySelector('[data-icon="chevronDown"]')).not.toBeNull();
  });
  it('数が 0 なら薄い印を付ける。色の調子と大きさは属性で出す', () => {
    render(<CountChip label="確認待ち" count={0} tone="cand" size="sm" icon="check" />);
    const chip = screen.getByText('確認待ち', { exact: false }).closest('.count-chip')!;
    expect(chip).toHaveAttribute('data-zero', 'true');
    expect(chip).toHaveAttribute('data-tone', 'cand');
    expect(chip).toHaveAttribute('data-size', 'sm');
    expect(chip.querySelector('[data-icon="check"]')).not.toBeNull();
  });
  it('lead を渡すと、アイコンの代わりに名前の前へ置く（状態の灯など）。読み上げの名前は変わらない', () => {
    render(<CountChip label="サブエージェント" count={2} icon="agent" lead={<span data-testid="lamp" />} onClick={() => {}} />);
    const chip = screen.getByRole('button', { name: 'サブエージェント 2' });
    expect(within(chip).getByTestId('lamp')).toBeInTheDocument();
    expect(chip.querySelector('[data-icon="agent"]')).toBeNull();
  });
  it('開く元として使える：Popover の渡す属性と ref を受ける', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<CountChip ref={ref} label="サブエージェント" count={2} aria-haspopup="dialog" aria-expanded={false} onClick={() => {}} />);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'サブエージェント 2' }));
    expect(ref.current).toHaveAttribute('aria-haspopup', 'dialog');
  });
});

describe('SettingChip（設定の札）', () => {
  it('値を見せ、読み上げの名前に項目の名前と値を入れる', () => {
    render(<SettingChip name="権限モード" value="Accept edits" onClick={() => {}} />);
    const chip = screen.getByRole('button', { name: '権限モード、Accept edits' });
    expect(chip).toHaveTextContent('Accept edits');
    expect(chip).not.toHaveTextContent('権限モード');
  });
  it('showName なら、名前も見える文字にする', () => {
    render(<SettingChip name="モデル" value="opus" showName onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'モデル、opus' })).toHaveTextContent('モデルopus');
  });
  it('English では名前と値のあいだの区切りが替わる', () => {
    render(<LanguageRoot language="en"><SettingChip name="Model" value="opus" onClick={() => {}} /></LanguageRoot>);
    expect(screen.getByRole('button', { name: 'Model: opus' })).toBeInTheDocument();
  });
  it('押すと呼び、開く元として aria-expanded と ref を受ける', () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(<SettingChip ref={ref} name="worktree" value="なし" aria-haspopup="dialog" aria-expanded={true} onClick={onClick} />);
    const chip = screen.getByRole('button', { name: 'worktree、なし' });
    expect(ref.current).toBe(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('既定のままの札は muted、危険な値の札は danger を属性で出す', () => {
    const { rerender } = render(<SettingChip name="モデル" value="既定" tone="muted" onClick={() => {}} />);
    expect(screen.getByRole('button')).toHaveAttribute('data-tone', 'muted');
    rerender(<SettingChip name="権限モード" value="Bypass permissions" tone="danger" onClick={() => {}} />);
    expect(screen.getByRole('button')).toHaveAttribute('data-tone', 'danger');
  });
  it('disabled のときは押せない', () => {
    const onClick = vi.fn();
    render(<SettingChip name="モデル" value="opus" disabled onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
