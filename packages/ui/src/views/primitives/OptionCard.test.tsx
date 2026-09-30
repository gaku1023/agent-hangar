import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CheckCard, OptionCards, type OptionCardItem } from './OptionCard.tsx';

const perms: OptionCardItem[] = [
  { value: '', label: '既定', description: 'Claude Code の設定に従う', icon: 'permissionDefault' },
  { value: 'plan', label: '計画だけ', description: '読むだけで何も変えない', code: 'plan', icon: 'permissionPlan' },
  { value: 'bypassPermissions', label: '確認なし', description: 'すべて確認せずに実行する', code: 'bypassPermissions', icon: 'permissionBypass', danger: true },
];

describe('OptionCards', () => {
  it('radiogroup の中の radio で、名前は label、説明は aria-describedby で読む', () => {
    render(<OptionCards label="permission mode" value="plan" options={perms} onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'permission mode' });
    const plan = within(group).getByRole('radio', { name: '計画だけ' });
    expect(plan).toHaveAttribute('aria-checked', 'true');
    expect(plan).toHaveAccessibleDescription('読むだけで何も変えない');
    expect(plan).toHaveTextContent('plan');
  });
  it('押すと値を渡し、同じ値なら渡さない', () => {
    const onChange = vi.fn();
    render(<OptionCards label="p" value="" options={perms} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '既定' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: '確認なし' }));
    expect(onChange).toHaveBeenCalledWith('bypassPermissions');
  });
  it('danger のカードに data-danger を付ける', () => {
    render(<OptionCards label="p" value="" options={perms} onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: '確認なし' })).toHaveAttribute('data-danger', 'true');
    expect(screen.getByRole('radio', { name: '既定' })).not.toHaveAttribute('data-danger');
  });
});

describe('CheckCard', () => {
  it('checkbox の役割で、名前と説明と印の状態を出す', () => {
    render(<CheckCard label="git init する" description="空のリポジトリを作ってから移します" icon="gitInit" checked onChange={() => {}} />);
    const card = screen.getByRole('checkbox', { name: 'git init する' });
    expect(card).toHaveAttribute('aria-checked', 'true');
    expect(card).toHaveAccessibleDescription('空のリポジトリを作ってから移します');
  });
  it('押すと反転した値を渡し、押せないときは渡さない', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CheckCard label="c" description="d" icon="moveFiles" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'c' }));
    expect(onChange).toHaveBeenCalledWith(true);
    onChange.mockClear();
    rerender(<CheckCard label="c" description="d" icon="moveFiles" checked={false} disabled onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'c' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
