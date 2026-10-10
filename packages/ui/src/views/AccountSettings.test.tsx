import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountDto, AccountsDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentAccounts } from '../presenters/accounts.ts';
import { ACCOUNT_COLORS, type SettingsProps } from '../presenters/settings.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { AccountSettings } from './AccountSettings.tsx';

const NOW = new Date(2026, 9, 6, 12, 0).getTime();

/** 固定データの 2 件（会社が最初でいま、大学）に、アカウントごとの上書きを重ねて描く形にする。 */
function props(over: Record<string, Partial<AccountDto>> = {}, currentId = 'primary'): SettingsProps['accounts'] {
  const dto: AccountsDto = { ...accountsFixture, currentId, accounts: accountsFixture.accounts.map((a) => ({ ...a, ...over[a.id] })) };
  return { list: presentAccounts({ ...initialStore(), accounts: dto }, NOW), colors: ACCOUNT_COLORS };
}
const mount = (p: SettingsProps['accounts'] = props()) => {
  const onAction = vi.fn();
  render(<ActionRoot onAction={onAction}><AccountSettings {...p} /></ActionRoot>);
  return onAction;
};
/** 名前を直している間は名前が欄になるので、行は「⋯」の名前から探す。 */
const row = (name: string) => screen.getByRole('button', { name: `${name}の操作` }).closest('li')!;
/** 行の「⋯」を開いて、項目を押す。メニューは body の portal に出る。 */
const choose = (name: string, item: string | RegExp) => {
  fireEvent.click(within(row(name)).getByRole('button', { name: `${name}の操作` }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
};

describe('AccountSettings の一覧', () => {
  it('2 件を並べ、いまのアカウントに「いま」を添える。最初のアカウントの文字は行に出さない（外せない理由はメニューが言う）', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'アカウント' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((li) => li.querySelector('.account-set-name')?.textContent)).toEqual(['会社', '大学']);
    expect(within(row('会社')).getByText('いま')).toBeInTheDocument();
    expect(within(row('大学')).queryByText('いま')).toBeNull();
    expect(screen.queryByText('最初のアカウント')).toBeNull();
  });
  it('いまのアカウントが大学なら「いま」は大学に付く', () => {
    mount(props({}, 'a1'));
    expect(within(row('大学')).getByText('いま')).toBeInTheDocument();
    expect(within(row('会社')).queryByText('いま')).toBeNull();
  });
  it('点は 8px の色の点で、名前の前に置き、頭文字の四角い印は作らない', () => {
    mount();
    const dot = row('大学').querySelector('.st-dot');
    expect(dot).toHaveStyle({ color: '#7a4a9e' });
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(document.querySelector('.ac-sq')).toBeNull();
  });
  it('置き場は等幅で、ホームの下なら ~ で始まる形に縮め、下でなければそのまま出す', () => {
    mount(props({ primary: { dir: '/Users/taro/.claude' }, a1: { dir: '/srv/claude-univ' } }));
    expect(within(row('会社')).getByText('~/.claude')).toHaveClass('mono');
    expect(within(row('大学')).getByText('/srv/claude-univ')).toHaveClass('mono');
  });
  it('1 件だけでも節を出し、追加の入口を持つ（この節だけが追加の入口）', () => {
    mount({ list: props().list.slice(0, 1), colors: ACCOUNT_COLORS });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '追加してログイン' })).toBeInTheDocument();
  });
  it('説明の 1 行を出す', () => {
    mount();
    expect(screen.getByText('Claude Code のアカウントを足すと、設定・スキル・履歴は共有したまま、ログインだけを切り替えられます。hangar はログインの中身を読みません。')).toBeInTheDocument();
  });
});

