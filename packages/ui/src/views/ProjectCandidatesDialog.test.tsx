import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { CandidateRow, FolderBrowseProps, FolderRow, ProjectCandidatesProps } from '../presenters/projectCandidates.ts';
import { ProjectCandidatesDialog } from './ProjectCandidatesDialog.tsx';

// 初日のプロジェクト（2026-10-13）。試作の 4 節 3b の案 B：会話 3 件以上はチェック済み、そのほかは畳む。過半が同じ親なら作成場所のチェック。
const row = (path: string, count: number, over: Partial<CandidateRow> = {}): CandidateRow => ({ path: `/Users/me/${path}`, label: `~/${path}`, parent: `/Users/me/${path.split('/').slice(0, -1).join('/')}`, count, countLabel: `会話 ${count} 件`, when: '昨日', worktrees: null, ...over });
const idle: FolderBrowseProps = { status: 'idle', failure: null, parent: null, band: null, rows: [], initialParent: '~/src', rootable: false, home: '/Users/me', desktop: true, picked: null };
const props = (over: Partial<ProjectCandidatesProps> = {}): ProjectCandidatesProps => ({
  source: 'talked',
  browse: idle,
  status: 'ready',
  frequent: [row('src/notes-app', 24, { worktrees: 'worktree 2 本を含む' }), row('src/api-server', 11), row('work/report', 5)],
  others: [row('src/blog', 2), row('src/cli', 1)],
  frequentMin: 3, othersMax: 2,
  suggestedRoot: { path: '/Users/me/src', label: '~/src' },
  submitting: false, error: null,
  ...over,
});
const mount = (p: ProjectCandidatesProps = props(), onAction = vi.fn()) => {
  const r = render(<ActionRoot onAction={onAction}><ProjectCandidatesDialog {...p} /></ActionRoot>);
  return { onAction, rerender: (q: ProjectCandidatesProps) => r.rerender(<ActionRoot onAction={onAction}><ProjectCandidatesDialog {...q} /></ActionRoot>) };
};
const box = (name: string) => screen.getByRole('checkbox', { name });

describe('ProjectCandidatesDialog', () => {
  it('よく使うフォルダはチェック済みで、そのほかは畳み、件数だけを見せる', () => {
    mount(props({ suggestedRoot: null }));
    expect(screen.getByText('よく使うフォルダ')).toBeInTheDocument();
    expect(box('~/src/notes-app')).toHaveAttribute('aria-checked', 'true');
    expect(box('~/work/report')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/^worktree 2 本を含む/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '~/src/blog' })).toBeNull();
    const fold = screen.getByRole('button', { name: /そのほか 2 件/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    expect(box('~/src/blog')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('ホームフォルダと一時フォルダは除いています')).toBeInTheDocument();
  });
  it('作成場所にするチェックを入れると、その直下の候補は自動で登録するので、外せないチェックにする', () => {
    const { onAction } = mount();
    const root = box('~/src を新しいフォルダの作成場所にする');
    expect(root).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: /そのほか/ }));
    expect(box('~/src/blog')).toHaveAttribute('aria-checked', 'true');
    expect(box('~/src/blog')).toBeDisabled();
    expect(box('~/work/report')).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '5 件を登録' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'project.candidates.submit', items: ['/Users/me/src/notes-app', '/Users/me/src/api-server', '/Users/me/work/report', '/Users/me/src/blog', '/Users/me/src/cli'].map((path) => ({ path })), workspaceRoot: '/Users/me/src' });
  });
  it('作成場所のチェックを外せば、選んだものだけを登録し、作成場所は決めない', () => {
    const { onAction } = mount();
    fireEvent.click(box('~/src を新しいフォルダの作成場所にする'));
    fireEvent.click(box('~/src/api-server'));
    fireEvent.click(screen.getByRole('button', { name: '2 件を登録' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'project.candidates.submit', items: [{ path: '/Users/me/src/notes-app' }, { path: '/Users/me/work/report' }], workspaceRoot: null });
  });
  it('作成場所の候補が無ければチェックを出さない。よく使うものが無ければ、そのほかを開いて並べる', () => {
    mount(props({ suggestedRoot: null, frequent: [] }));
    expect(screen.queryByRole('checkbox', { name: /作成場所/ })).toBeNull();
    expect(box('~/src/blog')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: '0 件を登録' })).toBeDisabled();
  });
  it('読み込み中と、読めなかったときと、候補が無いときは、それを言う', () => {
    const { rerender } = mount(props({ status: 'loading', frequent: [], others: [], suggestedRoot: null }));
    expect(screen.getByText('Claude Code と会話したフォルダを探しています…')).toBeInTheDocument();
    rerender(props({ status: 'failed', frequent: [], others: [], suggestedRoot: null }));
    expect(screen.getByText('Claude Code と会話したフォルダを読めませんでした')).toBeInTheDocument();
    rerender(props({ frequent: [], others: [], suggestedRoot: null }));
    expect(screen.getByText(/Claude Code と会話したフォルダは見つかりませんでした/)).toBeInTheDocument();
  });
  it('候補が後から届いたら、よく使うフォルダをチェックしておく', () => {
    const { rerender } = mount(props({ status: 'loading', frequent: [], others: [], suggestedRoot: null }));
    rerender(props());
    expect(box('~/src/notes-app')).toHaveAttribute('aria-checked', 'true');
    expect(box('~/src を新しいフォルダの作成場所にする')).toHaveAttribute('aria-checked', 'true');
  });
  it('送っている間は押せず、失敗の理由を出す。キャンセルで閉じる', () => {
    const { onAction } = mount(props({ submitting: true, error: 'つながりません' }));
    expect(screen.getByRole('button', { name: '5 件を登録' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('つながりません');
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'overlay.close' });
  });
});

