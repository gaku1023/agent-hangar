import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { NewProjectDialog } from './NewProjectDialog.tsx';
import { RetentionDialog } from './RetentionDialog.tsx';
import type { NewProjectProps } from '../presenters/newProject.ts';
import type { UiAction } from '@agent-hangar/shared';
import { revealWithin } from './primitives/revealWithin.ts';

// 一覧の中だけをスクロールしたかを確かめるため、寄せる関数を差し替える。
vi.mock('./primitives/revealWithin.ts', () => ({ revealWithin: vi.fn() }));

describe('ConfirmDialog', () => {
  it('大きさを並べ、上書きして再開を出す', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={{ kind: 'overwriteTranscript', sessionId: 's1', localSize: 1024, remoteSize: 4096 }} /></ActionRoot>);
    expect(screen.getByText('この PC のトランスクリプト 1.0 KB')).toBeInTheDocument();
    expect(screen.getByText('他の PC のトランスクリプト 4.0 KB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '上書きして再開' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.resumeHere', id: 's1', overwrite: true });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('バックアップの置き場を書き、大きいものは MB で出す', () => {
    render(<ActionRoot onAction={() => {}}><ConfirmDialog confirm={{ kind: 'overwriteTranscript', sessionId: 's1', localSize: 3 * 1024 * 1024, remoteSize: 5 * 1024 * 1024 }} /></ActionRoot>);
    expect(screen.getByText('この PC のトランスクリプト 3.0 MB')).toBeInTheDocument();
    expect(screen.getByText(/~\/\.agent-hangar\/backups\/transcripts\//)).toBeInTheDocument();
  });
});

describe('ConfirmDialog の器', () => {
  it('上書きの確認は見出しが名前で、危険の丸は付けず、キャンセル側にフォーカスを置く', () => {
    render(<ActionRoot onAction={() => {}}><ConfirmDialog confirm={{ kind: 'overwriteTranscript', sessionId: 's1', localSize: 1, remoteSize: 2 }} /></ActionRoot>);
    const dialog = screen.getByRole('dialog', { name: 'トランスクリプトを置き換えますか' });
    expect(dialog.classList.contains('dialog-danger')).toBe(false);
    expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveFocus();
  });
  it('Esc と背景で閉じる', () => {
    const onAction = vi.fn();
    const { container } = render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: true, shellTabs: 0 }} /></ActionRoot>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'キャンセル' }), { key: 'Escape' });
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onAction.mock.calls).toEqual([[{ type: 'overlay.close' }], [{ type: 'overlay.close' }]]);
  });
});

describe('ConfirmDialog（引き取り）', () => {
  it('外部ターミナルの claude が終わることと、問いが閉じることを書き、承諾で移動する', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={{ kind: 'adoptSession', sessionId: 's1' }} /></ActionRoot>);
    expect(screen.getByRole('dialog', { name: 'hangar に移動しますか' })).toBeInTheDocument();
    // 引き取った会話は hangar の tmux の中で再開する。元のターミナルからは包み方を通した claude -r で戻る。
    expect(screen.getByText(/claude -r/)).toBeInTheDocument();
    expect(screen.queryByText(/claude attach/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'hangar に移動' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.adopt', id: 's1', confirmed: true });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ConfirmDialog（停止）', () => {
  it('作業中であることとシェルタブの数を書き、承諾で止める', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: true, shellTabs: 2 }} /></ActionRoot>);
    const dialog = screen.getByRole('dialog', { name: '停止しますか' });
    // 取り消せない確認は、見出しの前に赤い丸のアイコンを置き、押し切るボタンを赤で塗る（E1）。
    expect(dialog.classList.contains('dialog-danger')).toBe(true);
    expect(dialog.querySelector('.dialog-disc [data-icon="stop"]')).not.toBeNull();
    expect(screen.getByText(/作業中です/)).toBeInTheDocument();
    expect(screen.getByText(/シェルタブ 2 枚も閉じます/)).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: '停止' });
    expect(stop).toHaveClass('btn-danger-fill');
    fireEvent.click(stop);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 2, confirmed: true });
  });
  it('休みなら作業中とは書かず、既定のフォーカスはキャンセル側に置く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: false, shellTabs: 1 }} /></ActionRoot>);
    expect(screen.queryByText(/作業中です/)).toBeNull();
    expect(screen.getByText(/シェルタブ 1 枚も閉じます/)).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'キャンセル' });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('シェルタブが無ければその一文を出さない', () => {
    render(<ActionRoot onAction={() => {}}><ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: true, shellTabs: 0 }} /></ActionRoot>);
    expect(screen.queryByText(/シェルタブ/)).toBeNull();
  });
});