describe('AccountSettings の状態', () => {
  it('未読は空、未ログインは「未ログイン」と出す', () => {
    mount(props({ primary: { auth: null }, a1: { auth: { loggedIn: false, email: null, plan: null, orgName: null, checkedAt: 1 } } }));
    expect(row('会社').querySelector('.account-set-state')).toHaveTextContent(/^$/);
    expect(row('大学').querySelector('.account-set-state')).toHaveTextContent('未ログイン');
  });
  it('ログイン済みは「プラン・メール」と出す', () => {
    mount();
    expect(row('会社').querySelector('.account-set-state')).toHaveTextContent('Max・taro@example.co.jp');
    expect(row('大学').querySelector('.account-set-state')).toHaveTextContent('Enterprise・taro@example.ac.jp');
  });
  it('ログインし直しの途中は、プランとメールを出したまま「ブラウザで承認してください…」を添える', () => {
    mount(props({ a1: { loginRunning: true } }));
    const state = row('大学').querySelector('.account-set-state')!;
    expect(state).toHaveTextContent('Enterprise・taro@example.ac.jp');
    expect(state).toHaveTextContent('ブラウザで承認してください…');
  });
  it('初めてのログインの途中は「ブラウザで承認してください…」だけを出し、「やめる」を押すと account.login.cancel を出す', () => {
    const onAction = mount(props({ a1: { loginRunning: true, auth: { loggedIn: false, email: null, plan: null, orgName: null, checkedAt: 1 } } }));
    expect(row('大学').querySelector('.account-set-state')).toHaveTextContent(/^ブラウザで承認してください…$/);
    fireEvent.click(within(row('大学')).getByRole('button', { name: 'やめる' }));
    expect(onAction.mock.calls).toEqual([[{ type: 'account.login.cancel', accountId: 'a1' }]]);
    // 途中の行には「ログイン」を出さない。
    expect(within(row('大学')).queryByRole('button', { name: 'ログイン' })).toBeNull();
  });
  it('途中でない行には「やめる」を出さない', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'やめる' })).toBeNull();
  });
  it('未ログインの行には「ログイン」を直に出し、押すと account.login を出す', () => {
    const onAction = mount(props({ a1: { auth: { loggedIn: false, email: null, plan: null, orgName: null, checkedAt: 1 } } }));
    expect(within(row('会社')).queryByRole('button', { name: 'ログイン' })).toBeNull();
    fireEvent.click(within(row('大学')).getByRole('button', { name: 'ログイン' }));
    expect(onAction.mock.calls).toEqual([[{ type: 'account.login', accountId: 'a1' }]]);
  });
  it('ログイン済みの行は、メニューの「ログインし直す」で account.login を出す', () => {
    const onAction = mount();
    choose('大学', 'ログインし直す');
    expect(onAction.mock.calls).toEqual([[{ type: 'account.login', accountId: 'a1' }]]);
  });
  it('メニューの「状態を読み直す」で account.refresh を出す', () => {
    const onAction = mount();
    choose('大学', '状態を読み直す');
    expect(onAction.mock.calls).toEqual([[{ type: 'account.refresh', accountId: 'a1' }]]);
  });
  it('linkProblem があれば、その行の下に注意の色で 1 行出す', () => {
    mount(props({ a1: { linkProblem: 'skills がリンクでなく実体のディレクトリです' } }));
    const problem = within(row('大学')).getByText('skills がリンクでなく実体のディレクトリです');
    expect(problem).toHaveClass('account-set-problem');
    expect(within(row('会社')).queryByText('skills がリンクでなく実体のディレクトリです')).toBeNull();
  });
});