// まとめて登録の「フォルダの中から」（0.6.1、試作 proto-register の推す案）。開いた時点では何もチェックしない（利用者の答え）。
const frow = (name: string, over: Partial<FolderRow> = {}): FolderRow => ({
  path: `/Users/me/src/${name}`, name, git: true, count: '—', countLabel: '会話 0 件', when: '', sessions: 0,
  registered: false, worktree: false, inside: false, note: null, link: null, children: null, ...over,
});
const ROWS: FolderRow[] = [
  frow('api-gateway', { count: '24', sessions: 24, when: '昨日' }),
  frow('clients', { git: false, note: 'git のフォルダ 2 件を含みます。開いて選べます', children: [frow('a', { path: '/Users/me/src/clients/a' }), frow('b', { path: '/Users/me/src/clients/b' })] }),
  frow('dotfiles-old', { git: false }),
  frow('infra', { count: '8', sessions: 8, link: { projectId: 'p-infra', note: 'work-pc の infra と同じリポジトリです。この PC の場所として結び付けます' } }),
  frow('notes-app', { count: '41', sessions: 41, registered: true, note: 'すでにプロジェクトです（notes-app）' }),
  frow('notes-app-hotfix', { worktree: true, note: 'notes-app の worktree です' }),
];
const ready = (over: Partial<FolderBrowseProps> = {}): FolderBrowseProps => ({ ...idle, status: 'ready', parent: { path: '/Users/me/src', label: '~/src' }, rows: ROWS, ...over });
const folder = (b: Partial<FolderBrowseProps> = {}) => props({ source: 'folder', browse: ready(b) });
const submitted = (onAction: ReturnType<typeof vi.fn>) => onAction.mock.calls.map((c) => c[0]).filter((a) => a.type === 'project.candidates.submit').at(-1);

