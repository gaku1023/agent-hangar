import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxView, Row } from '../inbox.ts';
import type { LaunchSpec, RunState } from '../launchRun.ts';
import { LaunchSheet } from './LaunchSheet.tsx';

afterEach(() => {
  vi.useRealTimers();
});

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  targetDevice: 'pc-1',
  pcName: 'Mac',
  projectName: 'project-a',
  accountId: 'acc-1',
  accountName: 'アカウント 1',
  accountColor: '#4a63e8',
  payload: { projectId: 'p-a', scratch: false, accountId: 'acc-1', permissionMode: '', model: '', prompt: 'a' },
  skewMs: 0,
  ...over,
});

const row = (over: Partial<Row> = {}): Row => ({
  sessionId: 's-1',
  deviceId: 'pc-1',
  deviceName: 'Mac',
  projectName: 'project-a',
  title: '会話 1',
  accountName: 'アカウント 1',
  accountColor: '#4a63e8',
  status: 'busy',
  at: null,
  startedAt: null,
  waiting: null,
  intent: null,
  oneLiner: null,
  returnOn: null,
  returnTime: null,
  rcUrl: null,
  agent: null,
  usage: null,
  ...over,
});

const viewOf = (running: Row[]): InboxView => ({ waiting: [], running, returning: [], doneToday: [], devices: [], unreadable: [], feeds: [], skewMs: 0, agentIcons: false });

type Over = Partial<{ spec: LaunchSpec; state: RunState; view: InboxView | null; open: boolean }>;
function setup(o: Over = {}) {
  const fns = { onClose: vi.fn(), onRetry: vi.fn(), onReconnect: vi.fn(), onWantRefresh: vi.fn() };
  const ui = (p: Over) => <LaunchSheet spec={p.spec ?? spec()} state={p.state ?? { kind: 'sending' }} view={p.view ?? null} open={p.open ?? true} {...fns} />;
  const r = render(ui(o));
  return { ...fns, rerender: (p: Over) => r.rerender(ui(p)) };
}

const steps = () => within(screen.getByRole('list', { name: '進み' })).getAllByRole('listitem').map((li) => li.getAttribute('data-state'));
const started: RunState = { kind: 'started', sessionId: 's-1', title: '会話 1' };