describe('AccountSettings の「ログイン」と「やめる」の入れ替わり', () => {
  afterEach(() => { vi.useRealTimers(); });
  const OUT = { loggedIn: false, email: null, plan: null, orgName: null, checkedAt: 1 };
  const mountSwap = (before: Record<string, Partial<AccountDto>>) => {
    const onAction = vi.fn();
    const ui = (p: SettingsProps['accounts']) => <ActionRoot onAction={onAction}><AccountSettings {...p} /></ActionRoot>;
    const view = render(ui(props(before)));
    return { onAction, swap: (after: Record<string, Partial<AccountDto>>) => view.rerender(ui(props(after))) };
  };
  it('「ログイン」を押して「やめる」へ入れ替わった直後は押せず、時間が過ぎると押せる', () => {
    vi.useFakeTimers();
    const { onAction, swap } = mountSwap({ a1: { auth: OUT } });
    fireEvent.click(within(row('大学')).getByRole('button', { name: 'ログイン' }));
    expect(onAction.mock.calls).toEqual([[{ type: 'account.login', accountId: 'a1' }]]);
    swap({ a1: { auth: OUT, loginRunning: true } });
    const stop = within(row('大学')).getByRole('button', { name: 'やめる' });
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(onAction).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(599); });
    expect(stop).toBeDisabled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(onAction.mock.calls[1]).toEqual([{ type: 'account.login.cancel', accountId: 'a1' }]);
  });
  it('逆向きも同じで、「やめる」を押して「ログイン」へ戻った直後は押せない', () => {
    vi.useFakeTimers();
    const { onAction, swap } = mountSwap({ a1: { auth: OUT, loginRunning: true } });
    expect(within(row('大学')).getByRole('button', { name: 'やめる' })).toBeEnabled();
    fireEvent.click(within(row('大学')).getByRole('button', { name: 'やめる' }));
    swap({ a1: { auth: OUT } });
    const login = within(row('大学')).getByRole('button', { name: 'ログイン' });
    expect(login).toBeDisabled();
    fireEvent.click(login);
    expect(onAction).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(600); });
    expect(login).toBeEnabled();
  });
  it('はじめから出ているボタンは押せる（入れ替わっていない）', () => {
    mount(props({ a1: { auth: OUT } }));
    expect(within(row('大学')).getByRole('button', { name: 'ログイン' })).toBeEnabled();
  });
});

