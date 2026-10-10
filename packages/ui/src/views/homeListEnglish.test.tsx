import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type SessionDto, type SettingsDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import type { PagerProps } from '../presenters/pager.ts';
import { presentHome } from '../presenters/home.ts';
import { presentPalette } from '../presenters/palette.ts';
import { candidateLabel, returnOnLabel, returnOnRowLabel, type SessionRowProps } from '../presenters/row.ts';
import { presentShell } from '../presenters/shell.ts';
import { presentToasts } from '../presenters/toasts.ts';
import { initialStore, type Store } from '../store/store.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { Header } from './Header.tsx';
import { Pager } from './Pager.tsx';
import { SessionRows } from './SessionRows.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ToastStack } from './ToastStack.tsx';
import { LanguageRoot } from './primitives/language.tsx';

/** 言語を英語にしたとき、ホーム、一覧、ヘッダー、サイドバーの文が英語で出る。日本語の文が混ざらないことも見る。 */
const JAPANESE = /[぀-ヿ㐀-鿿]/;
const en = translator('en');
const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const MIN = 60_000;

const inEnglish = (ui: React.ReactNode) => render(<LanguageRoot language="en"><ActionRoot onAction={vi.fn()}>{ui}</ActionRoot></LanguageRoot>);
const noJapanese = (value: string = document.body.textContent ?? '') => expect(value).not.toMatch(JAPANESE);
const jsonOf = (value: unknown) => JSON.stringify(value);

const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: `u-${id}`, projectId: null, name: `name-${id}`, cwd: '/w', firstPrompt: null, aiTitle: null, live: 'busy', lastActivityAt: NOW - 5 * MIN, startedAt: NOW - 10 * MIN, memo: null, hasTranscript: true, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over } as unknown as SessionDto);
const storeIn = (list: SessionDto[]): Store => ({ ...initialStore(), bootstrapped: true, settings: { language: 'en' } as SettingsDto, sessions: Object.fromEntries(list.map((s) => [s.id, s])) });

const row = (over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id: 'a', name: 'alpha work', oneLiner: 'one', projectName: null, live: 'waiting', aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 min ago', whenAbs: '2026-09-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, cost: '', runId: null, transcript: 'expiring', state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });

