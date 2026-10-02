import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import { ProjectScreen } from './ProjectScreen.tsx';

const row = (id: string): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: 'done', returnOn: null, overdueDays: null, candidate: null, setBy: 'import' });
const props = (items: ProjectProps['items']): ProjectProps => ({ id: 'alpha', name: 'alpha', parent: { label: 'プロジェクト', route: { name: 'projects' } }, path: '/w/alpha', resolved: true, status: 'active', items, pager: null, notFound: false, isScratch: false, todos: [], memo: null, artifacts: [] });

describe('ProjectScreen の節（P3）', () => {
  it('Done の「ほか N 件」と Archived の「表示」は、そのプロジェクトの節を広げる Intent を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectScreen {...props([
      { kind: 'head', id: 'done', label: 'Done', count: 4, more: { label: 'ほか 1 件 ▸', target: 'done' } }, { kind: 'row', row: row('a') },
      { kind: 'head', id: 'archived', label: 'Archived', count: 2, more: { label: '表示 ▸', target: 'archived' } },
    ])} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'ほか 1 件 ▸' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'project.section.toggle', projectId: 'alpha', section: 'done' });
    fireEvent.click(screen.getByRole('button', { name: '表示 ▸' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'project.section.toggle', projectId: 'alpha', section: 'archived' });
  });
  it('一覧が空なら決まりの文を出す', () => {
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen {...props([])} /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
});
