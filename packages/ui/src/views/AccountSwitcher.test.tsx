import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { presentAccounts } from '../presenters/accounts.ts';
import type { HeaderAccountProps } from '../presenters/shell.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { AccountSwitcher } from './AccountSwitcher.tsx';

const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const list = presentAccounts({ ...initialStore(), accounts: accountsFixture }, NOW);
type Account = NonNullable<HeaderAccountProps>;
/** 既定はホームで、いまのアカウント（会社）を出している形。 */
const home = (over: Partial<Account> = {}): Account => ({ shown: list[0]!, list, sessionId: null, working: false, ...over });
/** セッション画面で、そのセッションは大学で動いている形。 */
const inSession = (over: Partial<Account> = {}): Account => ({ shown: list[1]!, list, sessionId: 's9', working: true, ...over });

const mount = (account: Account) => {
  const onIntent = vi.fn();
  render(<IntentRoot onIntent={onIntent}><AccountSwitcher account={account}><span data-testid="gauges">計器</span></AccountSwitcher></IntentRoot>);
  const face = screen.getByRole('button', { name: new RegExp(`^アカウントを切り替え（現在は ${account.shown.name}[、）]`) });
  return { onIntent, face };
};
const card = (name: RegExp | string) => screen.getByRole('menuitemradio', { name });

describe('AccountSwitcher のボタンの読み上げ', () => {
  const label = (shown: Account['shown']) => mount(home({ shown })).face.getAttribute('aria-label');
  it('名前に、5 時間と週の使用率（丸めた値）を添える', () => {
    expect(label({ ...list[0]!, fiveHour: { percent: 82.4, high: true, resets: null }, sevenDay: { percent: 40.6, high: false, resets: null } })).toBe('アカウントを切り替え（現在は 会社、5 時間 82%、週 41%）');
  });
  it('値の無い窓は言わない', () => {
    expect(label({ ...list[0]!, fiveHour: { percent: 82, high: true, resets: null }, sevenDay: null })).toBe('アカウントを切り替え（現在は 会社、5 時間 82%）');
    document.body.innerHTML = '';
    expect(label({ ...list[0]!, fiveHour: null, sevenDay: { percent: 41, high: false, resets: null } })).toBe('アカウントを切り替え（現在は 会社、週 41%）');
  });
  it('値が 1 つも無ければ名前だけで、メールアドレスは入れない', () => {
    const l = label({ ...list[0]!, fiveHour: null, sevenDay: null });
    expect(l).toBe('アカウントを切り替え（現在は 会社）');
    expect(l).not.toContain('@');
  });
});