describe('ホーム、一覧、ヘッダー、サイドバー（英語）', () => {
  it('戻る日と提案の札：日付、超過の複数形、曜日、時刻', () => {
    expect(returnOnLabel(en, null, null)).toBe('No date');
    expect(returnOnLabel(en, '2026-10-05', 0, '13:30')).toBe('Today 13:30');
    expect(returnOnLabel(en, '2026-10-05', 0, '13:30', 0)).toBe('Now');
    expect(returnOnLabel(en, '2026-10-05', 0, '13:30', 59)).toBe('59 min overdue');
    expect(returnOnLabel(en, '2026-10-05', 0, '13:30', 60)).toBe('1 hour overdue');
    expect(returnOnLabel(en, '2026-10-05', 0, '13:30', 150)).toBe('2 hours overdue');
    expect(returnOnLabel(en, '2026-10-04', 1)).toBe('1 day overdue');
    expect(returnOnLabel(en, '2026-10-02', 3)).toBe('3 days overdue');
    expect(returnOnLabel(en, '2026-10-02', null)).toBe('Fri 10/2');
    expect(returnOnLabel(en, '2026-10-06', null, '13:30')).toBe('Tue 10/6 13:30');
    expect(returnOnRowLabel(en, '2026-10-06', null, '13:30')).toBe('10/6 13:30');
    expect(candidateLabel(en, { status: 'done', returnOn: null })).toBe('Mark as Done?');
    expect(candidateLabel(en, { status: 'paused', returnOn: '2026-10-05' })).toBe('Paused · Mon 10/5?');
  });

  it('ホームの札：入力待ち、確認待ち、実行中の一言（日本語が混ざらない）', () => {
    const store = storeIn([
      session('w', { live: 'waiting' }),
      session('i', { live: 'idle', lastActivityAt: NOW - 3 * MIN }),
      session('c', { live: null, state: { status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: { status: 'paused', returnOn: '2026-10-09', returnTime: null, note: null, source: 'in_session', at: NOW - 2 * MIN } } as never }),
      session('r', { live: 'busy', name: null as never, projectId: null }),
    ]);
    const home = presentHome(initialState(), store, NOW);
    expect(home.attention[0]).toMatchObject({ waited: '5 min', question: 'Waiting for input' });
    expect(home.running.find((r) => r.id === 'i')!.note).toBe('Idle. Time since last reply: 3 min');
    expect(home.running.find((r) => r.id === 'r')).toMatchObject({ name: '(No name)', note: 'Working' });
    expect(home.confirm[0]).toMatchObject({ kind: 'session', label: 'Paused · Fri 10/9?', note: 'No reason was written', ago: '2 min ago' });
    noJapanese(jsonOf(home));
  });

  it('パレット：群の名前、操作、右端の語、ホームへ渡す行', () => {
    const store = storeIn([session('w', { live: 'waiting', name: 'fix login' }), session('e', { live: null, name: 'old run', lastActivityAt: NOW - 3 * 3_600_000 })]);
    const closed = presentPalette({ ...initialState(), overlay: { kind: 'palette' } }, store, '', NOW)!;
    expect(closed.sections.map((s) => s.title)).toEqual(['Needs input', 'Recent', 'Actions', 'Settings']);
    expect(closed.sections[0]!.items[0]!.meta).toBe('Waiting 5 min');
    expect(closed.sections[2]!.items.map((i) => i.label)).toContain('Go to next session needing input');
    noJapanese(jsonOf(closed));
    const typed = presentPalette({ ...initialState(), overlay: { kind: 'palette' } }, store, 'log', NOW, { q: 'log', total: 1 })!;
    expect(typed.sections.at(-1)).toMatchObject({ title: 'Home', items: [{ label: 'Search transcripts for “log” in Home', meta: '1 result' }] });
    noJapanese(jsonOf(typed));
    inEnglish(<CommandPalette {...closed} onQuery={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Go to / Actions' })).toHaveAttribute('placeholder', 'Go to a session or run an action');
    noJapanese();
  });

  it('ヘッダーとサイドバー、切断の帯', () => {
    const store = storeIn([session('w', { live: 'waiting' }), session('b', { live: 'busy' })]);
    const shell = presentShell({ ...initialState(), connection: 'disconnected', staleSince: NOW - 5 * MIN, nextRetryAt: NOW + 8_000 }, store, NOW);
    expect(shell.nav.map((n) => n.label)).toEqual(['Home', 'Projects']);
    expect(shell.foot.map((n) => n.label)).toEqual(['Settings']);
    expect(shell.live.rows.find((r) => r.id === 'w')!.waited).toBe('Waiting 5 min');
    expect(shell.conn).toMatchObject({ staleLabel: 'The screen stopped updating 5 min ago', retryLabel: 'Reconnecting in 8 s' });
    noJapanese(jsonOf(shell.conn));
    const { unmount } = inEnglish(<Header indexLabel={null} usage={shell.usage} account={shell.account} sync={shell.sync} notices={shell.notices} newSession={shell.newSession} />);
    expect(screen.getByRole('link', { name: 'Percent used: not available' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go to \/ Actions/ })).toBeInTheDocument();
    noJapanese();
    unmount();
    const side = inEnglish(<Sidebar nav={shell.nav} foot={shell.foot} collapsed={false} live={{ ...shell.live, more: 2 }} />);
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2 more' })).toBeInTheDocument();
    noJapanese();
    side.unmount();
    inEnglish(<ConnectionBanner {...shell.conn} />);
    expect(screen.getByRole('status', { name: 'Connection status' })).toBeInTheDocument();
    expect(screen.getByText('Connection lost')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect now' })).toBeInTheDocument();
    noJapanese();
  });

  it('入力待ちの札と、ほか N 件', () => {
    const store = storeIn([session('w', { live: 'waiting', name: 'fix login' })]);
    const toasts = presentToasts({ ...initialState(), screen: { name: 'projects' }, waitingToasts: ['w'] } as never, store, NOW);
    expect(toasts.waiting[0]).toMatchObject({ name: 'fix login', waited: '5 min' });
    inEnglish(<ToastStack {...toasts} more={3} />);
    expect(screen.getByRole('button', { name: 'fix login needs input' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View 3 more in Home' })).toBeInTheDocument();
    noJapanese();
  });

  it('ページ送りの帯：範囲、番号、1 ページの件数', () => {
    const pager: PagerProps = { page: 3, pageCount: 25, size: 50, sizes: [25, 50, 100, 200], from: 101, to: 150, total: 1223 };
    inEnglish(<Pager label="Sessions" pager={pager} onPage={vi.fn()} onSize={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Sessions pages' });
    expect(nav).toHaveTextContent('101–150 of 1,223');
    expect(screen.getByRole('button', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(3);
    expect(screen.getByRole('button', { name: 'Items per page' })).toHaveTextContent('50 per page');
    noJapanese();
  });

  it('一覧の行：札、メニュー、提案のポップ', () => {
    inEnglish(<SessionRows rows={[row({ state: 'paused', returnOn: '2026-10-09', overdueDays: null, returnTime: '09:30', setBy: 'conversation' }), row({ id: 'b', name: 'beta', live: null, transcript: 'gone', candidate: { status: 'paused', note: null, returnOn: '2026-10-09', returnTime: null, source: 'post_hoc', ago: '2 min ago' } })]} height={400} variant="recent" />);
    expect(screen.getByText('Deleting soon')).toBeInTheDocument();
    expect(document.querySelector('.row-live')).toHaveTextContent('Needs input');
    expect(screen.getByText('10/9 09:30')).toHaveAttribute('title', 'Reminder time Fri 10/9 09:30 · Last activity 3 min ago');
    expect(screen.getByRole('button', { name: 'Status of alpha work' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Paused?' })).toHaveAttribute('title', 'Paused · Fri 10/9?');
    fireEvent.click(screen.getByRole('button', { name: 'Paused?' }));
    expect(screen.getByRole('menu', { name: 'Claude\'s suggestion for beta' })).toBeInTheDocument();
    expect(screen.getByText('Mark as Paused · Fri 10/9?')).toBeInTheDocument();
    expect(screen.getByText('Source: Summary · 2 min ago')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Confirm/ })).toBeInTheDocument();
    noJapanese();
  });

  it('一覧が空のときの文', () => {
    inEnglish(<SessionRows rows={[]} height={100} variant="project" />);
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });
});