describe('LaunchSheet（D2）', () => {
  it('送信中は「送信」の段が進行中', () => {
    setup({ state: { kind: 'sending' } });
    expect(screen.getByRole('dialog', { name: '会話を開始中…' })).toBeInTheDocument();
    expect(steps()).toEqual(['act', 'todo', 'todo']);
    expect(screen.queryByText('送信中…')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['送信', 'PC で受信', '開始']);
  });

  it('Worker が受けたら、PC の受信を待つ。PC が受信したら、開始を待つ', () => {
    const { rerender } = setup({ state: { kind: 'waiting', claimed: false } });
    expect(steps()).toEqual(['done', 'act', 'todo']);
    expect(screen.getByText('Mac での受信を確認中…（最大 30 秒ほど）')).toBeInTheDocument();
    rerender({ state: { kind: 'waiting', claimed: true } });
    expect(steps()).toEqual(['done', 'done', 'act']);
    expect(screen.getByText('Mac で受信しました。開始を確認中…')).toBeInTheDocument();
  });

  it('始まったら会話の札（プロジェクトと題、PC、アカウント、実行中）を出し、URL が無いあいだは開くボタンを押せない', () => {
    setup({ state: started });
    expect(steps()).toEqual(['done', 'done', 'done']);
    expect(screen.getByRole('dialog', { name: '会話が始まりました' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: '開始した会話' });
    expect(within(card).getByText('project-a')).toBeInTheDocument();
    expect(within(card).getByText(/会話 1/)).toBeInTheDocument();
    expect(within(card).getByText('Mac')).toBeInTheDocument();
    expect(within(card).getByText('アカウント 1')).toBeInTheDocument();
    expect(within(card).getByText('実行中')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'URL を受信中…' })).toBeDisabled();
    expect(within(card).queryByText(/意図：/)).not.toBeInTheDocument();
  });

  it('受信箱の素に会話の URL と意図が来たら、アカウントつきの開くリンクとして出す', () => {
    const { rerender } = setup({ state: started, view: viewOf([]) });
    rerender({ state: started, view: viewOf([row({ rcUrl: 'https://claude.ai/code/session_abc', intent: 'README を読んでいます' })]) });
    const link = screen.getByRole('link', { name: '開く ›' });
    expect(link).toHaveAttribute('href', 'https://claude.ai/code/session_abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText('意図：README を読んでいます')).toBeInTheDocument();
  });

  it('claude.ai でない URL は信じず、アカウントが無ければ札なしの文言', () => {
    setup({ spec: spec({ accountName: null, accountColor: null }), state: started, view: viewOf([row({ rcUrl: 'https://evil.example/x', accountName: null })]) });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'URL を受信中…' })).toBeDisabled();
  });

  it('クイックセッションは札にそう書く。URL が来たらアカウント無しの文言', () => {
    setup({ spec: spec({ projectName: null, accountName: null }), state: started, view: viewOf([row({ rcUrl: 'https://claude.ai/code/session_x' })]) });
    const card = screen.getByRole('region', { name: '開始した会話' });
    expect(within(card).getByText('クイックセッション')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: '開く ›' })).toBeInTheDocument();
  });

  it('始まったあと URL が来るまで 3 秒ごとに受信箱の読み直しを頼み、URL が来たら止める。最大 20 回', () => {
    vi.useFakeTimers();
    const { onWantRefresh, rerender } = setup({ state: started, view: viewOf([]) });
    expect(onWantRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(onWantRefresh).toHaveBeenCalledTimes(2);
    rerender({ state: started, view: viewOf([row({ rcUrl: 'https://claude.ai/code/session_x' })]) });
    vi.advanceTimersByTime(30_000);
    expect(onWantRefresh).toHaveBeenCalledTimes(2);

    onWantRefresh.mockClear();
    rerender({ state: { kind: 'started', sessionId: 's-2', title: 't' }, view: viewOf([]) });
    act(() => void vi.advanceTimersByTime(120_000));
    expect(onWantRefresh.mock.calls.length).toBeLessThanOrEqual(21);
    expect(screen.getByRole('button', { name: 'URL をまだ受信していません' })).toBeDisabled();
  });

  it('送信の段で失敗したら、その段に ✕ を付け、文と「もう一度送信」を出す', () => {
    const { onRetry } = setup({ state: { kind: 'failed', at: 'send', message: '送信できませんでした。通信を確認して、もう一度送信してください。' } });
    expect(steps()).toEqual(['fail', 'todo', 'todo']);
    expect(screen.getByRole('dialog', { name: '開始できませんでした' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('通信を確認して');
    fireEvent.click(screen.getByRole('button', { name: 'もう一度送信' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('PC の段で失敗したら 2 段目に ✕。detail は文字として出し、接続し直しは別のボタン', () => {
    const { onReconnect } = setup({ state: { kind: 'failed', at: 'pc', message: 'Mac で会話を開始できませんでした。', detail: '<b>tmux</b> が無い', reconnect: true } });
    expect(steps()).toEqual(['done', 'fail', 'todo']);
    expect(screen.getByText('<b>tmux</b> が無い')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接続し直す' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('始まったかもしれない段（応答を読めない、結果をまだ受信していない）では送り直させず、受信箱の確認を勧める', () => {
    const { rerender, onClose } = setup({ state: { kind: 'unreadable' } });
    expect(steps()).toEqual(['done', 'warn', 'todo']);
    expect(screen.getByRole('alert')).toHaveTextContent('Mac の応答を読み取れませんでした。会話が始まっているかもしれません。受信箱で確認してください。');
    expect(screen.queryByRole('button', { name: /もう一度/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '受信箱で確認' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender({ state: { kind: 'unanswered' } });
    expect(steps()).toEqual(['done', 'warn', 'todo']);
    expect(screen.getByRole('alert')).toHaveTextContent('Mac で受信しましたが、結果をまだ受信していません。受信箱で確認してから送り直してください。');
    expect(screen.queryByRole('button', { name: /もう一度/ })).not.toBeInTheDocument();
  });

  it('「受信箱へ」で閉じる。open が false なら何も出さない', () => {
    const { onClose, rerender } = setup({ state: { kind: 'waiting', claimed: false } });
    fireEvent.click(screen.getByRole('button', { name: '受信箱へ' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender({ state: { kind: 'waiting', claimed: false }, open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
