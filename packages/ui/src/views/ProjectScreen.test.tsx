import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { pagerOf } from '../presenters/pager.ts';
import type { InstructionRowProps, InstructionsProps, ProjectProps } from '../presenters/project.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import type { SessionListProps, StatusTab, StatusTabProps } from '../presenters/sessions.ts';
import { CopiedContext } from './primitives/CommandLine.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';

// 1 つのプロジェクトの画面（Q3）。左はホームと同じ一覧の部品、右パネルは TODO、指示とメモリ、アーティファクトで、見出しの (i) に場所と操作を置く。

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: 'opus', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const TABS: StatusTabProps[] = ([['all', 'すべて', '2'], ['proposed', '確認待ち', '0'], ['active', 'Active', '2'], ['paused', 'Paused', '0'], ['done', 'Done', '0'], ['archived', 'Archived', '0']] as [StatusTab, string, string][]).map(([tab, label, count]) => ({ tab, label, count, hot: false }));
const list = (over: Partial<SessionListProps> = {}): SessionListProps => ({ text: '', filter: {}, projects: [{ id: 'alpha', name: 'alpha' }], rows: [row('a'), row('b')], total: 2, loading: false, mode: 'all', conditions: [], tabs: TABS, tab: 'all', pager: null, statusColumn: true, tokens: [], hints: [], allCount: 2, ...over });
const claudeRow: InstructionRowProps = { kind: 'project', name: 'CLAUDE.md', desc: 'プロジェクト指示・チームで共有', meta: '2.3 KB · 2 日前', off: false, markdown: '# 見本\n\n- 試験を先に書く', truncated: false };
const agentsRow: InstructionRowProps = { kind: 'agents', name: 'AGENTS.md', desc: 'CLAUDE.md があるため読まれない', meta: '0.4 KB · 1 か月前', off: true, markdown: '# agents', truncated: false };
const INSTRUCTIONS: InstructionsProps = { state: 'ready', rows: [claudeRow, agentsRow], legacyNote: null };
const props = (over: Partial<ProjectProps> = {}): ProjectProps => ({
  id: 'alpha', name: 'alpha', parent: { label: 'プロジェクト', route: { name: 'projects' } }, path: '/w/alpha', resolved: true, status: 'active', notFound: false, isScratch: false,
  list: list(), loadMore: null, info: { sessionsText: '2 本', lastActivity: '3 時間前' },
  todos: [{ id: 't1', text: '買う', done: false, candidate: null }], pendingTodos: 0, instructions: INSTRUCTIONS, artifacts: [{ id: 'a1', title: '題名 a1', description: '説明', favicon: '📊', url: 'https://claude.ai/code/artifact/a1', lastPublished: '1 分前', versionCount: 2, canOpenEditor: false }], artifactAddError: null,
  ...over,
});
const mount = (p: ProjectProps = props(), onAction = vi.fn()) => ({ ...render(<ActionRoot onAction={onAction}><ProjectScreen {...p} /></ActionRoot>), onAction });
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
    const onAction = vi.fn();
    mount(props({ list: list({ pager: pagerOf(1, 25, 60), total: 60 }) }), onAction);
    fireEvent.click(within(screen.getByRole('group', { name: '状態' })).getByRole('button', { name: /^Active/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'active' } });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'セッションのページ' })).getByRole('button', { name: '次のページ' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.page', page: 2 });
  });
  it('検索の結果の続きは「さらに読み込む」で、search.more を出す', () => {
    const onAction = vi.fn();
    mount(props({ list: list({ mode: 'search', text: '動画', pager: null }), loadMore: { remaining: 70, step: 50, loading: false } }), onAction);
    fireEvent.click(screen.getByRole('button', { name: /さらに 50 件を読み込む/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.more' });
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
  it('操作ボタンは project.* の UiAction を出し、アイコンを持つ。新しいセッションの主ボタンは見出しの行に並べない', () => {
    const onAction = vi.fn();
    mount(props(), onAction);
    expect(iconOf(screen.getByRole('button', { name: 'VS Code で開く' }))).toBe('openEditor');
    expect(iconOf(screen.getByRole('button', { name: 'ターミナルで開く' }))).toBe('openTerminal');
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.openEditor', id: 'alpha' });
    fireEvent.click(screen.getByText('ターミナルで開く'));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.openTerminalApp', id: 'alpha' });
    expect(screen.queryByText('新しいセッション')).toBeNull();
  });
  it('状態の選択が data-status を持つ', () => {
    mount(props({ status: 'done' }));
    expect(screen.getByLabelText('プロジェクトのステータス').getAttribute('data-status')).toBe('done');
  });
  it('場所の行はパスを出す。パスが無いときはそう言う', () => {
    const { unmount } = mount();
    expect(screen.getByText('/w/alpha')).toBeInTheDocument();
    unmount();
    mount(props({ path: null, resolved: false }));
    expect(screen.getByText('この PC にパスがありません')).toBeInTheDocument();
  });
  it('パスがこの PC で見つからないときは押せる札を出し、場所の再指定へ進む', () => {
    const onAction = vi.fn();
    mount(props({ resolved: false }), onAction);
    fireEvent.click(screen.getByRole('button', { name: '見つかりません。場所を再指定' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve.open', id: 'alpha' });
  });
  it('クイックセッションの置き場は、状態と外で開く操作を出さず、始める操作を出す', () => {
    const onAction = vi.fn();
    mount(props({ isScratch: true }), onAction);
    expect(screen.queryByLabelText('プロジェクトのステータス')).toBeNull();
    expect(screen.queryByText('VS Code で開く')).toBeNull();
    fireEvent.click(screen.getByText('クイックセッションを開始'));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.open', scratch: true });
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
    const onAction = vi.fn();
    mount(props(), onAction);
    fireEvent.click(within(openInfo()).getByRole('button', { name: '場所を再指定' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve.open', id: 'alpha' });
    expect(screen.queryByRole('dialog', { name: '詳細' })).toBeNull();
  });
  it('一覧から削除は、unlink の意図を出して面を閉じる（確認は Mediator が出す）', () => {
    const onAction = vi.fn();
    mount(props(), onAction);
    fireEvent.click(within(openInfo()).getByRole('button', { name: '一覧から削除' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve', id: 'alpha', action: { kind: 'unlink' } });
    expect(screen.queryByRole('dialog', { name: '詳細' })).toBeNull();
  });
  it('パスをコピーは clipboard.copy を出し、写せたら「コピーしました」を出す', () => {
    const onAction = vi.fn();
    const view = render(<ActionRoot onAction={onAction}><CopiedContext.Provider value={null}><ProjectScreen {...props()} /></CopiedContext.Provider></ActionRoot>);
    fireEvent.click(within(openInfo()).getByRole('button', { name: 'パスをコピー' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: '/w/alpha' });
    act(() => view.rerender(<ActionRoot onAction={onAction}><CopiedContext.Provider value={{ text: '/w/alpha', n: 1 }}><ProjectScreen {...props()} /></CopiedContext.Provider></ActionRoot>));
    expect(within(screen.getByRole('dialog', { name: '詳細' })).getByRole('button', { name: 'コピーしました' })).toBeInTheDocument();
  });
  it('名前を変更は面の中で入力欄に替わり、Enter か保存で project.rename を出す。変換中の Enter と空の名前では出さない', () => {
    const onAction = vi.fn();
    mount(props(), onAction);
    fireEvent.click(within(openInfo()).getByRole('button', { name: '名前を変更' }));
    const input = screen.getByLabelText('名前') as HTMLInputElement;
    expect(input.value).toBe('alpha');
    fireEvent.change(input, { target: { value: '  お店  ' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'project.rename', id: 'alpha', name: 'お店' });
    expect(screen.queryByRole('dialog', { name: '詳細' })).toBeNull();
  });
  it('名前の変更は、保存のボタンでも出せる。空と変えていない名前は出さず、キャンセルで元の操作に戻る', () => {
    const onAction = vi.fn();
    mount(props(), onAction);
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
    expect(onAction).not.toHaveBeenCalled();
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
  it('TODO、指示とメモリ、アーティファクトを並べ、折りたためる', () => {
    mount();
    expect(screen.getByLabelText('TODO を追加')).toBeTruthy();
    expect(screen.getByText('CLAUDE.md')).toBeTruthy();
    expect(screen.getByText('題名 a1')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('右パネルを閉じる'));
    expect(screen.queryByLabelText('TODO を追加')).toBeNull();
    fireEvent.click(screen.getByLabelText('右パネルを開く'));
    expect(screen.getByLabelText('TODO を追加')).toBeTruthy();
  });
  it('アーティファクトの追加が断られた理由は、右パネルの追加欄の下に出る', () => {
    mount(props({ artifactAddError: { url: 'https://claude.ai/code/artifact/x', message: 'すでにプロジェクト「beta」に付いています' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('すでにプロジェクト「beta」に付いています');
  });
  // アーティファクトの節も白い面に載せ、面の中のカードは淡い地で重ねる（見出しと空のときの文が光の上に出ないように）。
  it('3 つの節は白い面に載り、真ん中の見出しは「指示とメモリ」である', () => {
    const { container } = mount();
    const panels = [...container.querySelectorAll('.rail > .rail-panel')];
    expect(panels.map((p) => p.querySelector('h2 > span')?.textContent)).toEqual(['TODO', '指示とメモリ', 'アーティファクト']);
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
    render(<LanguageRoot language="en"><ActionRoot onAction={vi.fn()}><ProjectScreen {...props({ pendingTodos: 1 })} /></ActionRoot></LanguageRoot>);
    expect(screen.getByRole('heading', { name: /Pending review 1/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Instructions & memory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show CLAUDE.md' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Artifacts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in VS Code' })).toBeInTheDocument();
    expect(screen.getByLabelText('Close right panel')).toBeInTheDocument();
    expect(screen.getByLabelText('Project status')).toHaveTextContent('Active');
  });
});

describe('ProjectScreen の指示とメモリ', () => {
  const section = () => screen.getByRole('heading', { name: '指示とメモリ' }).closest('section')!;

  it('行に名前、説明、大きさと更新を出し、読まれないものに印を付ける', () => {
    mount();
    const rows = within(section()).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('CLAUDE.md'), expect.stringContaining('AGENTS.md')]);
    expect(rows[0]).toHaveTextContent('プロジェクト指示・チームで共有');
    expect(rows[0]).toHaveTextContent('2.3 KB · 2 日前');
    expect(rows[0]).not.toHaveAttribute('data-off');
    expect(rows[1]).toHaveAttribute('data-off', 'true');
    // 読まれるものの全体の見方を、節の下に添える。
    expect(section()).toHaveTextContent('読み込まれるものの全体は、セッションで /context を実行すると確認できます。');
    expect(within(section()).getByText('/context').tagName).toBe('CODE');
  });

  it('行を押すとダイアログで本文を描き、読み直しを頼む。Esc で閉じる', () => {
    const { onAction } = mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'CLAUDE.md を表示' }));
    const dialog = screen.getByRole('dialog', { name: 'CLAUDE.md' });
    expect(within(dialog).getByRole('heading', { name: '見本' })).toBeInTheDocument();
    expect(within(dialog).getByText('試験を先に書く')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('プロジェクト指示・チームで共有');
    expect(onAction).toHaveBeenCalledWith({ type: 'instructions.load', projectId: 'alpha' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('エディタで開くは、行の印からもダイアログからも種類を渡す。行の印はダイアログを開かない', () => {
    const { onAction } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'AGENTS.md をエディタで開く' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'instructions.openEditor', projectId: 'alpha', kind: 'agents' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'CLAUDE.md を表示' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'エディタで開く' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'instructions.openEditor', projectId: 'alpha', kind: 'project' });
  });

  it('先頭だけのときと読めなかったときは、ダイアログで知らせる', () => {
    mount(props({ instructions: { ...INSTRUCTIONS, rows: [{ ...claudeRow, truncated: true }, { ...agentsRow, markdown: null }] } }));
    fireEvent.click(screen.getByRole('button', { name: 'CLAUDE.md を表示' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('長いので先頭だけを表示しています。全体はエディタで開いてください。');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'AGENTS.md を表示' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('このファイルは読めませんでした。エディタで開いてください。');
  });

  it('ファイルが無ければ説明だけを出す。読み込む前は何も言わない。フォルダが無ければそう言う', () => {
    const { unmount } = mount(props({ instructions: { state: 'ready', rows: [], legacyNote: null } }));
    expect(section()).toHaveTextContent('指示のファイルはありません。CLAUDE.md を置くと、起動のたびに読み込まれます。');
    unmount();
    const r = mount(props({ instructions: { state: 'loading', rows: [], legacyNote: null } }));
    expect(section()).not.toHaveTextContent('指示のファイルはありません');
    r.unmount();
    mount(props({ instructions: { state: 'missing', rows: [], legacyNote: null } }));
    expect(section()).toHaveTextContent('この PC にはフォルダがありません');
    expect(section()).not.toHaveTextContent('/context');
  });

  it('以前のノートは中身があるときだけ出し、削除は確かめてから空で保存する', () => {
    const { onAction, unmount } = mount();
    expect(screen.queryByText('以前のノート')).toBeNull();
    unmount();
    mount(props({ instructions: { ...INSTRUCTIONS, legacyNote: '決済は Stripe の v3' } }), onAction);
    expect(section()).toHaveTextContent('以前のノート');
    expect(section()).toHaveTextContent('決済は Stripe の v3');
    expect(within(section()).getByRole('button', { name: 'コピー' })).toBeInTheDocument();
    fireEvent.click(within(section()).getByRole('button', { name: '削除' }));
    const confirm = screen.getByRole('dialog', { name: '以前のノートを削除しますか' });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'memo.save' }));
    fireEvent.click(within(confirm).getByRole('button', { name: '削除' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'memo.save', projectId: 'alpha', markdown: '' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
