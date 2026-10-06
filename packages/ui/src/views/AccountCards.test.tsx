import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { presentAccounts, type AccountView } from '../presenters/accounts.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { AccountCards } from './AccountCards.tsx';

const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const list = presentAccounts({ ...initialStore(), accounts: accountsFixture }, NOW);
/** 2 件のうち、指定の id の認証だけを替えた一覧。 */
const withAuth = (id: string, auth: AccountView['auth']): AccountView[] => list.map((a) => (a.id === id ? { ...a, auth } : a));
const third: AccountView = { ...list[1]!, id: 'a2', name: '個人', color: '#1f7a4d' };

const mount = (value: string, options = list, onChange = vi.fn()) => {
  render(<AccountCards label="アカウント" value={value} options={options} onChange={onChange} />);
  return { onChange, group: screen.getByRole('radiogroup', { name: 'アカウント' }) };
};

describe('AccountCards', () => {
  it('アカウントごとに 1 枚の札（radio）を、radiogroup の中に出す', () => {
    const { group } = mount('primary');
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(within(group).getByRole('radio', { name: /会社/ })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: /大学/ })).toBeInTheDocument();
  });
  it('札の中身は AccountMeters で、色の点と名前と使用率の棒を持ち、枠が戻る時刻は添えない', () => {
    mount('primary');
    const company = screen.getByRole('radio', { name: /会社/ });
    expect(company.querySelector('.st-dot')).toHaveStyle({ color: '#2a57b8' });
    expect(within(company).getByRole('meter', { name: '会社 5 時間枠の使用率' })).toHaveAttribute('aria-valuenow', '82');
    expect(company).not.toHaveTextContent('に戻る');
  });
  it('選んだ札だけが aria-checked で、roving の tabIndex も選んだ札に付く', () => {
    mount('a1');
    expect(screen.getByRole('radio', { name: /大学/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /会社/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /大学/ })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: /会社/ })).toHaveAttribute('tabindex', '-1');
  });
  it('押すと id を渡し、選んでいる札を押しても渡さない', () => {
    const { onChange } = mount('primary');
    fireEvent.click(screen.getByRole('radio', { name: /会社/ }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: /大学/ }));
    expect(onChange).toHaveBeenCalledWith('a1');
  });
  it('矢印キーで隣の札へ移り（選んで、フォーカスも送る）、端では反対の端へ回る', () => {
    const { onChange, group } = mount('primary', [...list, third]);
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('a1');
    expect(screen.getByRole('radio', { name: /大学/ })).toHaveFocus();
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('a2');
    expect(screen.getByRole('radio', { name: /個人/ })).toHaveFocus();
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('a1');
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('a2');
  });
  it('⌘ や Ctrl や Alt を押した矢印は、選び直しに使わない', () => {
    const { onChange, group } = mount('primary');
    for (const mod of ['metaKey', 'ctrlKey', 'altKey']) fireEvent.keyDown(group, { key: 'ArrowRight', [mod]: true });
    expect(onChange).not.toHaveBeenCalled();
  });
  it('未ログインの札は aria-disabled で、押しても渡さない。理由は札の中身が「未ログイン」と言う', () => {
    const { onChange } = mount('primary', withAuth('a1', 'out'));
    const univ = screen.getByRole('radio', { name: /大学/ });
    expect(univ).toHaveAttribute('aria-disabled', 'true');
    expect(univ).toHaveTextContent('未ログイン');
    fireEvent.click(univ);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /会社/ })).not.toHaveAttribute('aria-disabled');
  });
  it('ログインの途中の札も選べない。まだ読めていない札（unknown）は選べる', () => {
    const { onChange } = mount('primary', withAuth('a1', 'running'));
    expect(screen.getByRole('radio', { name: /大学/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /大学/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
  it('unknown の札は選べる', () => {
    const { onChange } = mount('primary', withAuth('a1', 'unknown'));
    expect(screen.getByRole('radio', { name: /大学/ })).not.toHaveAttribute('aria-disabled');
    fireEvent.click(screen.getByRole('radio', { name: /大学/ }));
    expect(onChange).toHaveBeenCalledWith('a1');
  });
  it('矢印キーは選べない札を飛ばす。ほかに選べる札が無ければ何もしない', () => {
    const { onChange, group } = mount('primary', [list[0]!, { ...list[1]!, auth: 'out' }, third]);
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('a2');
    onChange.mockClear();
    document.body.innerHTML = '';
    const only = mount('primary', withAuth('a1', 'out'));
    fireEvent.keyDown(only.group, { key: 'ArrowRight' });
    expect(only.onChange).not.toHaveBeenCalled();
  });
  it('上限が近い札と値が古い札は、札の中の一言（注記）を持つ', () => {
    const { group } = mount('primary', [{ ...list[0]!, note: { tone: 'warn', text: 'まもなく上限。14:20 に戻ります' } }, { ...list[1]!, note: { tone: 'stale', text: '3 時間前の値' } }]);
    expect(within(within(group).getByRole('radio', { name: /会社/ })).getByText('まもなく上限。14:20 に戻ります')).toHaveAttribute('data-tone', 'warn');
    expect(within(within(group).getByRole('radio', { name: /大学/ })).getByText('3 時間前の値')).toHaveAttribute('data-tone', 'stale');
  });
});
