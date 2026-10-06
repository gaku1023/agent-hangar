import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AccountDto } from '@agent-hangar/shared';
import { presentAccount, type AccountView } from '../../presenters/accounts.ts';
import { accountsFixture } from '../../test/accounts.ts';
import { AccountMeters } from './AccountMeters.tsx';

const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const HOUR = 3_600_000;
const base = accountsFixture.accounts[0]!;
const view = (over: Partial<AccountDto> = {}): AccountView => presentAccount({ ...base, ...over }, 'primary', NOW);
/** 82% と 41% で、戻る時刻つきの値を持つ会社のアカウント。 */
const withUsage = (over: Partial<AccountDto> = {}) => view({ usage: { fiveHour: { usedPercent: 82, resetsAt: NOW + 2 * HOUR }, sevenDay: { usedPercent: 41, resetsAt: NOW + 30 * HOUR }, updatedAt: NOW - 60_000 }, ...over });

describe('AccountMeters', () => {
  it('色の点と名前とプランの札とメールを出す', () => {
    const { container } = render(<AccountMeters account={withUsage()} showResets={false} />);
    expect(screen.getByText('会社')).toBeInTheDocument();
    expect(screen.getByText('Max')).toHaveClass('account-plan');
    expect(screen.getByText('taro@example.co.jp')).toHaveClass('account-mail');
    const dot = container.querySelector<HTMLElement>('.st-dot')!;
    expect(dot).toHaveStyle({ color: '#2a57b8' });
  });
  it('プランが無ければ札を出さない', () => {
    const { container } = render(<AccountMeters account={view({ auth: { ...base.auth!, plan: null } })} showResets={false} />);
    expect(container.querySelector('.account-plan')).toBeNull();
  });
  it('5 時間と週の 2 本の棒を出し、80% 以上の棒だけが警告の印を持つ', () => {
    render(<AccountMeters account={withUsage()} showResets={false} />);
    const five = screen.getByRole('meter', { name: '会社 5 時間枠の使用率' });
    const week = screen.getByRole('meter', { name: '会社 週の枠の使用率' });
    expect(five).toHaveAttribute('aria-valuenow', '82');
    expect(week).toHaveAttribute('aria-valuenow', '41');
    expect(five.querySelector('.gauge-fill')).toHaveAttribute('data-high', 'true');
    expect(week.querySelector('.gauge-fill')).not.toHaveAttribute('data-high');
    expect(five.querySelector('.gauge-fill')).toHaveStyle({ width: '82%' });
    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByText('41%')).toBeInTheDocument();
    expect(screen.getByText('5 時間')).toBeInTheDocument();
    expect(screen.getByText('週')).toBeInTheDocument();
  });
  it('使用率は丸めて、0 から 100 に収めて棒にする', () => {
    render(<AccountMeters account={view({ usage: { fiveHour: { usedPercent: 120.4, resetsAt: null }, sevenDay: { usedPercent: -3, resetsAt: null }, updatedAt: NOW } })} showResets={false} />);
    expect(screen.getByRole('meter', { name: '会社 5 時間枠の使用率' }).querySelector('.gauge-fill')).toHaveStyle({ width: '100%' });
    expect(screen.getByRole('meter', { name: '会社 週の枠の使用率' }).querySelector('.gauge-fill')).toHaveStyle({ width: '0%' });
    expect(screen.getByText('120%')).toBeInTheDocument();
  });
  it('showResets のときだけ、戻る時刻を出す', () => {
    const v = withUsage();
    const { rerender } = render(<AccountMeters account={v} showResets={false} />);
    expect(screen.queryByText(/に戻る/)).toBeNull();
    rerender(<AccountMeters account={v} showResets />);
    expect(screen.getByText(`${v.fiveHour!.resets} に戻る`)).toBeInTheDocument();
    expect(screen.getByText(`${v.sevenDay!.resets} に戻る`)).toBeInTheDocument();
  });
  it('戻る時刻の届いていない枠には、時刻を添えない', () => {
    render(<AccountMeters account={view({ usage: { fiveHour: { usedPercent: 10, resetsAt: null }, sevenDay: { usedPercent: 20, resetsAt: null }, updatedAt: NOW } })} showResets />);
    expect(screen.queryByText(/に戻る/)).toBeNull();
  });
  it('値が無ければ「まだ値がありません」と言い、棒は出さない', () => {
    render(<AccountMeters account={view({ usage: { fiveHour: null, sevenDay: null, updatedAt: null } })} showResets />);
    expect(screen.getByText('まだ値がありません')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
  });
  it('一方の枠だけ値が無いときは、その枠の数字を「—」にする', () => {
    render(<AccountMeters account={view({ usage: { fiveHour: { usedPercent: 10, resetsAt: null }, sevenDay: null, updatedAt: NOW } })} showResets={false} />);
    expect(screen.getByText('10%')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('まだ値がありません')).toBeNull();
  });
  it('note は最後の 1 行で、tone を印に持つ', () => {
    const { rerender, container } = render(<AccountMeters account={withUsage()} showResets={false} />);
    const warn = screen.getByText(/^まもなく上限/);
    expect(warn).toHaveClass('account-note');
    expect(warn).toHaveAttribute('data-tone', 'warn');
    expect(container.querySelector('.account-meters')!.lastElementChild).toBe(warn);
    rerender(<AccountMeters account={view({ usage: { fiveHour: { usedPercent: 10, resetsAt: null }, sevenDay: { usedPercent: 20, resetsAt: null }, updatedAt: NOW - 3 * HOUR } })} showResets={false} />);
    expect(screen.getByText('3 時間前の値')).toHaveAttribute('data-tone', 'stale');
  });
  it('note が無ければ出さない', () => {
    const { container } = render(<AccountMeters account={view({ usage: { fiveHour: { usedPercent: 10, resetsAt: null }, sevenDay: { usedPercent: 20, resetsAt: null }, updatedAt: NOW } })} showResets={false} />);
    expect(container.querySelector('.account-note')).toBeNull();
  });
  it('未ログインならメールの代わりに「未ログイン」を出す', () => {
    render(<AccountMeters account={view({ auth: { ...base.auth!, loggedIn: false } })} showResets={false} />);
    expect(screen.getByText('未ログイン')).toBeInTheDocument();
    expect(screen.queryByText('taro@example.co.jp')).toBeNull();
  });
  it('初めてのログインの途中なら、メールの行が「ブラウザで承認してください…」を言う', () => {
    render(<AccountMeters account={view({ loginRunning: true, auth: { ...base.auth!, loggedIn: false, email: null } })} showResets={false} />);
    expect(screen.getByText('ブラウザで承認してください…')).toHaveClass('account-mail');
    expect(screen.queryByText('taro@example.co.jp')).toBeNull();
  });
  it('ログインし直しの途中なら、メールを消さずに出したまま、「ブラウザで承認してください…」を添える', () => {
    const { container } = render(<AccountMeters account={view({ loginRunning: true })} showResets={false} />);
    expect(screen.getByText('taro@example.co.jp')).toHaveClass('account-mail');
    expect(screen.getByText('ブラウザで承認してください…')).toHaveClass('account-approve');
    expect(container.querySelector('.account-approve')).not.toBeNull();
  });
  it('ログインし直しの途中でなければ、承認の添え書きを出さない', () => {
    const { container } = render(<AccountMeters account={view()} showResets={false} />);
    expect(container.querySelector('.account-approve')).toBeNull();
  });
  it('警告の印は presenter が決めた high に従い、数え直さない', () => {
    const v = withUsage();
    const { container } = render(<AccountMeters account={{ ...v, fiveHour: { ...v.fiveHour!, percent: 82, high: false }, sevenDay: { ...v.sevenDay!, percent: 41, high: true } }} showResets={false} />);
    expect(container.querySelectorAll('.gauge-fill')[0]).not.toHaveAttribute('data-high');
    expect(container.querySelectorAll('.gauge-fill')[1]).toHaveAttribute('data-high', 'true');
  });
  it('認証が未読なら、メールの行は空のまま', () => {
    const { container } = render(<AccountMeters account={view({ auth: null })} showResets={false} />);
    expect(container.querySelector('.account-plan')).toBeNull();
    expect(screen.queryByText('未ログイン')).toBeNull();
    expect(screen.queryByText('ブラウザで承認してください…')).toBeNull();
    expect(container.querySelector('.account-mail')!.textContent).toBe('');
  });
});
