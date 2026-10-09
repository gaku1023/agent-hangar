import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { pagerOf } from '../presenters/pager.ts';
import type { ProjectProps } from '../presenters/project.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import type { SessionListProps, StatusTab, StatusTabProps } from '../presenters/sessions.ts';
import { CopiedContext } from './primitives/CommandLine.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';

// 1 つのプロジェクトの画面（Q3）。左はホームと同じ一覧の部品、右パネルは TODO、ノート、アーティファクトで、見出しの (i) に場所と操作を置く。

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: 'opus', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const TABS: StatusTabProps[] = ([['all', 'すべて', '2'], ['proposed', '確認待ち', '0'], ['active', 'Active', '2'], ['paused', 'Paused', '0'], ['done', 'Done', '0'], ['archived', 'Archived', '0']] as [StatusTab, string, string][]).map(([tab, label, count]) => ({ tab, label, count, hot: false }));
const list = (over: Partial<SessionListProps> = {}): SessionListProps => ({ text: '', filter: {}, projects: [{ id: 'alpha', name: 'alpha' }], rows: [row('a'), row('b')], total: 2, loading: false, mode: 'all', conditions: [], tabs: TABS, tab: 'all', pager: null, statusColumn: true, tokens: [], hints: [], allCount: 2, ...over });
const props = (over: Partial<ProjectProps> = {}): ProjectProps => ({
  id: 'alpha', name: 'alpha', parent: { label: 'プロジェクト', route: { name: 'projects' } }, path: '/w/alpha', resolved: true, status: 'active', notFound: false, isScratch: false,
  list: list(), loadMore: null, info: { sessionsText: '2 本', lastActivity: '3 時間前' },
  todos: [{ id: 't1', text: '買う', done: false, candidate: null }], pendingTodos: 0, memo: { markdown: '# a', updatedAt: 1 }, artifacts: [{ id: 'a1', title: '題名 a1', description: '説明', favicon: '📊', url: 'https://claude.ai/code/artifact/a1', lastPublished: '1 分前', versionCount: 2, canOpenEditor: false }],
  ...over,
});
const mount = (p: ProjectProps = props(), onIntent = vi.fn()) => ({ ...render(<IntentRoot onIntent={onIntent}><ProjectScreen {...p} /></IntentRoot>), onIntent });
const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;
const openInfo = () => { fireEvent.click(screen.getByRole('button', { name: '詳細' })); return screen.getByRole('dialog', { name: '詳細' }); };

