import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { pick } from '../test/pick.ts';
import type { HomeProps, RunningCard } from '../presenters/home.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import type { ProjectCardProps } from '../presenters/projects.ts';
import { HOME_MIN_ROWS, HomeScreen } from './HomeScreen.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';
import { ProjectsScreen } from './ProjectsScreen.tsx';
import { SESSION_ROW_H } from './SessionRows.tsx';

// Task 22 で ProjectProps に増えた右レールの分。この節が見るのはヘッダーの操作だけなので空にする。
const rail = { pager: null, isScratch: false, todos: [], memo: null, artifacts: [], parent: { label: 'プロジェクト', route: { name: 'projects' as const } } };
const card = (id: string): ProjectCardProps => ({ id, name: id, path: '/w/' + id, pathLabel: null, resolved: true, status: 'active', lastActivity: '1 時間前', runningCount: 1, waitingCount: 0, openTodoCount: 0, memoHead: null, excerpt: 'last one', excerptFromPrompt: false });

describe('HomeScreen', () => {
  const home = (over: Partial<HomeProps> = {}): HomeProps => ({ attention: [], returning: [], confirm: [], running: [], recent: [], projects: [], idle: false, ...over });
  const runningCard = (over: Partial<RunningCard> = {}): RunningCard => ({ id: 's1', name: 'キーボード操作の見直し', live: 'busy', elapsed: '12 分', meta: 'agent-hangar · opus 4.1 · high', intent: null, activity: { tool: 'Edit', summary: 'packages/ui/src/keys.ts' }, note: null, contextPercent: 38, contextLabel: '38%', ...over });

  it('確かめるの区画は候補を出し、確定と却下と本文の押下で Intent を出し、0 件なら省く', () => {
    const onIntent = vi.fn();
    const c = { kind: 'todo' as const, id: 't1', text: '窓を掴める', projectId: 'p1', projectName: 'agent-hangar', sessionName: '起動画面の作り直し', ago: '12 分前', note: '直して確かめた' };
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ confirm: [c] })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: /確かめる/ }).closest('section')!;
    expect(within(section).getByText('直して確かめた')).toBeTruthy();
    expect(within(section).getByText(/agent-hangar · 起動画面の作り直し · 12 分前/)).toBeTruthy();
    fireEvent.click(within(section).getByLabelText('窓を掴める（agent-hangar）を確定'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.confirm', id: 't1' });
    fireEvent.click(within(section).getByLabelText('窓を掴める（agent-hangar）を却下'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.reject', id: 't1' });
    fireEvent.click(within(section).getByRole('button', { name: '窓を掴める' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.open', id: 'p1' });
    cleanup();
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home()} /></IntentRoot>);
    expect(screen.queryByRole('heading', { name: /確かめる/ })).toBeNull();
  });

  it('別のプロジェクトに同じ本文の候補があっても、確定と却下の名前は 1 つに決まる', () => {
    const onIntent = vi.fn();
    const mk = (id: string, projectId: string, projectName: string) => ({ kind: 'todo' as const, id, text: '窓を掴める', projectId, projectName, sessionName: 's', ago: '1 分前', note: 'n' });
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ confirm: [mk('t1', 'p1', 'alpha'), mk('t2', 'p2', 'beta')] })} /></IntentRoot>);
    fireEvent.click(screen.getByLabelText('窓を掴める（alpha）を確定'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'todo.confirm', id: 't1' });
    fireEvent.click(screen.getByLabelText('窓を掴める（beta）を確定'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'todo.confirm', id: 't2' });
    fireEvent.click(screen.getByLabelText('窓を掴める（alpha）を却下'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'todo.reject', id: 't1' });
    fireEvent.click(screen.getByLabelText('窓を掴める（beta）を却下'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'todo.reject', id: 't2' });
  });
  it('確かめるは実行中の札の下に置く（E1）', () => {
    const c = { kind: 'todo' as const, id: 't1', text: '窓', projectId: 'p1', projectName: 'a', sessionName: 's', ago: '1 分前', note: 'n' };
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ attention: [{ id: 'w1', name: 'w', projectName: 'a', waited: '1 分', question: 'q', answer: 'terminal' }], confirm: [c], running: [runningCard()] })} /></IntentRoot>);
    const labels = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(labels.slice(0, 3)).toEqual(['要対応1', '実行中1', '確かめる1']);
  });
  it('確かめるは 3 件まで出し、残りは「ほか N 件を表示」の 1 行にまとめ、押すとその場で開く', () => {
    const cands = Array.from({ length: 7 }, (_, i) => ({ kind: 'todo' as const, id: `t${i}`, text: `候補 ${i}`, projectId: 'p1', projectName: 'a', sessionName: 's', ago: '1 分前', note: 'n' }));
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ confirm: cands })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: /確かめる/ }).closest('section')!;
    expect(within(section).getByRole('heading', { name: /確かめる/ })).toHaveTextContent('確かめる7');
    expect(within(section).getAllByRole('button', { name: /を確定$/ })).toHaveLength(3);
    const more = within(section).getByRole('button', { name: 'ほか 4 件を表示' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(within(section).getAllByRole('button', { name: /を確定$/ })).toHaveLength(7);
    const less = within(section).getByRole('button', { name: 'ほか 4 件を隠す' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(less);
    expect(within(section).getAllByRole('button', { name: /を確定$/ })).toHaveLength(3);
  });
  it('確かめるが 3 件以下なら、まとめの行を出さない', () => {
    const cands = Array.from({ length: 3 }, (_, i) => ({ kind: 'todo' as const, id: `t${i}`, text: `候補 ${i}`, projectId: 'p1', projectName: 'a', sessionName: 's', ago: '1 分前', note: 'n' }));
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ confirm: cands })} /></IntentRoot>);
    expect(screen.getAllByRole('button', { name: /を確定$/ })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^ほか / })).toBeNull();
  });
  it('何も動いていないときは、1 行の文と新しいセッションとスクラッチのボタンを出す（F1）', () => {
    const onIntent = vi.fn();
    const { container, rerender } = render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ idle: true })} /></IntentRoot>);
    const line = container.querySelector('.idle-line') as HTMLElement;
    expect(line).toHaveTextContent('いま動いているセッションはありません');
    fireEvent.click(within(line).getByRole('button', { name: '新しいセッション' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.new.open' });
    fireEvent.click(within(line).getByRole('button', { name: 'スクラッチで始める' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.new.open', scratch: true });
    rerender(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ idle: false })} /></IntentRoot>);
    expect(container.querySelector('.idle-line')).toBeNull();
  });
  it('最近の見出しの右端に「すべて見る」を置き、セッションの一覧へ移る（H1）', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home()} /></IntentRoot>);
    const sessions = screen.getByRole('link', { name: 'すべてのセッションを見る' });
    expect(sessions).toHaveTextContent('すべて見る');
    expect(sessions).toHaveAttribute('href', '#/sessions');
    fireEvent.click(sessions);
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'nav.go', to: { name: 'sessions' } });
    // 見出しの名前にリンクの語を混ぜない。
    expect(screen.getByRole('heading', { name: '最近' })).toBeInTheDocument();
    // プロジェクトは最近の区画の中の 1 行で、見出しを立てない。
    expect(screen.queryByRole('heading', { name: 'プロジェクト' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'プロジェクト' }).closest('section')).toBe(screen.getByRole('heading', { name: '最近' }).closest('section'));
  });
  it('要対応の札は問いを出し、「ターミナルで答える」で端末にフォーカスして開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ attention: [{ id: 'w1', name: '論文の図を直す', projectName: 'thesis', waited: '12 分', question: '図 3 の凡例はどこに置きますか？', answer: 'terminal' }] })} /></IntentRoot>);
    expect(screen.getByRole('heading', { name: /要対応/ })).toBeInTheDocument();
    expect(screen.getByText('図 3 の凡例はどこに置きますか？')).toBeInTheDocument();
    expect(screen.getByText(/thesis · 12 分待っている/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ターミナルで答える' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'w1', focus: 'terminal' });
  });
  it('外のターミナルで動く入力待ちの札は「hangar で引き取る」を出し、押すと確認に回す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ attention: [{ id: 'w2', name: '外の作業', projectName: 'thesis', waited: '3 分', question: '入力を待っています', answer: 'adopt' }] })} /></IntentRoot>);
    expect(screen.getByText(/外のターミナルで動いています/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'hangar で引き取る' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.adopt', id: 'w2' });
  });
  it('バックグラウンドの入力待ちの札は「ターミナルで答える」で hangar からつなぐ', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ attention: [{ id: 'w3', name: '裏の作業', projectName: 'thesis', waited: '3 分', question: '入力を待っています', answer: 'attach' }] })} /></IntentRoot>);
    expect(screen.queryByText(/外のターミナルで動いています/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ターミナルで答える' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.attach', id: 'w3' });
  });
  it('hangar から開く手が無い入力待ちの札は「開く」だけを出し、外のターミナルで動いていると添える', () => {
    // hangar の run が無いと端末は開けず、トランスクリプトしか見せられない。端末を約束するボタンは出さない。
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ attention: [{ id: 'w2', name: '外の作業', projectName: 'thesis', waited: '3 分', question: '入力を待っています', answer: null }] })} /></IntentRoot>);
    expect(screen.queryByRole('button', { name: 'ターミナルで答える' })).toBeNull();
    expect(screen.getByText(/外のターミナルで動いています/)).toBeInTheDocument();
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
  it('実行中の札は、いま何をしているかとコンテキストの使用率を出し、押すか Enter で開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ running: [runningCard()] })} /></IntentRoot>);
    const card = screen.getByRole('button', { name: /キーボード操作の見直し/ });
    expect(card).toHaveTextContent('Edit packages/ui/src/keys.ts');
    expect(card).toHaveTextContent('agent-hangar · opus 4.1 · high');
    expect(within(card).getByRole('meter', { name: 'コンテキストの使用率' })).toHaveAttribute('aria-valuenow', '38');
    expect(card).toHaveTextContent('コンテキスト');
    expect(card).not.toHaveTextContent('文脈');
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledTimes(2);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
  });
  it('休みの札は呼び出しの代わりに一言を出し、使用率が無ければゲージの行を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ running: [runningCard({ live: 'idle', activity: null, note: '休み。最後の返答から 8 分', contextPercent: null, contextLabel: '未取得' })] })} /></IntentRoot>);
    const card = screen.getByRole('button', { name: /キーボード操作の見直し/ });
    expect(card).toHaveTextContent('休み。最後の返答から 8 分');
    expect(card).not.toHaveTextContent('未取得');
    expect(within(card).queryByRole('meter')).toBeNull();
  });
  it('要対応と実行中が無ければ区画ごと省き、最近とプロジェクトは残す', () => {
    render(<IntentRoot onIntent={() => {}}><HomeScreen {...home()} /></IntentRoot>);
    expect(screen.queryByRole('heading', { name: /要対応/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /実行中/ })).toBeNull();
    expect(screen.getByRole('heading', { name: '最近' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'プロジェクト' })).toBeInTheDocument();
    expect(screen.getByText('Active なプロジェクトはありません。設定でワークスペースを確かめてください。')).toBeInTheDocument();
  });
  it('プロジェクトの 1 行は数を並べ、押すとプロジェクトを開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ projects: [{ id: 'alpha', name: 'agent-hangar', status: 'active', counts: 'TODO 3' }] })} /></IntentRoot>);
    const chip = within(screen.getByRole('navigation', { name: 'プロジェクト' })).getByRole('button', { name: /agent-hangar/ });
    expect(chip).toHaveTextContent('TODO 3');
    expect(chip.querySelector('.pj-dot')).toHaveAttribute('data-status', 'active');
    fireEvent.click(chip);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.open', id: 'alpha' });
  });
  describe('プロジェクトの 1 行に入らない分', () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `project-${i}`, status: 'active' as const, counts: '' }));
    it('全部入っていれば（測れないときも）全部を出し、一覧へのリンクは出さない', () => {
      render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ projects })} /></IntentRoot>);
      expect(screen.getAllByRole('button', { name: /^project-/ })).toHaveLength(12);
      expect(screen.queryByRole('link', { name: 'すべてのプロジェクトを見る' })).toBeNull();
    });
    it('折り返した分は Tab で止まらないようにし、右端に「ほか N」を出して一覧へ移る', () => {
      // 5 件目から 2 行目へ折り返したことにする。
      const spy = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) { return Number(this.textContent?.match(/^project-(\d+)/)?.[1] ?? 0) >= 4 ? 28 : 0; });
      try {
        const onIntent = vi.fn();
        const { container } = render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ projects })} /></IntentRoot>);
        const chips = [...container.querySelectorAll('.pj-chip')] as HTMLElement[];
        expect(chips.map((c) => c.tabIndex)).toEqual([0, 0, 0, 0, -1, -1, -1, -1, -1, -1, -1, -1]);
        expect(chips[4]).toHaveAttribute('aria-hidden', 'true');
        const more = screen.getByRole('link', { name: 'すべてのプロジェクトを見る' });
        expect(more).toHaveTextContent('ほか 8');
        expect(more).toHaveAttribute('href', '#/projects');
        fireEvent.click(more);
        expect(onIntent).toHaveBeenLastCalledWith({ type: 'nav.go', to: { name: 'projects' } });
      } finally { spy.mockRestore(); }
    });
  });
  describe('最近の行の数', () => {
    const row = (id: string): SessionRowProps => ({ id, name: `最近 ${id}` } as SessionRowProps);
    const recent = Array.from({ length: 12 }, (_, i) => row(`s${i}`));
    const shown = (container: HTMLElement) => container.querySelectorAll('.home-fit .row').length;
    it('高さが測れないときは下限の行だけを出し、ページ送りは出さない', () => {
      const { container } = render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ recent })} /></IntentRoot>);
      expect(shown(container)).toBe(HOME_MIN_ROWS);
      expect(screen.queryByRole('navigation', { name: '最近のページ' })).toBeNull();
    });
    it('器の高さに入るだけの行を、行の境で打ち切って出す', () => {
      const spy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('home-fit') ? SESSION_ROW_H * 8 + 30 : 0; });
      try {
        const { container } = render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ recent })} /></IntentRoot>);
        expect(shown(container)).toBe(8);
      } finally { spy.mockRestore(); }
    });
    it('器が低くても下限の行は出す。行が足りなければある分だけ', () => {
      const spy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
      try {
        const { container, rerender } = render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ recent })} /></IntentRoot>);
        expect(shown(container)).toBe(HOME_MIN_ROWS);
        rerender(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ recent: recent.slice(0, 2) })} /></IntentRoot>);
        expect(shown(container)).toBe(2);
      } finally { spy.mockRestore(); }
    });
  });
});