describe('ConfirmDialog（一覧から削除）', () => {
  it('名前と未分類に戻る件数と、他の PC からも削除されることを書き、承諾で送る', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={{ kind: 'unlinkProject', projectId: 'p1' }} project={{ name: 'alpha', sessions: 3 }} /></ActionRoot>);
    const dialog = screen.getByRole('dialog', { name: '一覧から削除しますか' });
    expect(dialog.querySelector('.dialog-disc [data-icon="unlink"]')).not.toBeNull();
    expect(dialog).toHaveTextContent('プロジェクト alpha を一覧から削除し、3 件のセッションを未分類に戻します。');
    expect(dialog).toHaveTextContent('同期している他の PC からも削除されます。');
    const remove = screen.getByRole('button', { name: '一覧から削除' });
    expect(remove).toHaveClass('btn-danger-fill');
    fireEvent.click(remove);
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' }, confirmed: true });
  });
  it('既定のフォーカスはキャンセル側に置き、キャンセルすると閉じる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={{ kind: 'unlinkProject', projectId: 'p1' }} project={{ name: 'alpha', sessions: 0 }} /></ActionRoot>);
    const cancel = screen.getByRole('button', { name: 'キャンセル' });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ConfirmDialog（アカウントの切り替え）', () => {
  const sw = (working: boolean) => ({ kind: 'switchAccount' as const, sessionId: 's1', accountId: 'a1', working });
  it('見出しに名前を出し、止めて同じ会話を再開することと、新しいセッションの既定も変わることを書く。承諾で確認つきの UiAction を出す', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={sw(false)} accountName="大学" /></ActionRoot>);
    const dialog = screen.getByRole('dialog', { name: '大学 に切り替えますか？' });
    expect(dialog).toHaveTextContent('このセッションの Claude をいったん停止し、同じ会話を 大学 で再開します。');
    expect(dialog).toHaveTextContent('新しいセッションの既定も 大学 になります。');
    expect(dialog).not.toHaveTextContent('途中の作業が中断されます。');
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: false, confirmed: true });
  });
  it('作業中のときだけ、途中の作業が中断されることを注意として足す', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={sw(true)} accountName="大学" /></ActionRoot>);
    const dialog = screen.getByRole('dialog', { name: '大学 に切り替えますか？' });
    expect(dialog).toHaveTextContent('途中の作業が中断されます。');
    // 取り消せる操作なので、危険の丸も赤いボタンも使わない。承諾は引き取りの確認と同じ強さである。
    expect(dialog.classList.contains('dialog-danger')).toBe(false);
    expect(screen.getByRole('button', { name: '切り替える' })).toHaveClass('btn-primary');
    expect(screen.getByRole('button', { name: '切り替える' })).not.toHaveClass('btn-danger-fill');
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: true, confirmed: true });
  });
  it('キャンセル側にフォーカスを置き、キャンセルすると閉じる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={sw(true)} accountName="大学" /></ActionRoot>);
    const cancel = screen.getByRole('button', { name: 'キャンセル' });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'account.switchSession' }));
  });
  it('名前が一覧に無いときは id を名前の代わりにする', () => {
    render(<ActionRoot onAction={() => {}}><ConfirmDialog confirm={sw(false)} accountName={null} /></ActionRoot>);
    expect(screen.getByRole('dialog', { name: 'a1 に切り替えますか？' })).toBeInTheDocument();
  });
});

