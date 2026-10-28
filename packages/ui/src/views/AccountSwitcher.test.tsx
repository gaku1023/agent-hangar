import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentAccounts, presentCodexAccounts } from '../presenters/accounts.ts';
import type { HeaderAccountProps } from '../presenters/shell.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture, codexAccountsFixture } from '../test/accounts.ts';
import { AccountSwitcher } from './AccountSwitcher.tsx';

const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const list = presentAccounts({ ...initialStore(), accounts: accountsFixture }, NOW);
type Account = NonNullable<HeaderAccountProps>;
/** 既定はホームで、いまのアカウント（会社）を出している形。 */
const home = (over: Partial<Account> = {}): Account => ({ shown: list[0]!, list, sessionId: null, working: false, ...over });
/** セッション画面で、そのセッションは大学で動いている形。 */
const inSession = (over: Partial<Account> = {}): Account => ({ shown: list[1]!, list, sessionId: 's9', working: true, ...over });

const mount = (account: Account) => {
  const onAction = vi.fn();
  render(<ActionRoot onAction={onAction}><AccountSwitcher account={account}><span data-testid="gauges">計器</span></AccountSwitcher></ActionRoot>);
  const face = screen.getByRole('button', { name: new RegExp(`^アカウントを切り替え（現在は ${account.shown.name}[、）]`) });
  return { onAction, face };
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
    expect(face.querySelector('.account-name')).toHaveAttribute('data-fold-at', '0');
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
    const { face, onAction } = mount(home());
    fireEvent.click(face);
    expect(face).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'アカウントを切り替え' });
    expect(dialog).toHaveClass('menu-pop', 'account-pop');
    expect(dialog.parentElement).toBe(document.body);
    expect(onAction.mock.calls).toEqual([[{ type: 'accounts.load' }]]);
  });
  it('開いている間に押し直すと閉じ、accounts.load は増やさない', () => {
    const { face, onAction } = mount(home());
    fireEvent.click(face);
    fireEvent.click(face);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAction).toHaveBeenCalledTimes(1);
  });
  it('アカウントごとに 1 枚の札を並べ、shown の札に aria-checked を付ける', () => {
    const { face } = mount(home());
    fireEvent.click(face);
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
    expect(card(/会社/)).toHaveAttribute('aria-checked', 'true');
    expect(card(/大学/)).toHaveAttribute('aria-checked', 'false');
    // 札の中は AccountMeters で、戻る時刻つきで出す。
    expect(within(card(/会社/)).getByText('taro@example.co.jp')).toBeInTheDocument();
    expect(within(card(/会社/)).getAllByText(`${list[0]!.fiveHour!.resets} にリセット`).length).toBeGreaterThan(0);
    expect(within(card(/大学/)).getByRole('meter', { name: '大学 週の使用率' })).toBeInTheDocument();
  });
  it('Claude の札の右上には一言を出さない。いまの札は aria-checked（青い輪）だけで示す', () => {
    const { face } = mount(home());
    fireEvent.click(face);
    expect(screen.getByRole('dialog').querySelector('.account-card-tag')).toBeNull();
    for (const text of ['現在のアカウント', 'このセッションのアカウント', '切り替える']) expect(screen.queryByText(text)).toBeNull();
  });
  it('セッション画面では、aria-checked がそのセッションのアカウントに付き、右上の一言は出さない', () => {
    const { face } = mount(inSession());
    fireEvent.click(face);
    expect(card(/大学/)).toHaveAttribute('aria-checked', 'true');
    expect(card(/会社/)).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('dialog').querySelector('.account-card-tag')).toBeNull();
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
    const { face, onAction } = mount(home());
    fireEvent.click(face);
    onAction.mockClear();
    fireEvent.click(card(/大学/));
    expect(onAction.mock.calls).toEqual([[{ type: 'account.choose', accountId: 'a1' }]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('セッション画面で「会社」を押すと account.switchSession を working つきで出して閉じる', () => {
    const { face, onAction } = mount(inSession());
    fireEvent.click(face);
    onAction.mockClear();
    fireEvent.click(card(/会社/));
    expect(onAction.mock.calls).toEqual([[{ type: 'account.switchSession', sessionId: 's9', accountId: 'primary', working: true }]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('working が偽なら、偽のまま添える', () => {
    const { face, onAction } = mount(inSession({ working: false }));
    fireEvent.click(face);
    onAction.mockClear();
    fireEvent.click(card(/会社/));
    expect(onAction.mock.calls).toEqual([[{ type: 'account.switchSession', sessionId: 's9', accountId: 'primary', working: false }]]);
  });
  it('いまの札を押しても UiAction は出さず、閉じるだけ', () => {
    for (const account of [home(), inSession()]) {
      const { face, onAction } = mount(account);
      fireEvent.click(face);
      onAction.mockClear();
      fireEvent.click(card(new RegExp(account.shown.name)));
      expect(onAction).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
      document.body.innerHTML = '';
    }
  });
  it('未ログインの札は aria-disabled で、右上は空にし、メールの行だけが「未ログイン」と言う。押しても何も出ず、開いたまま', () => {
    const out = list.map((a) => (a.id === 'a1' ? { ...a, auth: 'out' as const } : a));
    const { face, onAction } = mount(home({ list: out }));
    fireEvent.click(face);
    onAction.mockClear();
    const univ = card(/大学/);
    expect(univ).toHaveAttribute('aria-disabled', 'true');
    expect(within(univ).getAllByText('未ログイン')).toHaveLength(1);
    expect(univ.querySelector('.account-card-tag')).toBeNull();
    expect(univ.querySelector('.account-mail')).toHaveTextContent('未ログイン');
    fireEvent.click(univ);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // ログイン済みの札は押せる印を持たない。
    expect(card(/会社/)).not.toHaveAttribute('aria-disabled');
  });
  it('初めてのログインの途中の札も押せず、右上は空で、メールの行が承認を促す', () => {
    const running = list.map((a) => (a.id === 'a1' ? { ...a, auth: 'running' as const, loggedIn: false, email: null } : a));
    const { face, onAction } = mount(home({ list: running }));
    fireEvent.click(face);
    onAction.mockClear();
    const univ = card(/大学/);
    expect(univ).toHaveAttribute('aria-disabled', 'true');
    expect(univ.querySelector('.account-card-tag')).toBeNull();
    expect(within(univ).getByText('ブラウザで承認してください…')).toBeInTheDocument();
    fireEvent.click(univ);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('ログインし直しの途中の札は押せて、メールも承認の添え書きも見える', () => {
    const again = list.map((a) => (a.id === 'a1' ? { ...a, auth: 'running' as const, loggedIn: true } : a));
    const { face, onAction } = mount(home({ list: again }));
    fireEvent.click(face);
    onAction.mockClear();
    const univ = card(/大学/);
    expect(univ).not.toHaveAttribute('aria-disabled');
    expect(within(univ).getByText('taro@example.ac.jp')).toBeInTheDocument();
    expect(within(univ).getByText('ブラウザで承認してください…')).toBeInTheDocument();
    fireEvent.click(univ);
    expect(onAction.mock.calls).toEqual([[{ type: 'account.choose', accountId: 'a1' }]]);
  });
  it('認証がまだ読めていない（unknown）札は、今までどおり押せる', () => {
    const unknown = list.map((a) => (a.id === 'a1' ? { ...a, auth: 'unknown' as const } : a));
    const { face, onAction } = mount(home({ list: unknown }));
    fireEvent.click(face);
    onAction.mockClear();
    const univ = card(/大学/);
    expect(univ).not.toHaveAttribute('aria-disabled');
    fireEvent.click(univ);
    expect(onAction.mock.calls).toEqual([[{ type: 'account.choose', accountId: 'a1' }]]);
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
  it('「アカウントの設定」で設定へ移る UiAction を出して閉じる', () => {
    const { face, onAction } = mount(home());
    fireEvent.click(face);
    onAction.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'アカウントの設定' }));
    // アカウントの節が見える位置へ着く。
    expect(onAction.mock.calls).toEqual([[{ type: 'nav.go', to: { name: 'settings', at: 'accounts' } }]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('閉じてもう一度開くたびに accounts.load を出す', () => {
    const { face, onAction } = mount(home());
    fireEvent.click(face);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.click(face);
    expect(onAction.mock.calls.filter(([i]) => i.type === 'accounts.load')).toHaveLength(2);
  });
});

describe('AccountSwitcher の下の段', () => {
  it('左に「アカウントを追加」、右に「アカウントの設定」を並べる', () => {
    const { face } = mount(home());
    fireEvent.click(face);
    const foot = screen.getByRole('dialog').querySelector('.account-pop-foot')!;
    const buttons = within(foot as HTMLElement).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['アカウントを追加', 'アカウントの設定']);
  });
  it('「アカウントを追加」を押すと閉じて account.add.open を出す', () => {
    const { face, onAction } = mount(home());
    fireEvent.click(face);
    onAction.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'アカウントを追加' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAction.mock.calls).toEqual([[{ type: 'account.add.open' }]]);
  });
});

describe('AccountSwitcher でアカウントが 1 つ', () => {
  const one = [{ ...list[0]!, fiveHour: { percent: 24, high: false, resets: '14:00' }, sevenDay: { percent: 11, high: false, resets: '10/20 9:00' } }];
  it('同じ顔で押せて、面にその 1 枚の札とリセットの時刻を出す', () => {
    const { face, onAction } = mount(home({ shown: one[0]!, list: one }));
    expect(face.querySelector('.account-name')).toHaveTextContent('会社');
    expect(face.querySelector('.account-caret')).not.toBeNull();
    fireEvent.click(face);
    expect(onAction.mock.calls).toEqual([[{ type: 'accounts.load' }]]);
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1);
    const c = card(/会社/);
    expect(c).toHaveAttribute('aria-checked', 'true');
    expect(c.textContent).toContain('14:00');
    expect(c.textContent).toContain('10/20 9:00');
    expect(screen.getByRole('button', { name: 'アカウントを追加' })).toBeInTheDocument();
  });
  it('「アカウントを追加」は 1 つのときも account.add.open を出す', () => {
    const { face, onAction } = mount(home({ shown: one[0]!, list: one }));
    fireEvent.click(face);
    onAction.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'アカウントを追加' }));
    expect(onAction.mock.calls).toEqual([[{ type: 'account.add.open' }]]);
  });
});

describe('AccountSwitcher の Codex の節', () => {
  const codex = (here: boolean): Account['codex'] => ({ here, usage: { plan: 'Plus', fiveHour: { percent: 23, high: false, resets: '16:20' }, sevenDay: { percent: 37, high: false, resets: '11/01 12:00' }, updatedLabel: '2 分前' } });
  it('Codex の枠があれば、Claude Code と Codex の見出しで節を分け、Codex の札は押せる札にしない', () => {
    const { face } = mount(home({ codex: codex(false) }));
    fireEvent.click(face);
    const dialog = screen.getByRole('dialog');
    const claude = within(dialog).getByRole('group', { name: 'Claude Code' });
    expect(within(claude).getAllByRole('menuitemradio')).toHaveLength(list.length);
    expect(within(claude).getByText('クリックで切り替え')).toBeInTheDocument();
    const group = within(dialog).getByRole('group', { name: 'Codex' });
    expect(within(group).queryByRole('menuitemradio')).toBeNull();
    expect(within(group).queryByRole('button')).toBeNull();
    expect(group).toHaveTextContent('ChatGPT');
    expect(group).toHaveTextContent('Plus');
    expect(group).toHaveTextContent('最終更新 2 分前');
    expect(within(group).getByRole('meter', { name: 'ChatGPT 5 時間の使用率' })).toHaveAttribute('aria-valuenow', '23');
    expect(group).toHaveTextContent('16:20 にリセット');
    expect(within(group).queryByText('このセッション')).toBeNull();
  });
  it('Codex の会話を開いているときだけ、Codex の札に「このセッション」と出す', () => {
    const { face } = mount(home({ codex: codex(true) }));
    fireEvent.click(face);
    const group = screen.getByRole('group', { name: 'Codex' });
    expect(within(group).getByText('このセッション')).toBeInTheDocument();
    expect(group.querySelector('.account-card')).toHaveAttribute('data-here', 'true');
  });
  it('Claude のアカウントが 1 つなら、見出しに「クリックで切り替え」を添えない', () => {
    const { face } = mount(home({ list: [list[0]!], codex: codex(false) }));
    fireEvent.click(face);
    expect(screen.getByRole('group', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.queryByText('クリックで切り替え')).toBeNull();
  });
  it('Codex の枠が無ければ、節の見出しを出さず今の面のまま', () => {
    const { face } = mount(home({ codex: null }));
    fireEvent.click(face);
    expect(screen.queryByRole('group', { name: 'Codex' })).toBeNull();
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(list.length);
  });
});

describe('AccountSwitcher の Codex のアカウント（A7）', () => {
  const store = { ...initialStore(), accounts: codexAccountsFixture };
  const claude = presentAccounts(store, NOW);
  const cx = presentCodexAccounts(store, NOW);
  const withCodex = (over: Partial<NonNullable<Account['codexAccounts']>> = {}, accountOver: Partial<Account> = {}): Account => ({
    shown: claude[0]!, list: claude, sessionId: null, working: false,
    codexAccounts: { list: cx, shownId: 'primary', claudeShownId: 'primary', sessionId: null, working: false, ...over },
    ...accountOver,
  });
  const open = (a: Account) => { const m = mount(a); fireEvent.click(m.face); return m; };

  it('Codex の札を押すと、いまの Codex アカウントを替える動作が出る（Claude 側は触らない）', () => {
    const { onAction } = open(withCodex());
    fireEvent.click(within(screen.getByRole('menu', { name: 'Codex のアカウント' })).getByRole('menuitemradio', { name: /会社用/ }));
    expect(onAction.mock.calls.map((c) => c[0])).toContainEqual({ type: 'account.choose', agent: 'codex', accountId: 'cw' });
    expect(onAction.mock.calls.map((c) => c[0])).not.toContainEqual(expect.objectContaining({ type: 'account.choose', accountId: 'cw', agent: undefined }));
  });
  it('Codex の会話の画面では、別の札を押すと switchSession を出す（確認はその先）', () => {
    const { onAction } = open(withCodex({ shownId: 'cw', sessionId: 'c1', working: true }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Codex のアカウント' })).getByRole('menuitemradio', { name: /個人/ }));
    expect(onAction.mock.calls.map((c) => c[0])).toContainEqual({ type: 'account.switchSession', agent: 'codex', sessionId: 'c1', accountId: 'primary', working: true });
  });
  it('いまの札を押しても何も出さない', () => {
    const { onAction } = open(withCodex());
    fireEvent.click(within(screen.getByRole('menu', { name: 'Codex のアカウント' })).getByRole('menuitemradio', { name: /個人/ }));
    expect(onAction.mock.calls.map((c) => c[0]).filter((a: { type: string }) => a.type.startsWith('account.'))).toEqual([]);
  });
  it('節ごとの「＋」でそのエージェントの追加ダイアログを開く', () => {
    const { onAction } = open(withCodex());
    fireEvent.click(screen.getByRole('button', { name: 'Codex のアカウントを追加' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'account.add.open', agent: 'codex' });
    fireEvent.click(screen.getByRole('button', { name: /^アカウントを切り替え/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code のアカウントを追加' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'account.add.open' });
  });
  it('下の段は「アカウントの設定」だけで、「アカウントを追加」は置かない', () => {
    open(withCodex());
    expect(screen.getByRole('button', { name: 'アカウントの設定' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'アカウントを追加' })).toBeNull();
  });
  it('承認待ちの札は押せる札ではなく、「確認コードでログイン」と「キャンセル」を持つ', () => {
    const pending = presentCodexAccounts({ ...initialStore(), accounts: { ...codexAccountsFixture, codex: { ...codexAccountsFixture.codex!, accounts: [
      codexAccountsFixture.codex!.accounts[0]!,
      { ...codexAccountsFixture.codex!.accounts[1]!, auth: { loggedIn: false, email: null, plan: null, orgName: null, checkedAt: 1 }, loginRunning: true, login: { method: 'browser' } },
    ] } } }, NOW);
    const { onAction } = open(withCodex({ list: pending }));
    expect(within(screen.getByRole('menu', { name: 'Codex のアカウント' })).queryByRole('menuitemradio', { name: /会社用/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '確認コードでログイン' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'account.login', agent: 'codex', accountId: 'cw', method: 'deviceCode' });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'account.login.cancel', agent: 'codex', accountId: 'cw' });
  });
  it('確認コードのログイン中の札は、URL とコードを折り返して全部見せ、「未取得」を出さない', () => {
    const coding = presentCodexAccounts({ ...initialStore(), accounts: { ...codexAccountsFixture, codex: { ...codexAccountsFixture.codex!, accounts: [
      codexAccountsFixture.codex!.accounts[0]!,
      { ...codexAccountsFixture.codex!.accounts[1]!, auth: null, usage: { fiveHour: null, sevenDay: null, updatedAt: null }, loginRunning: true, login: { method: 'deviceCode', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' } },
    ] } } }, NOW);
    open(withCodex({ list: coding }));
    const text = screen.getByText(/ABCD-1234/);
    expect(text).toHaveAttribute('data-wrap', 'true');
    expect(screen.queryByText('未取得')).toBeNull();
  });
  it('取り消された札には、取り消しの文が出る', () => {
    const cancelled = presentCodexAccounts({ ...initialStore(), accounts: { ...codexAccountsFixture, codex: { ...codexAccountsFixture.codex!, accounts: [
      codexAccountsFixture.codex!.accounts[0]!,
      { ...codexAccountsFixture.codex!.accounts[1]!, login: { method: 'browser', cancelledBy: '個人' } },
    ] } } }, NOW);
    open(withCodex({ list: cancelled }));
    expect(screen.getByText('別のアカウントのログインを開始したため、取り消しました')).toBeInTheDocument();
  });
  it('codex の DTO が無ければ、従来の形（下の段に「アカウントを追加」、節の「＋」なし）', () => {
    open(home());
    expect(screen.getByRole('button', { name: 'アカウントを追加' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Codex のアカウントを追加' })).toBeNull();
    expect(screen.queryByRole('menu', { name: 'Codex のアカウント' })).toBeNull();
  });
});