describe('AccountSettings の名前を変える', () => {
  it('メニューから、その行の名前がその場の入力欄になり、Enter で account.update { name } を出す', () => {
    const onAction = mount();
    choose('大学', '名前を変える');
    const input = within(row('大学')).getByRole('textbox', { name: '大学の名前' });
    expect(input).toHaveValue('大学');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '研究室' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction.mock.calls).toEqual([[{ type: 'account.update', accountId: 'a1', name: '研究室' }]]);
    expect(within(row('大学')).queryByRole('textbox')).toBeNull();
  });
  it('欄を出ると、変えていれば保存する', () => {
    const onAction = mount();
    choose('大学', '名前を変える');
    const input = within(row('大学')).getByRole('textbox', { name: '大学の名前' });
    fireEvent.change(input, { target: { value: '研究室' } });
    fireEvent.blur(input);
    expect(onAction.mock.calls).toEqual([[{ type: 'account.update', accountId: 'a1', name: '研究室' }]]);
  });
  it('Esc ではやめて、何も出さない（欄を出ても保存しない）', () => {
    const onAction = mount();
    choose('大学', '名前を変える');
    const input = within(row('大学')).getByRole('textbox', { name: '大学の名前' });
    fireEvent.change(input, { target: { value: '研究室' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(onAction).not.toHaveBeenCalled();
    expect(within(row('大学')).queryByRole('textbox')).toBeNull();
    expect(row('大学').querySelector('.account-set-name')).toHaveTextContent('大学');
  });
  it('名前が変わっていなければ、空にしたときは送らずに欄を閉じる', () => {
    const onAction = mount();
    choose('大学', '名前を変える');
    fireEvent.keyDown(within(row('大学')).getByRole('textbox'), { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
    choose('大学', '名前を変える');
    const input = within(row('大学')).getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('変換中の Enter では確定しない', () => {
    const onAction = mount();
    choose('大学', '名前を変える');
    const input = within(row('大学')).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'けんきゅう' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('AccountSettings の色を変える', () => {
  it('メニューから、5 色の点が並ぶ帯がその行に出て、押すと account.update { color } を出す', () => {
    const onAction = mount();
    expect(within(row('大学')).queryByRole('radiogroup')).toBeNull();
    choose('大学', '色を変える');
    const band = within(row('大学')).getByRole('radiogroup', { name: '大学の色' });
    const dots = within(band).getAllByRole('radio');
    expect(dots).toHaveLength(5);
    dots.forEach((d, i) => expect(d.querySelector('.st-dot')).toHaveStyle({ color: ACCOUNT_COLORS[i]! }));
    // 選んでいる色（紫）に印が付く。
    expect(dots.filter((d) => d.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(within(band).getByRole('radio', { name: '紫' })).toHaveFocus();
    fireEvent.click(within(band).getByRole('radio', { name: '緑' }));
    expect(onAction.mock.calls).toEqual([[{ type: 'account.update', accountId: 'a1', color: '#2b7048' }]]);
    // 選んだら帯は閉じる。
    expect(within(row('大学')).queryByRole('radiogroup')).toBeNull();
  });
  it('選んでいる色を押しても何も出さず、帯を閉じる', () => {
    const onAction = mount();
    choose('大学', '色を変える');
    fireEvent.click(within(row('大学')).getByRole('radio', { name: '紫' }));
    expect(onAction).not.toHaveBeenCalled();
    expect(within(row('大学')).queryByRole('radiogroup')).toBeNull();
  });
  it('Esc で、何も出さずに帯を閉じる', () => {
    const onAction = mount();
    choose('大学', '色を変える');
    fireEvent.keyDown(within(row('大学')).getByRole('radiogroup'), { key: 'Escape' });
    expect(onAction).not.toHaveBeenCalled();
    expect(within(row('大学')).queryByRole('radiogroup')).toBeNull();
  });
});

describe('AccountSettings の一覧から外す', () => {
  it('最初でないアカウントは、メニューの「一覧から外す」で account.remove を出す（confirmed は付けない）', () => {
    const onAction = mount();
    choose('大学', '一覧から外す');
    expect(onAction.mock.calls).toEqual([[{ type: 'account.remove', accountId: 'a1' }]]);
  });
  it('最初のアカウントでは押せず、理由「最初のアカウントは外せません」を添える（項目は消さない）', () => {
    const onAction = mount();
    fireEvent.click(within(row('会社')).getByRole('button', { name: '会社の操作' }));
    const item = screen.getByRole('menuitem', { name: /一覧から外す/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(within(item).getByText('最初のアカウントは外せません')).toBeInTheDocument();
    fireEvent.click(item);
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('AccountSettings の追加', () => {
  const field = () => screen.getByRole('textbox', { name: 'アカウントの名前' });
  const add = () => screen.getByRole('button', { name: '追加してログイン' });
  it('名前の欄は placeholder「名前（例：大学）」を持ち、下に案内の 1 行を出す', () => {
    mount();
    expect(field()).toHaveAttribute('placeholder', '名前（例：大学）');
    expect(screen.getByText('ブラウザが開くので、足したいアカウントで承認してください。終わると、ここにメールアドレスが出ます。')).toBeInTheDocument();
  });
  it('空では押せない（空白だけでも押せない）', () => {
    mount();
    expect(add()).toBeDisabled();
    fireEvent.change(field(), { target: { value: '  ' } });
    expect(add()).toBeDisabled();
    fireEvent.change(field(), { target: { value: '大学' } });
    expect(add()).toBeEnabled();
  });
  it('名前を入れて Enter で account.add { name } を出し、欄を空にする', () => {
    const onAction = mount();
    fireEvent.change(field(), { target: { value: '大学' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onAction.mock.calls).toEqual([[{ type: 'account.add', name: '大学' }]]);
    expect(field()).toHaveValue('');
  });
  it('「追加してログイン」を押しても同じで、前後の空白は落とす', () => {
    const onAction = mount();
    fireEvent.change(field(), { target: { value: ' 大学 ' } });
    fireEvent.click(add());
    expect(onAction.mock.calls).toEqual([[{ type: 'account.add', name: '大学' }]]);
    expect(field()).toHaveValue('');
  });
  it('空のまま Enter では何も出さない。変換中の Enter でも出さない', () => {
    const onAction = mount();
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.change(field(), { target: { value: 'だいがく' } });
    fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 });
    expect(onAction).not.toHaveBeenCalled();
  });
});
