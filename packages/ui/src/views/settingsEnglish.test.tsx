import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type AccountDto, type CompatDto, type CompatSummaryDto, type SettingsDto } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import { presentAccounts } from '../presenters/accounts.ts';
import { presentCloudUsage } from '../presenters/cloudUsage.ts';
import { presentCompat } from '../presenters/compat.ts';
import { ACCOUNT_COLORS } from '../presenters/settings.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { AccountSettings } from './AccountSettings.tsx';
import { CloudUsage } from './CloudUsage.tsx';
import { CompatSection } from './CompatSection.tsx';
import { AccountMeters } from './primitives/AccountMeters.tsx';
import { LanguageRoot } from './primitives/language.tsx';

/** 言語を英語にしたとき、設定の互換、アカウント、クラウドの使用量の文が英語で出る。日本語の文が混ざらないことも見る。 */
const JAPANESE = /[぀-ヿ㐀-鿿]/;
const en = translator('en');
const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const english = { ...initialStore(), settings: { language: 'en' } as SettingsDto };
/** 固定データの名前は日本語なので、英語の名前に替えて使う。 */
const accounts = accountsFixture.accounts.map((a, i): AccountDto => ({ ...a, name: i === 0 ? 'Work' : 'School' }));

const inEnglish = (ui: React.ReactNode, onIntent = vi.fn()) => render(<LanguageRoot language="en"><IntentRoot onIntent={onIntent}>{ui}</IntentRoot></LanguageRoot>);
const noJapanese = (node: HTMLElement = document.body) => expect(node.textContent ?? '').not.toMatch(JAPANESE);

const when = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
const DRIFT: CompatSummaryDto = { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 2 };
const DETAIL: CompatDto = {
  verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [
    { contract: 'screen', value: 'prompt-marker=(missing)', version: '2.1.300', count: 2, firstSeenAt: when(7, 14, 2), lastSeenAt: when(7, 14, 9) },
    { contract: 'transcript', value: 'system.subtype=turn_summary', version: null, count: 9, firstSeenAt: when(6, 22, 15), lastSeenAt: when(7, 14, 1) },
  ],
};

