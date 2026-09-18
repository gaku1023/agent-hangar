import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionProps } from '../presenters/session.ts';
import { SessionScreen } from './SessionScreen.tsx';

const base: SessionProps = { id: 's1', name: 'name', live: 'busy', cwd: '/w/alpha', projectName: 'alpha', projectId: 'p1', summary: { title: 'T', oneLiner: 'ONE', body: 'BODY', state: 'in_progress', nextSteps: ['next1'], source: 'baseline', sourceModel: null, basedOnTurns: 2, updatedAt: 1, sourceLabel: '自動', stateLabel: '進行中' }, summaryOpen: false, model: 'fable 5.1', effort: 'high', turns: 2, tokens: '1.2M', prUrl: null, memo: null, started: '2 時間前', lastActivity: '1 分前', hasTranscript: true,
  items: [
    { kind: 'user', seq: 0, text: 'hi', when: '10:00' },
    { kind: 'tool', seq: 1, summary: 'Agent x', name: 'Agent', inputJson: '{}', result: { text: 'done', isError: false }, when: '10:01', subagent: { agentId: 'abc', label: 'Agent x' } },
    { kind: 'tool', seq: 2, summary: 'Edit /a', name: 'Edit', inputJson: '{}', result: { text: 'File not found', isError: true }, when: '10:02', subagent: null },
    { kind: 'assistant', seq: 3, text: 'bye', when: '10:03' },
  ], total: 10, loaded: 4, loading: false, hasMore: true, showThinking: false, showRaw: false, follow: true, agentId: null, subagents: ['abc'], notFound: false, run: null, tabs: [], selectedTab: null, transcriptOpen: true, trustHint: false, canResume: false, canFork: false };

describe('SessionScreen', () => {
  it('ヘッダー、要約の開閉、切替、続きの読み込み', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} /></IntentRoot>);
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
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} summaryOpen /></IntentRoot>);
    expect(screen.getByText('BODY')).toBeInTheDocument();
    expect(screen.getByText('next1')).toBeInTheDocument();
    expect(screen.getByText('自動')).toBeInTheDocument();
  });
  it('ツール呼び出しは畳まれ、エラーは印が付き、サブエージェントへ飛べる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} /></IntentRoot>);
    expect(screen.getByText('Edit /a').closest('.tool')).toHaveClass('tool-error');
    fireEvent.click(screen.getByText('サブエージェント abc を見る'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('本文が無いセッションは再開を無効にする', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} hasTranscript={false} items={[]} total={0} loaded={0} hasMore={false} /></IntentRoot>);
    expect(screen.getByText('再開')).toBeDisabled();
    // ヘッダーの注記と、空のトランスクリプトの表示の 2 か所に出る。
    expect(screen.getAllByText('本文がありません')).toHaveLength(2);
  });
  it('見つからないとき', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} notFound /></IntentRoot>);
    expect(screen.getByText('セッションが見つかりません')).toBeInTheDocument();
  });
});