describe('ProjectScreen の左の一覧（ホームと同じ部品）', () => {
  it('状態のタブ、欄、行を並べ、見出しの「セッション N 件」は置かない。絞り込みにプロジェクトの選択は出さない', () => {
    const { container } = mount();
    expect(screen.getByRole('group', { name: '状態' })).toBeInTheDocument();
    expect(screen.getByLabelText('キーワード')).toBeInTheDocument();
    expect(container.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(container.querySelector('.list-head')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '絞り込み' }));
    expect(screen.queryByRole('button', { name: 'プロジェクト' })).toBeNull();
    // 行にプロジェクト名は出さない（見出しにある）。
    expect(container.querySelector('.row-proj')).toBeNull();
  });
  it('状態のタブ、ページ送りは search.* と list.pageSize の意図で出す', () => {
    const onIntent = vi.fn();
    mount(props({ list: list({ pager: pagerOf(1, 25, 60), total: 60 }) }), onIntent);
    fireEvent.click(within(screen.getByRole('group', { name: '状態' })).getByRole('button', { name: /^Active/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'active' } });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'セッションのページ' })).getByRole('button', { name: '次のページ' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.page', page: 2 });
  });
  it('検索の結果の続きは「さらに読み込む」で、search.more を出す', () => {
    const onIntent = vi.fn();
    mount(props({ list: list({ mode: 'search', text: '動画', pager: null }), loadMore: { remaining: 70, step: 50, loading: false } }), onIntent);
    fireEvent.click(screen.getByRole('button', { name: /さらに 50 件を読み込む/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.more' });
  });
  it('セッションが 1 つも無いプロジェクトは、決まりの文を出す。絞り込みで 0 件のときはホームと同じ文', () => {
    const { unmount } = mount(props({ list: list({ rows: [], total: 0, allCount: 0 }) }));
    expect(screen.getByText('このプロジェクトのセッションはまだありません')).toBeInTheDocument();
    unmount();
    mount(props({ list: list({ rows: [], total: 0, allCount: 3, tab: 'done', filter: { status: 'done' }, conditions: ['Done'] }) }));
    expect(screen.queryByText('このプロジェクトのセッションはまだありません')).toBeNull();
  });
});

describe('ProjectScreen の見出し', () => {
  it('見つからないときの表示', () => {
    mount(props({ notFound: true }));
    expect(screen.getByText('プロジェクトが見つかりません')).toBeInTheDocument();
  });
  it('操作ボタンは project.* の Intent を出し、アイコンを持つ。新しいセッションの主ボタンは見出しの行に並べない', () => {
    const onIntent = vi.fn();
    mount(props(), onIntent);
    expect(iconOf(screen.getByRole('button', { name: 'VS Code で開く' }))).toBe('openEditor');
    expect(iconOf(screen.getByRole('button', { name: 'ターミナルで開く' }))).toBe('openTerminal');
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openEditor', id: 'alpha' });
    fireEvent.click(screen.getByText('ターミナルで開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.openTerminalApp', id: 'alpha' });
    expect(screen.queryByText('新しいセッション')).toBeNull();
  });
  it('状態の選択が data-status を持つ', () => {
    mount(props({ status: 'done' }));
    expect(screen.getByLabelText('プロジェクトの状態').getAttribute('data-status')).toBe('done');
  });
  it('場所の行はパスを出す。パスが無いときはそう言う', () => {
    const { unmount } = mount();
    expect(screen.getByText('/w/alpha')).toBeInTheDocument();
    unmount();
    mount(props({ path: null, resolved: false }));
    expect(screen.getByText('この PC にパスがありません')).toBeInTheDocument();
  });
  it('パスがこの PC で見つからないときは押せる札を出し、場所の再指定へ進む', () => {
    const onIntent = vi.fn();
    mount(props({ resolved: false }), onIntent);
    fireEvent.click(screen.getByRole('button', { name: '見つかりません。場所を再指定' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve.open', id: 'alpha' });
  });
  it('クイックセッションの置き場は、状態と外で開く操作を出さず、始める操作を出す', () => {
    const onIntent = vi.fn();
    mount(props({ isScratch: true }), onIntent);
    expect(screen.queryByLabelText('プロジェクトの状態')).toBeNull();
    expect(screen.queryByText('VS Code で開く')).toBeNull();
    fireEvent.click(screen.getByText('クイックセッションを開始'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', scratch: true });
  });
});

describe('ProjectScreen の (i) の詳細', () => {
  it('場所、セッションの数、最後の活動を出す。作成の行は置かない', () => {
    mount();
    const pop = openInfo();
    const rows = [...pop.querySelectorAll('.pop-row')].map((r) => [r.querySelector('dt')!.textContent, r.querySelector('dd')!.textContent]);
    expect(rows).toEqual([['場所', '/w/alpha'], ['セッション', '2 本'], ['最後の活動', '3 時間前']]);
    expect(within(pop).queryByText('作成')).toBeNull();
  });
  it('場所を再指定は、ダイアログを開く意図を出して面を閉じる', () => {
    const onIntent = vi.fn();
    mount(props(), onIntent);
    fireEvent.click(within(openInfo()).getByRole('button', { name: '場所を再指定' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve.open', id: 'alpha' });
    expect(screen.queryByRole('dialog', { name: '詳細' })).toBeNull();
  });
  it('一覧から削除は、unlink の意図を出して面を閉じる（確認は Mediator が出す）', () => {
    const onIntent = vi.fn();
    mount(props(), onIntent);
    fireEvent.click(within(openInfo()).getByRole('button', { name: '一覧から削除' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'alpha', action: { kind: 'unlink' } });
    expect(screen.queryByRole('dialog', { name: '詳細' })).toBeNull();
  });
  it('パスをコピーは clipboard.copy を出し、写せたら「コピーしました」を出す', () => {
    const onIntent = vi.fn();
    const view = render(<IntentRoot onIntent={onIntent}><CopiedContext.Provider value={null}><ProjectScreen {...props()} /></CopiedContext.Provider></IntentRoot>);
    fireEvent.click(within(openInfo()).getByRole('button', { name: 'パスをコピー' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: '/w/alpha' });
    act(() => view.rerender(<IntentRoot onIntent={onIntent}><CopiedContext.Provider value={{ text: '/w/alpha', n: 1 }}><ProjectScreen {...props()} /></CopiedContext.Provider></IntentRoot>));
    expect(within(screen.getByRole('dialog', { name: '詳細' })).getByRole('button', { name: 'コピーしました' })).toBeInTheDocument();
  });
  it('名前を変更は面の中で入力欄に替わり、Enter か保存で project.rename を出す。変換中の Enter と空の名前では出さない', () => {
    const onIntent = vi.fn();
    mount(props(), onIntent);
    fireEvent.click(within(openInfo()).getByRole('button', { name: '名前を変更' }));
    const input = screen.getByLabelText('名前') as HTMLInputElement;
    expect(input.value).toBe('alpha');
    fireEvent.change(input, { target: { value: '  お店  ' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.rename', id: 'alpha', name: 'お店' });
    expect(screen.queryByRole('dialog', { name: '詳細' })).toBeNull();
  });
  it('名前の変更は、保存のボタンでも出せる。空と変えていない名前は出さず、キャンセルで元の操作に戻る', () => {
    const onIntent = vi.fn();
    mount(props(), onIntent);
    fireEvent.click(within(openInfo()).getByRole('button', { name: '名前を変更' }));
    const pop = () => screen.getByRole('dialog', { name: '詳細' });
    const input = screen.getByLabelText('名前');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(within(pop()).getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.click(within(pop()).getByRole('button', { name: 'キャンセル' }));
    expect(within(pop()).getByRole('button', { name: '名前を変更' })).toBeInTheDocument();
    fireEvent.click(within(pop()).getByRole('button', { name: '名前を変更' }));
    // 変えずに保存すると何も出さず閉じる。
    fireEvent.click(within(pop()).getByRole('button', { name: '保存' }));
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '詳細' })).toBeNull();
  });
  it('クイックセッションの置き場は、場所と名前を直す操作も削除も出さず、パスのコピーだけを出す', () => {
    mount(props({ isScratch: true }));
    const pop = openInfo();
    expect(within(pop).getByRole('button', { name: 'パスをコピー' })).toBeInTheDocument();
    for (const name of ['場所を再指定', '名前を変更', '一覧から削除']) expect(within(pop).queryByRole('button', { name })).toBeNull();
  });
  it('パスの無いプロジェクトは、場所の行にそう言い、パスのコピーを出さない', () => {
    mount(props({ path: null, resolved: false }));
    const pop = openInfo();
    expect(pop.querySelector('.pop-row dd')).toHaveTextContent('この PC にパスがありません');
    expect(within(pop).queryByRole('button', { name: 'パスをコピー' })).toBeNull();
  });
});

describe('ProjectScreen の右パネル', () => {
  it('TODO、ノート、アーティファクトを並べ、折りたためる', () => {
    mount();
    expect(screen.getByLabelText('TODO を追加')).toBeTruthy();
    expect(screen.getByLabelText('ノート')).toBeTruthy();
    expect(screen.getByText('題名 a1')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('右パネルを閉じる'));
    expect(screen.queryByLabelText('TODO を追加')).toBeNull();
    fireEvent.click(screen.getByLabelText('右パネルを開く'));
    expect(screen.getByLabelText('TODO を追加')).toBeTruthy();
  });
  // アーティファクトの節も白い面に載せ、面の中のカードは淡い地で重ねる（見出しと空のときの文が光の上に出ないように）。
  it('3 つの節は白い面に載り、見出しの名前は「ノート」である', () => {
    const { container } = mount();
    const panels = [...container.querySelectorAll('.rail > .rail-panel')];
    expect(panels.map((p) => p.querySelector('h2 > span')?.textContent)).toEqual(['TODO', 'ノート', 'アーティファクト']);
  });
  it('TODO の見出しに、確認待ちの数の札を出す。無ければ出さない', () => {
    const { unmount } = mount(props({ pendingTodos: 2 }));
    const head = screen.getByRole('heading', { name: /TODO/ });
    expect(within(head).getByText('確認待ち 2')).toHaveAttribute('data-hot', 'true');
    unmount();
    mount(props({ pendingTodos: 0 }));
    expect(screen.queryByText(/確認待ち \d/)).toBeNull();
  });
  it('言語を English にすると、見出しと操作が英語になる。札の語（Active など）は変わらない', () => {
    render(<LanguageRoot language="en"><IntentRoot onIntent={vi.fn()}><ProjectScreen {...props({ pendingTodos: 1 })} /></IntentRoot></LanguageRoot>);
    expect(screen.getByRole('heading', { name: /Pending review 1/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Note' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Artifacts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in VS Code' })).toBeInTheDocument();
    expect(screen.getByLabelText('Close right panel')).toBeInTheDocument();
    expect(screen.getByLabelText('Project status')).toHaveTextContent('Active');
  });
});