describe('設定（英語）', () => {
  it('互換：札、止めた機能、変更点の表、報告のボタン', () => {
    const c = presentCompat(en, DRIFT, DETAIL, '0.3.0');
    const { container } = inEnglish(<CompatSection compat={c} />);
    expect(screen.getByRole('heading', { level: 3, name: /^Claude Code compatibility/ })).toBeInTheDocument();
    expect(screen.getByText('2 changes')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText('Only features that rely on unknown formats are disabled; everything else keeps running.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Disabled features' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Details of 2 changes')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Check', 'Value', 'Version', 'First seen', 'Disabled features']);
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy report' })).toBeInTheDocument();
    expect(container.textContent).toContain('The record is stored on this computer in ~/.agent-hangar/compat.json.');
    noJapanese();
  });
  it('互換：確認中と問題なし、1 件のときは単数', () => {
    const { unmount } = inEnglish(<CompatSection compat={null} />);
    expect(screen.getByText('Checking')).toBeInTheDocument();
    noJapanese();
    unmount();
    inEnglish(<CompatSection compat={presentCompat(en, { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 }, null, '')} />);
    expect(screen.getByText('No issues')).toHaveAttribute('data-tone', 'ok');
    expect(screen.getByText(/^Installed version/).textContent).toBe('Installed version 2.1.292');
    noJapanese();
  });
  it('互換：変更点 1 件は単数', () => {
    inEnglish(<CompatSection compat={presentCompat(en, { ...DRIFT, driftCount: 1 }, { ...DETAIL, drifts: DETAIL.drifts.slice(1) }, '')} />);
    expect(screen.getByText('1 change')).toBeInTheDocument();
    expect(screen.getByText('Details of 1 change')).toBeInTheDocument();
    noJapanese();
  });

  it('アカウント：節の見出し、行の操作、メニュー', () => {
    const list = presentAccounts({ ...english, accounts: { ...accountsFixture, accounts: accounts.map((a, i): AccountDto => (i === 1 ? { ...a, auth: { ...a.auth!, loggedIn: false } } : a)) } }, NOW);
    inEnglish(<AccountSettings list={list} colors={ACCOUNT_COLORS} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Accounts' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Account list' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Account name' })).toHaveAttribute('placeholder', 'Name (e.g. University)');
    expect(screen.getByRole('button', { name: 'Add and log in' })).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Not logged in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${list[0]!.name}` }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Rename', 'Change color', 'Log in again', 'Reload status', 'Remove from listThe primary account cannot be removed']);
    noJapanese();
  });
  it('アカウント：使用率の棒と、上限間近と古い値の注記', () => {
    const [a] = presentAccounts({ ...english, accounts: { ...accountsFixture, accounts: [{ ...accounts[0]!, usage: { fiveHour: { usedPercent: 82, resetsAt: NOW + 2 * 3_600_000 }, sevenDay: { usedPercent: 41, resetsAt: NOW + 30 * 3_600_000 }, updatedAt: NOW - 3 * 3_600_000 } }] } }, NOW);
    inEnglish(<AccountMeters account={a!} showResets />);
    expect(screen.getByRole('meter', { name: `${a!.name} 5-hour percent used` })).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: `${a!.name} Weekly percent used` })).toBeInTheDocument();
    expect(screen.getByText(/^Near limit\. Resets at /)).toBeInTheDocument();
    expect(screen.getAllByText(/^Resets at /)).toHaveLength(2);
    noJapanese();
  });
  it('アカウント：値が無い、古い値は時間と日で単数と複数', () => {
    const base = accounts[0]!;
    const at = (ago: number) => presentAccounts({ ...english, accounts: { ...accountsFixture, accounts: [{ ...base, usage: { fiveHour: { usedPercent: 10, resetsAt: NOW + 3_600_000 }, sevenDay: null, updatedAt: NOW - ago } }] } }, NOW)[0]!;
    expect(at(3_600_000 + 60_000).note?.text).toBe('Value from 1 hour ago');
    expect(at(5 * 3_600_000).note?.text).toBe('Value from 5 hours ago');
    expect(at(25 * 3_600_000).note?.text).toBe('Value from 1 day ago');
    expect(at(50 * 3_600_000).note?.text).toBe('Value from 2 days ago');
    const none = presentAccounts({ ...english, accounts: { ...accountsFixture, accounts: [{ ...base, usage: { fiveHour: null, sevenDay: null, updatedAt: null } }] } }, NOW)[0]!;
    inEnglish(<AccountMeters account={none} showResets={false} />);
    expect(screen.getByText('No values yet')).toBeInTheDocument();
    noJapanese();
  });

  it('クラウドの使用量：見出し、札、棒の期間、出どころ', () => {
    const RESET = Date.parse('2026-10-03T00:00:00Z');
    const p = presentCloudUsage(en, {
      source: 'cloudflare', fetchedAt: NOW - 120_000, stale: false, notice: null,
      limits: { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 },
      today: { d1RowsWritten: 86_120, workersRequests: 4120, resetAt: RESET },
      plan: { workersPaid: false, r2Paid: true },
      month: { periodStart: '2026-09-05T00:00:00Z', periodEnd: '2026-10-05T00:00:00Z', throughDay: '2026-09-30', billedUsd: 0, rows: [{ label: 'R2 Data Storage', consumed: 0.165, unit: 'GB-months', included: 10 }] },
    }, null, NOW, 'Asia/Tokyo')!;
    inEnglish(<CloudUsage {...p} />);
    const sec = screen.getByRole('region', { name: 'Cloud usage and billing' });
    expect(within(sec).getByText("This month's bill")).toBeInTheDocument();
    expect(within(sec).getByText('Through 9/30')).toBeInTheDocument();
    expect(within(sec).getAllByText('Today')).toHaveLength(2);
    expect(within(sec).getByText('This month')).toBeInTheDocument();
    expect(within(sec).getByText('0.17 / 10 GB-months')).toBeInTheDocument();
    expect(within(sec).getByText('Cloudflare figures · 2 min ago')).toBeInTheDocument();
    noJapanese();
  });
});
