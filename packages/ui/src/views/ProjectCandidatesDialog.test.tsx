import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { CandidateRow, ProjectCandidatesProps } from '../presenters/projectCandidates.ts';
import { ProjectCandidatesDialog } from './ProjectCandidatesDialog.tsx';

// 初日のプロジェクト（2026-10-13）。試作の 4 節 3b の案 B：会話 3 件以上はチェック済み、そのほかは畳む。過半が同じ親なら作成場所のチェック。
const row = (path: string, count: number, over: Partial<CandidateRow> = {}): CandidateRow => ({ path: `/Users/me/${path}`, label: `~/${path}`, parent: `/Users/me/${path.split('/').slice(0, -1).join('/')}`, count, countLabel: `会話 ${count} 件`, when: '昨日', worktrees: null, ...over });
const props = (over: Partial<ProjectCandidatesProps> = {}): ProjectCandidatesProps => ({
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
    expect(onAction).toHaveBeenLastCalledWith({ type: 'project.candidates.submit', paths: ['/Users/me/src/notes-app', '/Users/me/src/api-server', '/Users/me/work/report', '/Users/me/src/blog', '/Users/me/src/cli'], workspaceRoot: '/Users/me/src' });
  });
  it('作成場所のチェックを外せば、選んだものだけを登録し、作成場所は決めない', () => {
    const { onAction } = mount();
    fireEvent.click(box('~/src を新しいフォルダの作成場所にする'));
    fireEvent.click(box('~/src/api-server'));
    fireEvent.click(screen.getByRole('button', { name: '2 件を登録' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'project.candidates.submit', paths: ['/Users/me/src/notes-app', '/Users/me/work/report'], workspaceRoot: null });
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
