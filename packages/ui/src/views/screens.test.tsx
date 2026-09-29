import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { HomeProps, RunningCard } from '../presenters/home.ts';
import type { ProjectCardProps } from '../presenters/projects.ts';
import { HOME_VISIBLE_ROWS, HomeScreen } from './HomeScreen.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';
import { ProjectsScreen } from './ProjectsScreen.tsx';
import { SESSION_ROW_H } from './SessionRows.tsx';

// Task 22 で ProjectProps に増えた右レールの分。この節が見るのはヘッダーの操作だけなので空にする。
const rail = { isScratch: false, todos: [], memo: null, artifacts: [] };
const card = (id: string): ProjectCardProps => ({ id, name: id, path: '/w/' + id, resolved: true, status: 'active', lastActivity: '1 時間前', runningCount: 1, openTodoCount: 0, memoHead: null, lastOneLiner: 'last one' });

describe('HomeScreen', () => {
  const home = (over: Partial<HomeProps> = {}): HomeProps => ({ attention: [], running: [], recent: [], projects: [], ...over });
  const runningCard = (over: Partial<RunningCard> = {}): RunningCard => ({ id: 's1', name: 'キーボード操作の見直し', live: 'busy', elapsed: '12 分', meta: 'agent-hangar · opus 4.1 · high', activity: { tool: 'Edit', summary: 'packages/ui/src/keys.ts' }, note: null, contextPercent: 38, contextLabel: '38%', ...over });

  it('要対応の札は問いを出し、「ターミナルで答える」で端末にフォーカスして開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ attention: [{ id: 'w1', name: '論文の図を直す', projectName: 'thesis', waited: '12 分', question: '図 3 の凡例はどこに置きますか？', canAnswer: true }] })} /></IntentRoot>);
    expect(screen.getByRole('heading', { name: /要対応/ })).toBeInTheDocument();
    expect(screen.getByText('図 3 の凡例はどこに置きますか？')).toBeInTheDocument();
    expect(screen.getByText(/thesis · 12 分待っている/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ターミナルで答える' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'w1', focus: 'terminal' });
  });
  it('hangar の外で動いている入力待ちの札は「開く」だけを出し、別のターミナルで動いていると添える', () => {
    // hangar の run が無いと端末は開けず、トランスクリプトしか見せられない。端末を約束するボタンは出さない。
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ attention: [{ id: 'w2', name: '外の作業', projectName: 'thesis', waited: '3 分', question: '入力を待っています', canAnswer: false }] })} /></IntentRoot>);
    expect(screen.queryByRole('button', { name: 'ターミナルで答える' })).toBeNull();
    expect(screen.getByText(/別のターミナルで動いています/)).toBeInTheDocument();
    const open = screen.getByRole('button', { name: '開く' });
    expect(open).toHaveClass('btn');
    expect(open).not.toHaveClass('btn-primary');
    fireEvent.click(open);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'w2' });
  });
  it('実行中の札はセッションの id を、広がる元の印に持つ', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ running: [runningCard()] })} /></IntentRoot>);
    expect(container.querySelector('.live-card')!.getAttribute('data-morph-id')).toBe('s1');
  });
  it('実行中の札は、対象が空ならツール名だけを出す', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ running: [runningCard({ activity: { tool: 'AskUserQuestion', summary: '' } })] })} /></IntentRoot>);
    expect(container.querySelector('.live-act')!.textContent).toBe('AskUserQuestion');
  });
  it('実行中の札は、いま何をしているかと文脈の使用率を出し、押すか Enter で開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ running: [runningCard()] })} /></IntentRoot>);
    const card = screen.getByRole('button', { name: /キーボード操作の見直し/ });
    expect(card).toHaveTextContent('Edit packages/ui/src/keys.ts');
    expect(card).toHaveTextContent('agent-hangar · opus 4.1 · high');
    expect(within(card).getByRole('meter', { name: '文脈の使用率' })).toHaveAttribute('aria-valuenow', '38');
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledTimes(2);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
  });
  it('休みの札は呼び出しの代わりに一言を出し、使用率が無ければゲージを空にする', () => {
    render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ running: [runningCard({ live: 'idle', activity: null, note: '休み。最後の返答から 8 分', contextPercent: null, contextLabel: '未取得' })] })} /></IntentRoot>);
    const card = screen.getByRole('button', { name: /キーボード操作の見直し/ });
    expect(card).toHaveTextContent('休み。最後の返答から 8 分');
    expect(card).toHaveTextContent('未取得');
    expect(within(card).getByRole('meter')).not.toHaveAttribute('aria-valuenow');
  });
  it('要対応と実行中が無ければ区画ごと省き、最近とプロジェクトは残す', () => {
    render(<IntentRoot onIntent={() => {}}><HomeScreen {...home()} /></IntentRoot>);
    expect(screen.queryByRole('heading', { name: /要対応/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /実行中/ })).toBeNull();
    expect(screen.getByRole('heading', { name: '最近' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'プロジェクト' })).toBeInTheDocument();
    expect(screen.getByText('active なプロジェクトはありません。Settings でワークスペースを確かめてください。')).toBeInTheDocument();
  });
  it('プロジェクトの小さな一覧は数を並べ、押すとプロジェクトを開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ projects: [{ id: 'alpha', name: 'agent-hangar', status: 'active', counts: '実行中 2 · TODO 3' }] })} /></IntentRoot>);
    const row = screen.getByRole('button', { name: /agent-hangar/ });
    expect(row).toHaveTextContent('実行中 2 · TODO 3');
    expect(row.querySelector('.pj-dot')).toHaveAttribute('data-status', 'active');
    fireEvent.click(row);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.open', id: 'alpha' });
  });
  it('プロジェクトの一覧は最近と同じ高さで頭打ちにし、中でスクロールする', () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `project-${i}`, status: 'active' as const, counts: '' }));
    const { container } = render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ projects })} /></IntentRoot>);
    expect(screen.getAllByRole('button', { name: /^project-/ })).toHaveLength(12);
    const list = container.querySelector('.pj-list') as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.style.maxHeight).toBe(`${HOME_VISIBLE_ROWS * SESSION_ROW_H}px`);
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
    const { rerender } = render(<IntentRoot onIntent={onIntent}><ProjectScreen id="x" name="x" path={null} resolved={false} status="active" sessions={[]} notFound {...rail} /></IntentRoot>);
    expect(screen.getByText('プロジェクトが見つかりません')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} {...rail} /></IntentRoot>);
    fireEvent.click(screen.getByText('新規セッション'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'alpha' });
    expect(screen.getByText('/w/alpha')).toBeInTheDocument();
  });
  it('プロジェクトの操作は project.* の Intent', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} {...rail} /></IntentRoot>);
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openEditor', id: 'alpha' });
    fireEvent.click(screen.getByText('ターミナルで開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openTerminalApp', id: 'alpha' });
  });
});

const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;

describe('プロジェクトまわりのアイコン', () => {
  it('ProjectScreen の操作ボタン', () => {
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} {...rail} /></IntentRoot>);
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
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="done" sessions={[]} notFound={false} {...rail} /></IntentRoot>);
    expect(screen.getByLabelText('ステータス').getAttribute('data-status')).toBe('done');
  });
  it('セクションの見出しにステータスの色の点が付く', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [] }, { status: 'done', label: 'Done', cards: [] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    expect([...container.querySelectorAll('.section-head .st-dot')].map((d) => d.getAttribute('data-status'))).toEqual(['active', 'done']);
  });
});

describe('ProjectScreen の右レールの読む面', () => {
  // アーティファクトの節も白い面に載せ、面の中のカードは淡い地で重ねる（見出しと空のときの文が光の上に出ないように）。
  it('TODO、メモ、アーティファクトの節は白い面に載る', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} {...rail} /></IntentRoot>);
    const panels = [...container.querySelectorAll('.rail > .rail-panel')];
    expect(panels.map((p) => p.querySelector('.h2')?.textContent)).toEqual(['TODO', 'メモ', 'アーティファクト']);
  });
});