describe('ConfirmDialog（登録を解除する）', () => {
  const rm = { kind: 'removeAccount' as const, accountId: 'a1' };
  it('見出しに名前を出し、設定ディレクトリは残ることと、このアカウントのセッションはメインアカウントで再開することを書き、承諾で外す', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={rm} accountName="大学" /></ActionRoot>);
    const dialog = screen.getByRole('dialog', { name: '大学 の登録を解除しますか？' });
    expect(dialog).toHaveTextContent('登録を解除するだけで、設定ディレクトリ（ログインと設定のリンク）は残ります。');
    expect(dialog).toHaveTextContent('このアカウントで動かしたセッションは、次からメインアカウントで再開します。');
    // 同じ種類の「一覧から削除」と同じく、赤い丸と赤く塗った承諾のボタンで、並びも「やめる」が承諾の左に寄る。
    expect(dialog.classList.contains('dialog-danger')).toBe(true);
    expect(dialog.querySelector('.dialog-disc [data-icon="unlink"]')).not.toBeNull();
    const remove = screen.getByRole('button', { name: '登録を解除' });
    expect(remove).toHaveClass('btn-danger', 'btn-danger-fill');
    expect(remove.querySelector('[data-icon="unlink"]')).not.toBeNull();
    const footer = remove.parentElement!;
    expect([...footer.children].map((c) => c.textContent)).toEqual(['', 'キャンセル', '登録を解除']);
    expect(footer.children[0]).toHaveClass('spacer');
    fireEvent.click(remove);
    expect(onAction).toHaveBeenCalledWith({ type: 'account.remove', accountId: 'a1', confirmed: true });
  });
  it('キャンセル側にフォーカスを置き、キャンセルすると閉じる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ConfirmDialog confirm={rm} accountName="大学" /></ActionRoot>);
    const cancel = screen.getByRole('button', { name: 'キャンセル' });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('名前が一覧に無いときは id を名前の代わりにする', () => {
    render(<ActionRoot onAction={() => {}}><ConfirmDialog confirm={rm} accountName={null} /></ActionRoot>);
    expect(screen.getByRole('dialog', { name: 'a1 の登録を解除しますか？' })).toBeInTheDocument();
  });
});