describe('ProjectsScreen', () => {
  it('見出しの「新しいプロジェクト」で作成のダイアログを開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.new.open' });
  });
  it('セクションとアーカイブ切替とステータス変更', () => {
    const onIntent = vi.fn();
    const onShow = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [card('alpha')] }, { status: 'paused', label: 'Paused', cards: [] }]} archivedCount={2} filter="" showArchived={false} onFilter={() => {}} onShowArchived={onShow} /></IntentRoot>);
    fireEvent.click(screen.getByText('アーカイブを表示（2）'));
    expect(onShow).toHaveBeenCalledWith(true);
    pick('alpha の状態', 'Paused');
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.setStatus', id: 'alpha', status: 'paused' });
  });
  it('ステータスの札で Enter を押しても、一覧で行を押しても、カードは開かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [card('alpha')] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'alpha の状態' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'Done' }));
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'project.open', id: 'alpha' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.setStatus', id: 'alpha', status: 'done' });
  });
});

describe('ProjectCard の数', () => {
  it('実行中と要対応を別に出し、0 のものは出さない', () => {
    const { rerender } = render(<IntentRoot onIntent={vi.fn()}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [{ ...card('alpha'), runningCount: 1, waitingCount: 2 }] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    expect(screen.getByText('実行中 1')).toBeInTheDocument();
    expect(screen.getByText('要対応 2')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={vi.fn()}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [{ ...card('alpha'), runningCount: 0, waitingCount: 1 }] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    expect(screen.queryByText(/^実行中/)).toBeNull();
    expect(screen.getByText('要対応 1')).toBeInTheDocument();
  });
  it('この PC にパスが無ければそう書き、ここで始めるで新しいセッションを開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [{ ...card('alpha'), path: null, pathLabel: 'この PC にパスがありません' }] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    expect(screen.getByText('この PC にパスがありません')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ここで始める' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'alpha' });
  });
});