describe('AccountSwitcher のボタン', () => {
  it('色の点と名前と計器と ▾ を 1 つのボタンに入れ、dialog を開く印を持つ', () => {
    const { face } = mount(home());
    expect(face).toHaveAttribute('aria-haspopup', 'dialog');
    expect(face).toHaveAttribute('aria-expanded', 'false');
    expect(face.querySelector('.account-dot')).toHaveStyle({ color: '#2a57b8' });
    expect(face.querySelector('.account-name')).toHaveTextContent('会社');
    expect(within(face).getByTestId('gauges')).toBeInTheDocument();
    expect(face.querySelector('.account-caret')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('名前の字は畳む段（account-name）に載り、点は畳む印を持たない', () => {
    const { face } = mount(home());
    expect(face.querySelector('.account-name')).toHaveAttribute('data-fold-at', '1');
    expect(face.querySelector('.account-dot')).not.toHaveAttribute('data-fold-at');
  });
  it('セッション画面では、そのセッションのアカウントを名前に出す', () => {
    const { face } = mount(inSession());
    expect(face.querySelector('.account-name')).toHaveTextContent('大学');
    expect(face.querySelector('.account-dot')).toHaveStyle({ color: '#7a4a9e' });
  });
});

describe('AccountSwitcher の開いた先', () => {
  it('押すと開き、accounts.load を 1 回だけ出す', () => {
    const { face, onIntent } = mount(home());
    fireEvent.click(face);
    expect(face).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'アカウントを切り替え' });
    expect(dialog).toHaveClass('menu-pop', 'account-pop');
    expect(dialog.parentElement).toBe(document.body);
    expect(onIntent.mock.calls).toEqual([[{ type: 'accounts.load' }]]);
  });
  it('開いている間に押し直すと閉じ、accounts.load は増やさない', () => {
    const { face, onIntent } = mount(home());
    fireEvent.click(face);
    fireEvent.click(face);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onIntent).toHaveBeenCalledTimes(1);
  });
  it('アカウントごとに 1 枚の札を並べ、shown の札に aria-checked を付ける', () => {
    const { face } = mount(home());
    fireEvent.click(face);
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
    expect(card(/会社/)).toHaveAttribute('aria-checked', 'true');
    expect(card(/大学/)).toHaveAttribute('aria-checked', 'false');
    // 札の中は AccountMeters で、戻る時刻つきで出す。
    expect(within(card(/会社/)).getByText('taro@example.co.jp')).toBeInTheDocument();
    expect(within(card(/会社/)).getAllByText(`${list[0]!.fiveHour!.resets} に戻る`).length).toBeGreaterThan(0);
    expect(within(card(/大学/)).getByRole('meter', { name: '大学 週の枠の使用率' })).toBeInTheDocument();
  });
  it('札の右上は、shown が「現在のアカウント」、ほかは「切り替える」', () => {
    const { face } = mount(home());
    fireEvent.click(face);
    expect(within(card(/会社/)).getByText('現在のアカウント')).toBeInTheDocument();
    expect(within(card(/大学/)).getByText('切り替える')).toBeInTheDocument();
  });
  it('セッション画面では shown の札が「このセッションのアカウント」になり、aria-checked もそのセッションのアカウントに付く', () => {
    const { face } = mount(inSession());
    fireEvent.click(face);
    expect(card(/大学/)).toHaveAttribute('aria-checked', 'true');
    expect(card(/会社/)).toHaveAttribute('aria-checked', 'false');
    expect(within(card(/大学/)).getByText('このセッションのアカウント')).toBeInTheDocument();
    expect(within(card(/会社/)).getByText('切り替える')).toBeInTheDocument();
    expect(screen.queryByText('現在のアカウント')).toBeNull();
  });
  it('開いたとき、shown の札にフォーカスを置く', () => {
    const { face } = mount(inSession());
    fireEvent.click(face);
    expect(document.activeElement).toBe(card(/大学/));
  });
  it('↓ ↑ で札を移り、端では反対の端へ回る', () => {
    const { face } = mount(home());
    fireEvent.click(face);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(card(/大学/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(card(/会社/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(card(/大学/));
  });
});

describe('AccountSwitcher で札を押す', () => {
  it('ホームで「大学」を押すと account.choose を出して閉じる', () => {
    const { face, onIntent } = mount(home());
    fireEvent.click(face);
    onIntent.mockClear();
    fireEvent.click(card(/大学/));
    expect(onIntent.mock.calls).toEqual([[{ type: 'account.choose', accountId: 'a1' }]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('セッション画面で「会社」を押すと account.switchSession を working つきで出して閉じる', () => {
    const { face, onIntent } = mount(inSession());
    fireEvent.click(face);
    onIntent.mockClear();
    fireEvent.click(card(/会社/));
    expect(onIntent.mock.calls).toEqual([[{ type: 'account.switchSession', sessionId: 's9', accountId: 'primary', working: true }]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('working が偽なら、偽のまま添える', () => {
    const { face, onIntent } = mount(inSession({ working: false }));
    fireEvent.click(face);
    onIntent.mockClear();
    fireEvent.click(card(/会社/));
    expect(onIntent.mock.calls).toEqual([[{ type: 'account.switchSession', sessionId: 's9', accountId: 'primary', working: false }]]);
  });
  it('いまの札を押しても Intent は出さず、閉じるだけ', () => {
    for (const account of [home(), inSession()]) {
      const { face, onIntent } = mount(account);
      fireEvent.click(face);
      onIntent.mockClear();
      fireEvent.click(card(new RegExp(account.shown.name)));
      expect(onIntent).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
      document.body.innerHTML = '';
    }
  });
  it('未ログインの札は aria-disabled で、右上は空にし、メールの行だけが「未ログイン」と言う。押しても何も出ず、開いたまま', () => {
    const out = list.map((a) => (a.id === 'a1' ? { ...a, auth: 'out' as const } : a));
    const { face, onIntent } = mount(home({ list: out }));
    fireEvent.click(face);
    onIntent.mockClear();
    const univ = card(/大学/);
    expect(univ).toHaveAttribute('aria-disabled', 'true');
    expect(within(univ).getAllByText('未ログイン')).toHaveLength(1);
    expect(univ.querySelector('.account-card-tag')).toBeNull();
    expect(univ.querySelector('.account-mail')).toHaveTextContent('未ログイン');
    fireEvent.click(univ);
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // ログイン済みの札は押せる印を持たない。
    expect(card(/会社/)).not.toHaveAttribute('aria-disabled');
  });
  it('初めてのログインの途中の札も押せず、右上は空で、メールの行が承認を促す', () => {
    const running = list.map((a) => (a.id === 'a1' ? { ...a, auth: 'running' as const, loggedIn: false, email: null } : a));
    const { face, onIntent } = mount(home({ list: running }));
    fireEvent.click(face);
    onIntent.mockClear();
    const univ = card(/大学/);
    expect(univ).toHaveAttribute('aria-disabled', 'true');
    expect(univ.querySelector('.account-card-tag')).toBeNull();
    expect(within(univ).getByText('ブラウザで承認してください…')).toBeInTheDocument();
    fireEvent.click(univ);
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('ログインし直しの途中の札は押せて、メールも承認の添え書きも見える', () => {
    const again = list.map((a) => (a.id === 'a1' ? { ...a, auth: 'running' as const, loggedIn: true } : a));
    const { face, onIntent } = mount(home({ list: again }));
    fireEvent.click(face);
    onIntent.mockClear();
    const univ = card(/大学/);
    expect(univ).not.toHaveAttribute('aria-disabled');
    expect(within(univ).getByText('切り替える')).toBeInTheDocument();
    expect(within(univ).getByText('taro@example.ac.jp')).toBeInTheDocument();
    expect(within(univ).getByText('ブラウザで承認してください…')).toBeInTheDocument();
    fireEvent.click(univ);
    expect(onIntent.mock.calls).toEqual([[{ type: 'account.choose', accountId: 'a1' }]]);
  });
  it('認証がまだ読めていない（unknown）札は、今までどおり押せる', () => {
    const unknown = list.map((a) => (a.id === 'a1' ? { ...a, auth: 'unknown' as const } : a));
    const { face, onIntent } = mount(home({ list: unknown }));
    fireEvent.click(face);
    onIntent.mockClear();
    const univ = card(/大学/);
    expect(univ).not.toHaveAttribute('aria-disabled');
    expect(within(univ).getByText('切り替える')).toBeInTheDocument();
    fireEvent.click(univ);
    expect(onIntent.mock.calls).toEqual([[{ type: 'account.choose', accountId: 'a1' }]]);
  });
});

describe('AccountSwitcher の閉じ方と設定への道', () => {
  it('Esc で閉じ、ボタンへフォーカスを戻す', () => {
    const { face } = mount(home());
    fireEvent.click(face);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(face).toHaveFocus();
    expect(face).toHaveAttribute('aria-expanded', 'false');
  });
  it('外側を押すと閉じる。ボタンの中や面の中を押しても閉じない', () => {
    const { face } = mount(home());
    fireEvent.click(face);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('「アカウントの設定」で設定へ移る Intent を出して閉じる', () => {
    const { face, onIntent } = mount(home());
    fireEvent.click(face);
    onIntent.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'アカウントの設定' }));
    // アカウントの節が見える位置へ着く。
    expect(onIntent.mock.calls).toEqual([[{ type: 'nav.go', to: { name: 'settings', at: 'accounts' } }]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('閉じてもう一度開くたびに accounts.load を出す', () => {
    const { face, onIntent } = mount(home());
    fireEvent.click(face);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.click(face);
    expect(onIntent.mock.calls.filter(([i]) => i.type === 'accounts.load')).toHaveLength(2);
  });
});
