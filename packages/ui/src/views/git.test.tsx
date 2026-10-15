import { fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type UiAction } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentGitFiles, type DiffDialogProps, type GitChipProps } from '../presenters/git.ts';
import { DiffDialog } from './DiffDialog.tsx';
import { GitChip } from './GitChip.tsx';
import { GitFileList } from './GitFiles.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import { SessionRows } from './SessionRows.tsx';
import type { SessionRowProps } from '../presenters/row.ts';

const ja = translator('ja');

function mount(node: React.ReactNode) {
  const onAction = vi.fn<(a: UiAction) => void>();
  const background = vi.fn<(a: UiAction) => void>();
  render(<LanguageRoot language="ja"><ActionRoot onAction={onAction} background={background}>{node}</ActionRoot></LanguageRoot>);
  return { onAction, background };
}

const chip = (p: Partial<GitChipProps> = {}): GitChipProps => ({ kind: 'ok', worktree: false, name: 'fix-login', title: 'fix-login', value: '未コミット 7', count: 7, dirty: true, shared: 2, sharedTitle: '同じ作業ツリーで実行中のセッションがほかに 1 件あります', label: 'ブランチ fix-login、未コミット 7', ...p });

const files = presentGitFiles(ja, {
  state: 'ok', root: '/w', tree: null,
  files: [{ path: '/w/a.ts', rel: 'a.ts', status: 'M', added: 2, deleted: 1, binary: false }, { path: '/w/b.ts', rel: 'b.ts', status: 'U', added: 3, deleted: 0, binary: false }],
  others: [{ path: '/w/x.json', rel: 'x.json', status: 'M', added: 1, deleted: 1, binary: false }], othersCapped: false,
});

describe('GitChip', () => {
  it('ブランチ、件数、共有を出し、読み上げは 1 文で言う', () => {
    mount(<GitChip id="c1" chip={chip()} />);
    expect(screen.getByText('ブランチ fix-login、未コミット 7')).toHaveClass('sr-only');
    expect(screen.getByText('fix-login')).toBeInTheDocument();
    expect(screen.getByText('共有 2')).toHaveAttribute('title', '同じ作業ツリーで実行中のセッションがほかに 1 件あります');
  });
  it('worktree は小札を添える', () => {
    mount(<GitChip id="c2" chip={chip({ worktree: true, name: 'pay', shared: null, sharedTitle: null })} />);
    expect(screen.getByText('worktree')).toBeInTheDocument();
  });
});

describe('GitFileList', () => {
  it('行を押すと選ぶ。ほかに変わったファイルは畳んだ行で、開くと注記を添える', () => {
    const onPick = vi.fn();
    mount(<GitFileList files={files} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'b.ts の差分を表示' }));
    expect(onPick).toHaveBeenCalledWith('/w/b.ts');
    expect(screen.queryByText('x.json')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ほかに作業ツリーで変わったファイル 1 件' }));
    expect(screen.getByText('x.json')).toBeInTheDocument();
    expect(screen.getByText(/このセッションの変更とは限りません/)).toBeInTheDocument();
  });
});

describe('DiffDialog', () => {
  const props = (p: Partial<DiffDialogProps> = {}): DiffDialogProps => ({
    sessionId: 's1', name: 'ログイン', chip: chip(), files, source: 'git', canGit: true, selected: '/w/a.ts', selectedRow: files.files[0]!,
    body: { kind: 'hunks', hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [{ t: 'del', old: 1, new: null, text: 'a' }, { t: 'add', old: null, new: 1, text: 'b' }] }], truncated: false, line: 1 },
    line: 4, openLabel: 'VS Code で開く', load: { type: 'git.diff.load', sessionId: 's1', file: '/w/a.ts' }, ...p,
  });
  it('開いたら一覧と右の中身を読み、主ボタンで選んだ行を開く', () => {
    const m = mount(<DiffDialog {...props()} />);
    expect(m.onAction).toHaveBeenCalledWith({ type: 'git.changes.load', sessionId: 's1' });
    expect(m.onAction).toHaveBeenCalledWith({ type: 'git.diff.load', sessionId: 's1', file: '/w/a.ts' });
    fireEvent.click(screen.getByRole('button', { name: 'VS Code で開く' }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'session.openFile', sessionId: 's1', path: '/w/a.ts', line: 4 });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('b')).toBeInTheDocument();
  });
  it('↓ で次のファイル、e で開く。出どころを替えられる', () => {
    const m = mount(<DiffDialog {...props()} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'diff.select', file: '/w/b.ts' });
    fireEvent.keyDown(dialog, { key: 'e' });
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'session.openFile', sessionId: 's1', path: '/w/a.ts', line: 4 });
    fireEvent.click(screen.getByRole('radio', { name: 'このセッションの編集' }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'diff.source', source: 'session' });
  });
  it('git でなければ切り替えを出さず、このセッションの編集だけと言う', () => {
    mount(<DiffDialog {...props({ canGit: false, source: 'session', body: { kind: 'note', text: 'このファイルへの編集はトランスクリプトにありません。', line: 1 } })} />);
    expect(screen.queryByRole('radio', { name: '作業ツリーとの差（git）' })).toBeNull();
    expect(screen.getByText('git の作業ツリーの外のため、このセッションの編集だけを表示します。')).toBeInTheDocument();
  });
});

describe('一覧の行の git の札', () => {
  const row = (id: string, git: GitChipProps | null): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '', filesChanged: 0, prUrl: null, hasTranscript: true, cost: '', runId: null, transcript: 'present', state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, git });
  it('2 段目の右端に札を出し、見えている行の git を裏の道で頼む。外れたら取り下げる', () => {
    const background = vi.fn<(a: UiAction) => void>();
    const onAction = vi.fn<(a: UiAction) => void>();
    const view = render(<LanguageRoot language="ja"><ActionRoot onAction={onAction} background={background}><SessionRows id="home-list" rows={[row('a', chip({ shared: null, sharedTitle: null })), row('b', null)]} height={400} variant="search" /></ActionRoot></LanguageRoot>);
    expect(screen.getByText('fix-login')).toBeInTheDocument();
    expect(background).toHaveBeenCalledWith({ type: 'git.watch', key: 'rows:home-list', sessionIds: ['a', 'b'] });
    expect(onAction).not.toHaveBeenCalled();
    view.unmount();
    expect(background).toHaveBeenLastCalledWith({ type: 'git.watch', key: 'rows:home-list', sessionIds: [] });
  });
});
