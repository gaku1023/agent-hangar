import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { ProjectCardProps } from '../presenters/projects.ts';
import { HomeScreen } from './HomeScreen.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';
import { ProjectsScreen } from './ProjectsScreen.tsx';

const card = (id: string): ProjectCardProps => ({ id, name: id, path: '/w/' + id, resolved: true, status: 'active', lastActivity: '1 時間前', runningCount: 1, openTodoCount: 0, memoHead: null, lastOneLiner: 'last one' });

describe('HomeScreen', () => {
  it('実行中の帯とカードと最近', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen running={[{ id: 's1', name: 'run', projectName: 'alpha', live: 'busy', elapsed: '2 時間' }]} activeProjects={[card('alpha')]} recent={[]} /></IntentRoot>);
    fireEvent.click(screen.getByText('run'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
    fireEvent.click(screen.getByText('last one'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.open', id: 'alpha' });
  });
  it('実行中が無ければ帯を省く', () => {
    render(<IntentRoot onIntent={() => {}}><HomeScreen running={[]} activeProjects={[]} recent={[]} /></IntentRoot>);
    expect(screen.queryByText('実行中')).toBeNull();
  });
});

describe('ProjectsScreen', () => {
  it('セクションとアーカイブ切替とステータス変更', () => {
    const onIntent = vi.fn();
    const onShow = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [card('alpha')] }, { status: 'paused', label: 'Paused', cards: [] }]} archivedCount={2} filter="" showArchived={false} onFilter={() => {}} onShowArchived={onShow} /></IntentRoot>);
    fireEvent.click(screen.getByText('アーカイブを表示（2）'));
    expect(onShow).toHaveBeenCalledWith(true);
    fireEvent.change(screen.getByLabelText('alpha のステータス'), { target: { value: 'paused' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.setStatus', id: 'alpha', status: 'paused' });
  });
  it('ステータスの select で Enter を押してもカードは開かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [card('alpha')] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    fireEvent.keyDown(screen.getByLabelText('alpha のステータス'), { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'project.open', id: 'alpha' });
  });
});

describe('ProjectCard（見つからないとき）', () => {
  it('「（見つかりません）」は押せて、カードは開かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [{ ...card('alpha'), resolved: false }] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByText('（見つかりません）'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve.open', id: 'alpha' });
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'project.open', id: 'alpha' });
  });
});

describe('ProjectScreen', () => {
  it('見つからないときの表示と、操作ボタンの Intent', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><ProjectScreen id="x" name="x" path={null} resolved={false} status="active" sessions={[]} notFound /></IntentRoot>);
    expect(screen.getByText('プロジェクトが見つかりません')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} /></IntentRoot>);
    fireEvent.click(screen.getByText('新規セッション'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'alpha' });
    expect(screen.getByText('/w/alpha')).toBeInTheDocument();
  });
  it('プロジェクトの操作は project.* の Intent', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} /></IntentRoot>);
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openEditor', id: 'alpha' });
    fireEvent.click(screen.getByText('ターミナルで開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openTerminalApp', id: 'alpha' });
  });
});

const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;

describe('プロジェクトまわりのアイコン', () => {
  it('ProjectScreen の操作ボタン', () => {
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} /></IntentRoot>);
    expect(iconOf(screen.getByRole('button', { name: '新規セッション' }))).toBe('add');
    expect(iconOf(screen.getByRole('button', { name: 'VS Code で開く' }))).toBe('openEditor');
    expect(iconOf(screen.getByRole('button', { name: 'ターミナルで開く' }))).toBe('openTerminal');
  });
  it('見つからないプロジェクトのカードは警告のアイコンを出す', () => {
    render(<IntentRoot onIntent={vi.fn()}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [{ ...card('gone'), resolved: false }] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    expect(iconOf(screen.getByRole('button', { name: /見つかりません/ }))).toBe('warning');
  });
});

describe('プロジェクトのステータスの色', () => {
  it('カードの select と詳細画面の select が data-status を持つ', () => {
    render(<IntentRoot onIntent={vi.fn()}><ProjectsScreen sections={[{ status: 'paused', label: 'Paused', cards: [{ ...card('alpha'), status: 'paused' }] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    expect(screen.getByLabelText('alpha のステータス').getAttribute('data-status')).toBe('paused');
    cleanup();
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="done" sessions={[]} notFound={false} /></IntentRoot>);
    expect(screen.getByLabelText('ステータス').getAttribute('data-status')).toBe('done');
  });
  it('セクションの見出しにステータスの色の点が付く', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [] }, { status: 'done', label: 'Done', cards: [] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    expect([...container.querySelectorAll('.section-head .st-dot')].map((d) => d.getAttribute('data-status'))).toEqual(['active', 'done']);
  });
});