describe('RetentionDialog', () => {
  const base = {
    title: 'トランスクリプトの保持期間を 1 年にします', lead: 'Claude Code の設定ファイルに、次の 1 行を足します。', path: '/Users/me/.claude/settings.json',
    lines: [{ kind: 'ctx' as const, text: '{' }, { kind: 'del' as const, text: '  "cleanupPeriodDays": 30,' }, { kind: 'add' as const, text: '  "cleanupPeriodDays": 365,' }],
    bar: { nowLabel: 'いま 1.5 GB', projLabel: '1 年たつと約 18 GB', freeLabel: '空き 400 GB', nowPct: 0.4, projPct: 4.4, warn: false },
    backupDir: '/Users/me/.agent-hangar/backups/claude-config/', otherPcs: true, shrinkNote: null, reloaded: false, showOther: true, writing: false, previewError: null,
  };
  it('差分を印付きで描き、見込みとバックアップと他の PC を並べる', () => {
    render(<ActionRoot onAction={() => {}}><RetentionDialog {...base} /></ActionRoot>);
    expect(screen.getByText(/^\+\s+"cleanupPeriodDays": 365,$/)).toBeInTheDocument();
    expect(screen.getByText(/^-\s+"cleanupPeriodDays": 30,$/)).toBeInTheDocument();
    expect(screen.getByText('1 年たつと約 18 GB')).toBeInTheDocument();
    expect(screen.getByText('/Users/me/.agent-hangar/backups/claude-config/')).toBeInTheDocument();
    expect(screen.getByText('設定の同期で、次の適用時に届きます')).toBeInTheDocument();
    expect(screen.getByText('復元できません。これから先のトランスクリプトが残ります')).toBeInTheDocument();
  });
  it('見出しが器の名前で、既定のフォーカスはキャンセル側に置く', () => {
    render(<ActionRoot onAction={() => {}}><RetentionDialog {...base} /></ActionRoot>);
    expect(screen.getByRole('dialog', { name: 'トランスクリプトの保持期間を 1 年にします' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveFocus();
  });
  it('書き込んでいる間は Esc でも閉じない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><RetentionDialog {...base} writing /></ActionRoot>);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onAction).not.toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('書き込み、ほかの期間、キャンセルがそれぞれの UiAction を出す', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><RetentionDialog {...base} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: '書き込み' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'retention.write' });
    fireEvent.click(screen.getByRole('button', { name: 'ほかの期間…' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'retention.settings' });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('書き込んでいる間は、キャンセルも背景も閉じる UiAction を出さない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><RetentionDialog {...base} writing /></ActionRoot>);
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled();
    fireEvent.click(document.querySelector('.overlay')!);
    expect(onAction).not.toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('下見に失敗したら、読み込み中ではなく理由を出す', () => {
    render(<ActionRoot onAction={() => {}}><RetentionDialog {...base} lines={null} previewError="設定ファイルの書式を読み取れなかったので書き換えませんでした" /></ActionRoot>);
    expect(screen.getByRole('alert')).toHaveTextContent('設定ファイルの書式を読み取れなかったので書き換えませんでした');
    expect(screen.queryByText('差分を読み込んでいます')).toBeNull();
    expect(screen.getByRole('button', { name: '書き込み' })).toBeDisabled();
  });
  it('送信中と、差分がまだ無いときは書き込めない。読み直したことを出す', () => {
    const { rerender } = render(<ActionRoot onAction={() => {}}><RetentionDialog {...base} writing /></ActionRoot>);
    expect(screen.getByRole('button', { name: '書き込み' })).toBeDisabled();
    rerender(<ActionRoot onAction={() => {}}><RetentionDialog {...base} lines={null} reloaded showOther={false} otherPcs={false} /></ActionRoot>);
    expect(screen.getByRole('button', { name: '書き込み' })).toBeDisabled();
    expect(screen.getByText('設定ファイルが外部で変更されたため、再読み込みしました。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ほかの期間…' })).toBeNull();
    expect(screen.queryByText('設定の同期で、次の適用時に届きます')).toBeNull();
  });
});

describe('NewProjectDialog', () => {
  const base: NewProjectProps = { dirs: [{ name: 'design-notes', path: '/w/design-notes' }, { name: 'Puzzle2', path: '/w/Puzzle2' }], workspaceRoot: '/w', desktop: true, picked: null, submitting: false, error: null };
  const collect = (over: Partial<NewProjectProps> = {}) => {
    const out: UiAction[] = [];
    const view = render(<ActionRoot onAction={(i) => out.push(i)}><NewProjectDialog {...base} {...over} /></ActionRoot>);
    return { out, view };
  };
  it('新しいフォルダを作成：名前と git init で「作成」と「作成して開始」を送る', () => {
    const { out } = collect();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新しいプロジェクト');
    fireEvent.change(screen.getByLabelText('プロジェクト名'), { target: { value: 'price-watcher' } });
    expect(screen.getByText('/w/price-watcher を作成します')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'git init を実行' }));
    fireEvent.click(screen.getByRole('button', { name: '作成して開始' }));
    expect(out.filter((i) => i.type === 'project.new.submit')).toEqual([
      { type: 'project.new.submit', place: { kind: 'newDir', name: 'price-watcher', gitInit: true }, startSession: false },
      { type: 'project.new.submit', place: { kind: 'newDir', name: 'price-watcher', gitInit: false }, startSession: true },
    ]);
  });
  it('既存のフォルダを登録：一覧から選ぶと名前に basename が入り、直した名前で送る', () => {
    const { out } = collect();
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    fireEvent.click(screen.getByRole('option', { name: 'design-notes' }));
    expect(screen.getByLabelText('プロジェクト名')).toHaveValue('design-notes');
    fireEvent.change(screen.getByLabelText('プロジェクト名'), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    expect(out.find((i) => i.type === 'project.new.submit')).toEqual({ type: 'project.new.submit', place: { kind: 'dir', path: '/w/design-notes', name: 'notes' }, startSession: false });
  });
  it('既存のフォルダを登録：一覧は名前で絞れ、パスを打っても選べる', () => {
    const { out } = collect();
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    fireEvent.change(screen.getByLabelText('プロジェクトの親フォルダの未登録のフォルダを検索'), { target: { value: 'puz' } });
    expect(screen.queryByRole('option', { name: 'design-notes' })).toBeNull();
    fireEvent.change(screen.getByLabelText('フォルダのパス'), { target: { value: '/Users/me/thesis' } });
    expect(screen.getByLabelText('プロジェクト名')).toHaveValue('thesis');
    fireEvent.click(screen.getByRole('button', { name: '作成して開始' }));
    expect(out.find((i) => i.type === 'project.new.submit')).toEqual({ type: 'project.new.submit', place: { kind: 'dir', path: '/Users/me/thesis', name: 'thesis' }, startSession: true });
  });
  it('既存のフォルダを登録：検索欄から ↓ と Enter で一覧の行を選べ、Enter では送信しない', () => {
    const { out } = collect();
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    const search = screen.getByRole('combobox', { name: 'プロジェクトの親フォルダの未登録のフォルダを検索' });
    search.focus();
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'design-notes' }).id);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const second = screen.getByRole('option', { name: 'Puzzle2' });
    expect(search).toHaveAttribute('aria-activedescendant', second.id);
    expect(second).toHaveAttribute('data-active', 'true');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByLabelText('プロジェクト名')).toHaveValue('Puzzle2');
    expect(screen.getByLabelText('フォルダのパス')).toHaveValue('/w/Puzzle2');
    expect(out.filter((i) => i.type === 'project.new.submit')).toEqual([]);
  });
  it('既存のフォルダを登録：↑↓ で動かした行を、一覧の箱の中だけで見える位置へ寄せる', () => {
    collect();
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    vi.mocked(revealWithin).mockClear();
    const search = screen.getByRole('combobox', { name: 'プロジェクトの親フォルダの未登録のフォルダを検索' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const rows = screen.getByRole('listbox', { name: 'プロジェクトの親フォルダの未登録のフォルダ' });
    expect(revealWithin).toHaveBeenLastCalledWith(rows, screen.getByRole('option', { name: 'Puzzle2' }));
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(revealWithin).toHaveBeenLastCalledWith(rows, screen.getByRole('option', { name: 'design-notes' }));
  });
  it('既存のフォルダを登録：名前を空にしたら名前を送らず、サーバに basename を使わせる', () => {
    const { out } = collect();
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    fireEvent.click(screen.getByRole('option', { name: 'design-notes' }));
    fireEvent.change(screen.getByLabelText('プロジェクト名'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    const sent = out.find((i) => i.type === 'project.new.submit');
    expect(sent).toEqual({ type: 'project.new.submit', place: { kind: 'dir', path: '/w/design-notes' }, startSession: false });
    expect(sent?.type === 'project.new.submit' && sent.place.name).toBeUndefined();
  });
  it('新しいフォルダを作成：名前の欄の Enter は「作成して開始」として送る', () => {
    const { out } = collect();
    const field = screen.getByLabelText('プロジェクト名');
    fireEvent.change(field, { target: { value: 'price-watcher' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(out.find((i) => i.type === 'project.new.submit')).toEqual({ type: 'project.new.submit', place: { kind: 'newDir', name: 'price-watcher', gitInit: true }, startSession: true });
  });
  it('「ほかの場所を選択…」は殻の中だけ。選ばれたパスをパスの欄に入れる。開いた時点の結果は使わない', () => {
    const { out, view } = collect({ picked: { path: '/old', n: 2 } });
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    expect(screen.getByLabelText('フォルダのパス')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'ほかの場所を選択…' }));
    expect(out).toContainEqual({ type: 'folder.pick' });
    view.rerender(<ActionRoot onAction={(i) => out.push(i)}><NewProjectDialog {...base} picked={{ path: '/Users/me/thesis', n: 3 }} /></ActionRoot>);
    expect(screen.getByLabelText('フォルダのパス')).toHaveValue('/Users/me/thesis');
    view.unmount();
    collect({ desktop: false });
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    expect(screen.queryByRole('button', { name: 'ほかの場所を選択…' })).toBeNull();
  });
  it('送信中は両方のボタンを押せず、失敗の文言を出し、背景では閉じない', () => {
    const { out, view } = collect({ submitting: true, error: '/w/price-watcher は既にあります' });
    expect(screen.getByRole('button', { name: '作成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '作成して開始' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('/w/price-watcher は既にあります');
    fireEvent.click(view.container.querySelector('.overlay')!);
    expect(out).toEqual([]);
  });
});
