import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionProps } from '../presenters/session.ts';
import type { TerminalHost } from '../runtime/terminals.ts';
import { SessionScreen } from './SessionScreen.tsx';
import { TerminalHostContext } from './TerminalPane.tsx';

const base: SessionProps = { id: 's1', name: 'name', live: 'busy', cwd: '/w/alpha', projectName: 'alpha', projectId: 'p1', summary: { title: 'T', oneLiner: 'ONE', body: 'BODY', state: 'in_progress', nextSteps: ['next1'], source: 'baseline', sourceModel: null, basedOnTurns: 2, updatedAt: 1, sourceLabel: '自動', stateLabel: '進行中' }, summaryOpen: false, model: 'fable 5.1', effort: 'high', turns: 2, tokens: '1.2M', prUrl: null, memo: null, started: '2 時間前', lastActivity: '1 分前', hasTranscript: true,
  items: [
    { kind: 'user', seq: 0, text: 'hi', when: '10:00' },
    { kind: 'tool', seq: 1, summary: 'Agent x', name: 'Agent', inputJson: '{}', result: { text: 'done', isError: false }, when: '10:01', subagent: { agentId: 'abc', label: 'Agent x' } },
    { kind: 'tool', seq: 2, summary: 'Edit /a', name: 'Edit', inputJson: '{}', result: { text: 'File not found', isError: true }, when: '10:02', subagent: null },
    { kind: 'assistant', seq: 3, text: 'bye', when: '10:03' },
  ], total: 10, loaded: 4, loading: false, hasMore: true, showThinking: false, showRaw: false, follow: true, agentId: null, subagents: ['abc'], notFound: false, loadingSession: false, run: null, tabs: [], selectedTab: null, transcriptOpen: true, trustHint: false, canResume: true, canFork: true };

describe('SessionScreen', () => {
  it('ヘッダー、要約の開閉、切替、続きの読み込み', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} terminalStatus={null} /></IntentRoot>);
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('ONE')).toBeInTheDocument();
    expect(screen.queryByText('BODY')).toBeNull();
    fireEvent.click(screen.getByText('詳細'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'summary.toggle', sessionId: 's1' });
    fireEvent.click(screen.getByLabelText('思考を表示'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.showThinking', sessionId: 's1', show: true });
    fireEvent.click(screen.getByText('続きを読み込む（残り 6 件）'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.loadMore', sessionId: 's1' });
    fireEvent.change(screen.getByLabelText('サブエージェント'), { target: { value: 'abc' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('開いた要約は本文と次の一手を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} terminalStatus={null} summaryOpen /></IntentRoot>);
    expect(screen.getByText('BODY')).toBeInTheDocument();
    expect(screen.getByText('next1')).toBeInTheDocument();
    expect(screen.getByText('自動')).toBeInTheDocument();
  });
  it('ツール呼び出しは畳まれ、エラーは印が付き、サブエージェントへ飛べる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} terminalStatus={null} /></IntentRoot>);
    expect(screen.getByText('Edit /a').closest('.tool')).toHaveClass('tool-error');
    fireEvent.click(screen.getByText('サブエージェント abc を見る'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('本文が無いセッションは再開を無効にする', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} terminalStatus={null} hasTranscript={false} canResume={false} canFork={false} items={[]} total={0} loaded={0} hasMore={false} /></IntentRoot>);
    expect(screen.getByText('再開')).toBeDisabled();
    // ヘッダーの注記と、空のトランスクリプトの表示の 2 か所に出る。
    expect(screen.getAllByText('本文がありません')).toHaveLength(2);
  });
  it('見つからないとき', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} terminalStatus={null} notFound /></IntentRoot>);
    expect(screen.getByText('セッションが見つかりません')).toBeInTheDocument();
  });
  it('セッションの情報がまだ届いていないときは読み込み中', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} terminalStatus={null} loadingSession /></IntentRoot>);
    expect(screen.getByText('セッションを読み込んでいます')).toBeInTheDocument();
    expect(screen.queryByText('セッションが見つかりません')).toBeNull();
  });
});

const host: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => 'connected', fit: vi.fn(), focus: vi.fn(), subscribe: () => () => {}, dispose: vi.fn() };
const running: SessionProps = { ...base, live: 'busy', run: { id: 'r1', kind: 'start', alive: true, started: '1 分前' }, selectedTab: 'r1', canResume: false, canFork: false,
  tabs: [{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }, { id: 't1', title: 'シェル 1', kind: 'shell', selected: false, closable: true }] };
const withHost = (ui: ReactElement, onIntent = vi.fn()) => { render(<IntentRoot onIntent={onIntent}><TerminalHostContext.Provider value={host}>{ui}</TerminalHostContext.Provider></IntentRoot>); return onIntent; };

describe('SessionScreen（実行中）', () => {
  it('タブ列、ターミナル、トランスクリプトの折りたたみ、停止とターミナルで開く', () => {
    const onIntent = withHost(<SessionScreen {...running} terminalStatus="connected" />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(host.mount).toHaveBeenCalledWith('r1', expect.anything());
    fireEvent.click(screen.getByRole('tab', { name: /シェル 1/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.select', tabId: 't1' });
    fireEvent.click(screen.getByLabelText('シェル 1 を閉じる'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.close', tabId: 't1' });
    fireEvent.click(screen.getByLabelText('シェルタブを追加'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.open', sessionId: 's1', kind: 'shell' });
    fireEvent.click(screen.getByText('停止'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r1' });
    fireEvent.click(screen.getByText('ターミナルで開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openTerminalApp', runId: 'r1', tabId: 'r1' });
    fireEvent.click(screen.getByLabelText('トランスクリプトを閉じる'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.toggle' });
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('再開')).toBeDisabled();
  });
  it('折りたたむとトランスクリプトを描かない', () => {
    withHost(<SessionScreen {...running} transcriptOpen={false} terminalStatus="connected" />);
    expect(screen.queryByText('hi')).toBeNull();
    expect(screen.getByLabelText('トランスクリプトを開く')).toBeInTheDocument();
  });
  it('信頼ダイアログの案内と終了の表示', () => {
    withHost(<SessionScreen {...running} live={null} trustHint terminalStatus="connected" />);
    expect(screen.getByRole('status')).toHaveTextContent('信頼確認');
    cleanup();
    withHost(<SessionScreen {...running} live={null} run={{ ...running.run!, alive: false }} canResume terminalStatus="closed" />);
    expect(screen.getByRole('status')).toHaveTextContent('Claude は終了しました');
    expect(screen.queryByText('停止')).toBeNull();
    // 終了した run では新しいシェルを開けないので、＋ を出さない。
    expect(screen.queryByLabelText('シェルタブを追加')).toBeNull();
    expect(screen.getByText('再開')).toBeEnabled();
  });
});