describe('ProjectCard の中身（C1）', () => {
  const one = (over: Partial<ProjectCardProps> = {}) => <IntentRoot onIntent={vi.fn()}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [{ ...card('alpha'), ...over }] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>;
  it('抜粋は 2 行の欄に出し、要約から取ったときは出所を添えない', () => {
    const { container } = render(one({ excerpt: '索引をセッションごとに分けた' }));
    expect(container.querySelector('.card-excerpt')).toHaveTextContent('索引をセッションごとに分けた');
    expect(container.querySelector('.card-excerpt')).not.toHaveAttribute('title');
  });
  it('発言から取った抜粋は、出所を行にせず title に持つ（ほとんどのカードに同じ注記が並ばないように）', () => {
    const { container } = render(one({ excerpt: '画像の圧縮率を比べたい', excerptFromPrompt: true }));
    expect(container.querySelector('.card-excerpt')).toHaveAttribute('title', '最初の発言から');
    expect(screen.queryByText('最初の発言から')).toBeNull();
  });
  it('ワークスペース直下のカードはパスの行を出さず、ほかは出す', () => {
    const { container, rerender } = render(one());
    expect(container.querySelector('.card-path')).toBeNull();
    rerender(one({ path: '/elsewhere/tools/alpha', pathLabel: '/elsewhere/tools/alpha' }));
    expect(container.querySelector('.card-path')).toHaveTextContent('/elsewhere/tools/alpha');
    expect(container.querySelector('.card-path')).toHaveAttribute('title', '/elsewhere/tools/alpha');
  });
  it('Active の札は控えめにし、ほかの状態の札は常に出す', () => {
    const { container, rerender } = render(one());
    expect(container.querySelector('.card-status')).toHaveAttribute('data-quiet', 'true');
    rerender(one({ status: 'paused' }));
    expect(container.querySelector('.card-status')).not.toHaveAttribute('data-quiet');
  });
  it('「ここで始める」は最終活動と数の行の右端に置く', () => {
    const { container } = render(one());
    const here = screen.getByRole('button', { name: 'ここで始める' });
    expect(here).toHaveClass('card-here');
    expect(here.closest('.card-meta')).toBe(container.querySelector('.card-meta'));
    expect(container.querySelector('.card-meta')).toHaveTextContent('1 時間前');
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

// プロジェクト画面は、そのプロジェクトのページを list.page で覚える。Home の最近はページを送らない（続きは「すべて見る」）。
describe('プロジェクト画面のページ送り', () => {
  const pager = { page: 1, pageCount: 4, size: 50, sizes: [25, 50, 100, 200], from: 1, to: 50, total: 180 };
  it('プロジェクト画面は広げた節が長いときに帯を出し、そのプロジェクトのページを移る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} pager={pager} /></IntentRoot>);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'セッションのページ' })).getByRole('button', { name: '次のページ' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'list.page', key: 'project:alpha', page: 2 });
  });
});

describe('ProjectScreen', () => {
  it('見つからないときの表示と、操作ボタンの Intent', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><ProjectScreen id="x" name="x" path={null} resolved={false} status="active" items={[]} notFound {...rail} /></IntentRoot>);
    expect(screen.getByText('プロジェクトが見つかりません')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path={null} resolved={false} status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
    expect(screen.getByText('この PC にパスがありません')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
    // 新しいセッションの主ボタンはヘッダーにあるので、見出しの行には並べない。
    expect(screen.queryByText('新しいセッション')).toBeNull();
    expect(screen.getByText('/w/alpha')).toBeInTheDocument();
  });
  it('プロジェクトの操作は project.* の Intent', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openEditor', id: 'alpha' });
    fireEvent.click(screen.getByText('ターミナルで開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openTerminalApp', id: 'alpha' });
  });
});

const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;

describe('プロジェクトまわりのアイコン', () => {
  it('ProjectScreen の操作ボタン', () => {
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
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
    expect(screen.getByLabelText('alpha の状態').getAttribute('data-status')).toBe('paused');
    cleanup();
    render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="done" items={[]} notFound={false} {...rail} /></IntentRoot>);
    expect(screen.getByLabelText('状態').getAttribute('data-status')).toBe('done');
  });
  it('セクションの見出しにステータスの色の点が付く', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [] }, { status: 'done', label: 'Done', cards: [] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    expect([...container.querySelectorAll('.section-head .st-dot')].map((d) => d.getAttribute('data-status'))).toEqual(['active', 'done']);
  });
});

describe('ProjectScreen の右レールの読む面', () => {
  // アーティファクトの節も白い面に載せ、面の中のカードは淡い地で重ねる（見出しと空のときの文が光の上に出ないように）。
  it('TODO、メモ、アーティファクトの節は白い面に載る', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" items={[]} notFound={false} {...rail} /></IntentRoot>);
    const panels = [...container.querySelectorAll('.rail > .rail-panel')];
    expect(panels.map((p) => p.querySelector('.h2')?.textContent)).toEqual(['TODO', 'メモ', 'アーティファクト']);
  });
});