describe('ProjectCandidatesDialog（フォルダの中から）', () => {
  it('頭の切り替えで見方を変える。「フォルダの中から」は開いた時点の親を入れて、すぐ直下を読む', () => {
    const { onAction } = mount(props());
    expect(screen.getByRole('radio', { name: 'Claude Code と会話したフォルダ' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'フォルダの中から' }));
    expect(screen.getByLabelText('親フォルダ')).toHaveValue('~/src');
    expect(onAction).toHaveBeenLastCalledWith({ type: 'project.folders.load', parent: '~/src' });
    expect(screen.getByText('直下のフォルダを並べます。隠しフォルダは除いています。')).toBeInTheDocument();
  });
  it('開いた時点の親が決まるまで待ち、決まらなければ空の欄で選ばせる', () => {
    const { onAction, rerender } = mount(props({ source: 'folder', browse: { ...idle, initialParent: undefined } }));
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'project.folders.load' }));
    rerender(props({ source: 'folder', browse: { ...idle, initialParent: null } }));
    expect(screen.getByLabelText('親フォルダ')).toHaveValue('');
    expect(screen.getByText('親フォルダを選んでください')).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'project.folders.load' }));
  });
  it('親を打って Enter で読み直す。「選ぶ…」の Finder の結果を ~ の形で入れて読む', () => {
    const { onAction, rerender } = mount(folder());
    const input = screen.getByLabelText('親フォルダ');
    fireEvent.change(input, { target: { value: ' ~/work ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'project.folders.load', parent: '~/work' });
    fireEvent.click(screen.getByRole('button', { name: '選ぶ…、親フォルダ' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'folder.pick' });
    rerender(props({ source: 'folder', browse: ready({ picked: { path: '/Users/me/Documents/research', n: 1 } }) }));
    expect(input).toHaveValue('~/Documents/research');
    expect(onAction).toHaveBeenLastCalledWith({ type: 'project.folders.load', parent: '~/Documents/research' });
  });
  it('開いた時点では何もチェックせず、登録済みは外せない灰のチェック。印は名前の下の 1 行で言う', () => {
    mount(folder());
    for (const n of ['api-gateway', 'clients', 'dotfiles-old', 'infra', 'notes-app-hotfix']) expect(box(n)).toHaveAttribute('aria-checked', 'false');
    expect(box('notes-app')).toHaveAttribute('aria-checked', 'true');
    expect(box('notes-app')).toBeDisabled();
    expect(screen.getByText('すでにプロジェクトです（notes-app）')).toBeInTheDocument();
    expect(screen.getByText('notes-app の worktree です')).toBeInTheDocument();
    expect(screen.getByText(/^work-pc の infra と同じリポジトリです/)).toBeInTheDocument();
    expect(box('すべて選択')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('（0 / 4 件）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '0 件を登録' })).toBeDisabled();
  });
  it('「すべて選択」は選べる行だけを入れ、結び付く行は結び付けとして送る。一部なら頭は −', () => {
    const { onAction } = mount(folder());
    fireEvent.click(box('すべて選択'));
    expect(box('すべて選択')).toHaveAttribute('aria-checked', 'true');
    expect(box('notes-app-hotfix')).toHaveAttribute('aria-checked', 'false');
    expect(document.querySelector('.reg-sum')!.textContent).toBe('新しく作る 3 件、ほかの PC のプロジェクトに結び付ける 1 件');
    fireEvent.click(box('dotfiles-old'));
    expect(box('すべて選択')).toHaveAttribute('aria-checked', 'mixed');
    fireEvent.click(screen.getByRole('button', { name: '3 件を登録' }));
    expect(submitted(onAction)).toEqual({ type: 'project.candidates.submit', workspaceRoot: null, items: [
      { path: '/Users/me/src/api-gateway' }, { path: '/Users/me/src/clients' }, { path: '/Users/me/src/infra', linkTo: 'p-infra' },
    ] });
    fireEvent.click(box('すべて選択'));
    expect(box('すべて選択')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box('すべて選択'));
    expect(box('すべて選択')).toHaveAttribute('aria-checked', 'false');
  });
  it('結び付く行は「新しく作る」で行ごとに切り替え、戻せる', () => {
    const { onAction } = mount(folder());
    fireEvent.click(box('infra'));
    fireEvent.click(screen.getByRole('button', { name: '新しく作る' }));
    expect(screen.getByText('新しいプロジェクトとして登録します')).toBeInTheDocument();
    expect(document.querySelector('.reg-sum')!.textContent).toBe('新しく作る 1 件');
    fireEvent.click(screen.getByRole('button', { name: '1 件を登録' }));
    expect(submitted(onAction).items).toEqual([{ path: '/Users/me/src/infra' }]);
    fireEvent.click(screen.getByRole('button', { name: '結び付ける' }));
    fireEvent.click(screen.getByRole('button', { name: '1 件を登録' }));
    expect(submitted(onAction).items).toEqual([{ path: '/Users/me/src/infra', linkTo: 'p-infra' }]);
  });
  it('git のフォルダを中に持つものは開いて 1 段下を選べる。親と子は同時には選ばない', () => {
    const { onAction } = mount(folder());
    fireEvent.click(box('clients'));
    fireEvent.click(screen.getByRole('button', { name: 'clients', expanded: false }));
    expect(box('clients/a')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(box('clients/a'));
    expect(box('clients')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: '1 件を登録' }));
    expect(submitted(onAction).items).toEqual([{ path: '/Users/me/src/clients/a' }]);
    fireEvent.click(box('clients'));
    expect(box('clients/a')).toHaveAttribute('aria-checked', 'false');
    // 開いている間の「すべて選択」は、親ではなく子を入れる。
    fireEvent.click(box('すべて選択'));
    expect(box('clients')).toHaveAttribute('aria-checked', 'false');
    expect(box('clients/b')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('（5 / 5 件）')).toBeInTheDocument();
  });
  it('「git のフォルダだけ」で git でない行を隠し、隠した行は送らない', () => {
    const { onAction } = mount(folder());
    fireEvent.click(box('dotfiles-old'));
    fireEvent.click(box('api-gateway'));
    fireEvent.click(box('git のフォルダだけ'));
    expect(screen.queryByRole('checkbox', { name: 'dotfiles-old' })).toBeNull();
    expect(screen.queryByText('git のフォルダはありません')).toBeNull();
    expect(screen.getByRole('button', { name: 'clients', expanded: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 件を登録' }));
    expect(submitted(onAction).items).toEqual([{ path: '/Users/me/src/api-gateway' }]);
  });
  it('親そのものがプロジェクトの中なら黄の帯で言い、選んだ行は分けることを明示して送る', () => {
    const { onAction } = mount(folder({ band: 'agent-hangar', parent: { path: '/Users/me/src/agent-hangar/packages', label: '~/src/agent-hangar/packages' }, rows: ['server', 'ui'].map((n) => frow(n, { inside: true, path: `/Users/me/src/agent-hangar/packages/${n}` })) }));
    expect(screen.getByText('agent-hangar の中のフォルダです')).toBeInTheDocument();
    expect(screen.getByText('ここから登録すると、そのフォルダのこれからの会話は agent-hangar から分かれます。')).toBeInTheDocument();
    expect(box('ui')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(box('ui'));
    fireEvent.click(screen.getByRole('button', { name: '1 件を登録' }));
    expect(submitted(onAction).items).toEqual([{ path: '/Users/me/src/agent-hangar/packages/ui', allowNested: true }]);
  });
  // 作成場所にするチェックは開いた時点では入れない（入れると直下の会話のある行がチェックされ、開いた時点で何もチェックしない決まりと食い違う）。
  it('作成場所が空なら、読んだ親を作成場所にするチェックを出し、入れると直下の会話のある行は外せないチェックにする', () => {
    const { onAction } = mount(folder({ rootable: true }));
    const root = box('~/src を新しいフォルダの作成場所にする');
    expect(root).toHaveAttribute('aria-checked', 'false');
    expect(box('api-gateway')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(root);
    expect(box('api-gateway')).toHaveAttribute('aria-checked', 'true');
    expect(box('api-gateway')).toBeDisabled();
    expect(box('infra')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '新しく作る' })).toBeNull();
    expect(box('dotfiles-old')).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '2 件を登録' }));
    expect(submitted(onAction)).toEqual({ type: 'project.candidates.submit', workspaceRoot: '/Users/me/src', items: [{ path: '/Users/me/src/api-gateway' }, { path: '/Users/me/src/infra' }] });
    fireEvent.click(root);
    expect(box('api-gateway')).toHaveAttribute('aria-checked', 'false');
  });
  it('自動で登録するフォルダの 1 段下は選ばせない（そのフォルダのプロジェクトの中になる）', () => {
    mount(folder({ rootable: true, rows: [frow('clients', { git: false, sessions: 3, count: '3', children: [frow('a', { path: '/Users/me/src/clients/a', sessions: 3 })] })] }));
    fireEvent.click(screen.getByRole('button', { name: 'clients', expanded: false }));
    expect(box('clients/a')).toBeEnabled();
    fireEvent.click(box('~/src を新しいフォルダの作成場所にする'));
    expect(box('clients')).toBeDisabled();
    expect(box('clients/a')).toBeDisabled();
    expect(box('clients/a')).toHaveAttribute('title', 'clients ごと自動で登録するので、選べません');
  });
  it('読み込み中、読めなかったとき、直下にフォルダが無いときは、それを言う', () => {
    const { rerender } = mount(props({ source: 'folder', browse: { ...idle, status: 'loading' } }));
    expect(screen.getByText('フォルダを読んでいます…')).toBeInTheDocument();
    rerender(props({ source: 'folder', browse: { ...idle, status: 'failed', failure: 'path が存在するディレクトリではありません' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('フォルダを読めませんでした（path が存在するディレクトリではありません）');
    rerender(folder({ rows: [] }));
    expect(screen.getByText('このフォルダの直下にはフォルダがありません')).toBeInTheDocument();
  });
});
