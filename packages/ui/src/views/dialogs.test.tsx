import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { ConfigPreviewDialog } from './ConfigPreviewDialog.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { RetentionDialog } from './RetentionDialog.tsx';

describe('ConfirmDialog', () => {
  it('大きさを並べ、上書きして再開を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={{ kind: 'overwriteTranscript', sessionId: 's1', localSize: 1024, remoteSize: 4096 }} /></IntentRoot>);
    expect(screen.getByText('この PC の本文 1.0 KB')).toBeInTheDocument();
    expect(screen.getByText('他の PC の本文 4.0 KB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '上書きして再開' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.resumeHere', id: 's1', overwrite: true });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('控えの置き場を書き、大きいものは MB で出す', () => {
    render(<IntentRoot onIntent={() => {}}><ConfirmDialog confirm={{ kind: 'overwriteTranscript', sessionId: 's1', localSize: 3 * 1024 * 1024, remoteSize: 5 * 1024 * 1024 }} /></IntentRoot>);
    expect(screen.getByText('この PC の本文 3.0 MB')).toBeInTheDocument();
    expect(screen.getByText(/~\/\.agent-hangar\/backups\/transcripts\//)).toBeInTheDocument();
  });
});

describe('ConfirmDialog の器', () => {
  it('上書きの確認は見出しが名前で、危険の丸は付けず、やめる側にフォーカスを置く', () => {
    render(<IntentRoot onIntent={() => {}}><ConfirmDialog confirm={{ kind: 'overwriteTranscript', sessionId: 's1', localSize: 1, remoteSize: 2 }} /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: '本文を置き換えますか' });
    expect(dialog.classList.contains('dialog-danger')).toBe(false);
    expect(screen.getByRole('button', { name: 'やめる' })).toHaveFocus();
  });
  it('Esc と背景で閉じる', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: true, shellTabs: 0 }} /></IntentRoot>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'やめる' }), { key: 'Escape' });
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onIntent.mock.calls).toEqual([[{ type: 'overlay.close' }], [{ type: 'overlay.close' }]]);
  });
});

describe('ConfirmDialog（引き取り）', () => {
  it('外のターミナルの claude が終わることと、問いが閉じることを書き、承諾で引き取る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={{ kind: 'adoptSession', sessionId: 's1' }} /></IntentRoot>);
    expect(screen.getByRole('dialog', { name: 'hangar で引き取りますか' })).toBeInTheDocument();
    // 引き取った会話は hangar の tmux の中で再開する。元のターミナルからは包み方を通した claude -r で戻る。
    expect(screen.getByText(/claude -r/)).toBeInTheDocument();
    expect(screen.queryByText(/claude attach/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '引き取る' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.adopt', id: 's1', confirmed: true });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ConfirmDialog（停止）', () => {
  it('作業中であることとシェルタブの数を書き、承諾で止める', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: true, shellTabs: 2 }} /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: '停止しますか' });
    // 取り消せない確認は、見出しの前に赤い丸のアイコンを置き、押し切るボタンを赤で塗る（E1）。
    expect(dialog.classList.contains('dialog-danger')).toBe(true);
    expect(dialog.querySelector('.dialog-disc [data-icon="stop"]')).not.toBeNull();
    expect(screen.getByText(/作業中です/)).toBeInTheDocument();
    expect(screen.getByText(/シェルタブ 2 枚も閉じます/)).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: '停止する' });
    expect(stop).toHaveClass('btn-danger-fill');
    fireEvent.click(stop);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 2, confirmed: true });
  });
  it('休みなら作業中とは書かず、既定のフォーカスはやめる側に置く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: false, shellTabs: 1 }} /></IntentRoot>);
    expect(screen.queryByText(/作業中です/)).toBeNull();
    expect(screen.getByText(/シェルタブ 1 枚も閉じます/)).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'やめる' });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('シェルタブが無ければその一文を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: true, shellTabs: 0 }} /></IntentRoot>);
    expect(screen.queryByText(/シェルタブ/)).toBeNull();
  });
});

describe('ConfirmDialog（一覧から削除）', () => {
  it('名前と未分類に戻る件数と、他の PC からも消えることを書き、承諾で送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={{ kind: 'unlinkProject', projectId: 'p1' }} project={{ name: 'alpha', sessions: 3 }} /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: '一覧から削除しますか' });
    expect(dialog.querySelector('.dialog-disc [data-icon="unlink"]')).not.toBeNull();
    expect(dialog).toHaveTextContent('プロジェクト alpha を一覧から削除し、3 件のセッションを未分類に戻します。');
    expect(dialog).toHaveTextContent('同期している他の PC からも消えます。');
    const remove = screen.getByRole('button', { name: '一覧から削除' });
    expect(remove).toHaveClass('btn-danger-fill');
    fireEvent.click(remove);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' }, confirmed: true });
  });
  it('既定のフォーカスはやめる側に置き、やめると閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={{ kind: 'unlinkProject', projectId: 'p1' }} project={{ name: 'alpha', sessions: 0 }} /></IntentRoot>);
    const cancel = screen.getByRole('button', { name: 'やめる' });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ConfirmDialog（アカウントの切り替え）', () => {
  const sw = (working: boolean) => ({ kind: 'switchAccount' as const, sessionId: 's1', accountId: 'a1', working });
  it('見出しに名前を出し、止めて同じ会話を再開することと、新しいセッションの既定も変わることを書く。承諾で確認つきの Intent を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={sw(false)} accountName="大学" /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: '大学 に切り替えますか？' });
    expect(dialog).toHaveTextContent('このセッションの Claude をいったん止め、同じ会話を 大学 で再開します。');
    expect(dialog).toHaveTextContent('新しいセッションの既定も 大学 になります。');
    expect(dialog).not.toHaveTextContent('途中の作業が中断されます。');
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: false, confirmed: true });
  });
  it('作業中のときだけ、途中の作業が中断されることを注意として足す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={sw(true)} accountName="大学" /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: '大学 に切り替えますか？' });
    expect(dialog).toHaveTextContent('途中の作業が中断されます。');
    // 取り消せる操作なので、危険の丸も赤いボタンも使わない。承諾は引き取りの確認と同じ強さである。
    expect(dialog.classList.contains('dialog-danger')).toBe(false);
    expect(screen.getByRole('button', { name: '切り替える' })).toHaveClass('btn-primary');
    expect(screen.getByRole('button', { name: '切り替える' })).not.toHaveClass('btn-danger-fill');
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: true, confirmed: true });
  });
  it('やめる側にフォーカスを置き、やめると閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={sw(true)} accountName="大学" /></IntentRoot>);
    const cancel = screen.getByRole('button', { name: 'やめる' });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
    expect(onIntent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'account.switchSession' }));
  });
  it('名前が一覧に無いときは id を名前の代わりにする', () => {
    render(<IntentRoot onIntent={() => {}}><ConfirmDialog confirm={sw(false)} accountName={null} /></IntentRoot>);
    expect(screen.getByRole('dialog', { name: 'a1 に切り替えますか？' })).toBeInTheDocument();
  });
});

describe('ConfirmDialog（アカウントを一覧から外す）', () => {
  const rm = { kind: 'removeAccount' as const, accountId: 'a1' };
  it('見出しに名前を出し、置き場は残ることと、このアカウントのセッションは最初のアカウントで再開することを書き、承諾で外す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={rm} accountName="大学" /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: '大学 を一覧から外しますか？' });
    expect(dialog).toHaveTextContent('登録を外すだけで、置き場（ログインと設定のリンク）は残ります。');
    expect(dialog).toHaveTextContent('このアカウントで動かしたセッションは、次から最初のアカウントで再開します。');
    // 同じ種類の「一覧から削除」と同じく、赤い丸と赤く塗った承諾のボタンで、並びも「やめる」が承諾の左に寄る。
    expect(dialog.classList.contains('dialog-danger')).toBe(true);
    expect(dialog.querySelector('.dialog-disc [data-icon="unlink"]')).not.toBeNull();
    const remove = screen.getByRole('button', { name: '外す' });
    expect(remove).toHaveClass('btn-danger', 'btn-danger-fill');
    expect(remove.querySelector('[data-icon="unlink"]')).not.toBeNull();
    const footer = remove.parentElement!;
    expect([...footer.children].map((c) => c.textContent)).toEqual(['', 'やめる', '外す']);
    expect(footer.children[0]).toHaveClass('spacer');
    fireEvent.click(remove);
    expect(onIntent).toHaveBeenCalledWith({ type: 'account.remove', accountId: 'a1', confirmed: true });
  });
  it('やめる側にフォーカスを置き、やめると閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={rm} accountName="大学" /></IntentRoot>);
    const cancel = screen.getByRole('button', { name: 'やめる' });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('名前が一覧に無いときは id を名前の代わりにする', () => {
    render(<IntentRoot onIntent={() => {}}><ConfirmDialog confirm={rm} accountName={null} /></IntentRoot>);
    expect(screen.getByRole('dialog', { name: 'a1 を一覧から外しますか？' })).toBeInTheDocument();
  });
});

describe('ConfigPreviewDialog', () => {
  it('一覧を出し、取り込むが Intent になる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfigPreviewDialog preview={{ confirmed: false, entries: [
      { path: 'CLAUDE.md', action: 'create', localMtime: null, remoteMtime: 2, remoteDevice: 'mini', size: 10 },
      { path: 'skills/foo/SKILL.md', action: 'conflict', localMtime: 1, remoteMtime: 2, remoteDevice: 'mini', size: 20 },
    ] }} /></IntentRoot>);
    expect(screen.getByText('CLAUDE.md')).toBeInTheDocument();
    expect(screen.getByText('新しく作る')).toBeInTheDocument();
    expect(screen.getByText('競合（控えを残します）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取り込む' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.config.apply' });
  });
  it('既定のフォーカスはやめる側に置き、背景を押すと閉じる', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><ConfigPreviewDialog preview={{ confirmed: false, entries: [] }} /></IntentRoot>);
    expect(screen.getByRole('dialog', { name: '~/.claude に取り込む内容' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'やめる' })).toHaveFocus();
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('一覧がまだ来ていなければ読み込み中', () => {
    render(<IntentRoot onIntent={() => {}}><ConfigPreviewDialog preview={null} /></IntentRoot>);
    expect(screen.getByText('取り込む内容を調べています')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取り込む' })).toBeDisabled();
  });
  it('内訳の件数と控えの置き場を出す', () => {
    render(<IntentRoot onIntent={() => {}}><ConfigPreviewDialog preview={{ confirmed: false, entries: [
      { path: 'CLAUDE.md', action: 'create', localMtime: null, remoteMtime: 2, remoteDevice: 'mini', size: 10 },
      { path: 'settings.json', action: 'overwrite', localMtime: 1, remoteMtime: 2, remoteDevice: 'mini', size: 20 },
      { path: 'memory/MEMORY.md', action: 'conflict', localMtime: 1, remoteMtime: 2, remoteDevice: 'mini', size: 30 },
      { path: 'skills/a/SKILL.md', action: 'skip', localMtime: 2, remoteMtime: 2, remoteDevice: 'mini', size: 40 },
    ] }} /></IntentRoot>);
    expect(screen.getByText('新しく作る 1 件、上書きする 1 件、競合 1 件、変更なし 1 件')).toBeInTheDocument();
    expect(screen.getByText(/~\/\.agent-hangar\/backups\/claude-config\//)).toBeInTheDocument();
  });
  it('取り込むものが無ければそう出し、取り込むを押せなくする', () => {
    render(<IntentRoot onIntent={() => {}}><ConfigPreviewDialog preview={{ confirmed: false, entries: [] }} /></IntentRoot>);
    expect(screen.getByText('取り込むものはありません')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取り込む' })).toBeDisabled();
  });
});

describe('RetentionDialog', () => {
  const base = {
    title: '会話の保持期間を 1 年にします', lead: 'Claude Code の設定ファイルに、次の 1 行を足します。', path: '/Users/me/.claude/settings.json',
    lines: [{ kind: 'ctx' as const, text: '{' }, { kind: 'del' as const, text: '  "cleanupPeriodDays": 30,' }, { kind: 'add' as const, text: '  "cleanupPeriodDays": 365,' }],
    bar: { nowLabel: 'いま 1.5 GB', projLabel: '1 年たつと約 18 GB', freeLabel: '空き 400 GB', nowPct: 0.4, projPct: 4.4, warn: false },
    backupDir: '/Users/me/.agent-hangar/backups/claude-config/', otherPcs: true, shrinkNote: null, reloaded: false, showOther: true, writing: false, previewError: null,
  };
  it('差分を印付きで描き、見込みと控えと他の PC を並べる', () => {
    render(<IntentRoot onIntent={() => {}}><RetentionDialog {...base} /></IntentRoot>);
    expect(screen.getByText(/^\+\s+"cleanupPeriodDays": 365,$/)).toBeInTheDocument();
    expect(screen.getByText(/^-\s+"cleanupPeriodDays": 30,$/)).toBeInTheDocument();
    expect(screen.getByText('1 年たつと約 18 GB')).toBeInTheDocument();
    expect(screen.getByText('/Users/me/.agent-hangar/backups/claude-config/')).toBeInTheDocument();
    expect(screen.getByText('設定の同期で、次の取り込み時に届きます')).toBeInTheDocument();
    expect(screen.getByText('取り戻せません。これから先の会話が残ります')).toBeInTheDocument();
  });
  it('見出しが器の名前で、既定のフォーカスはやめる側に置く', () => {
    render(<IntentRoot onIntent={() => {}}><RetentionDialog {...base} /></IntentRoot>);
    expect(screen.getByRole('dialog', { name: '会話の保持期間を 1 年にします' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'やめる' })).toHaveFocus();
  });
  it('書き込んでいる間は Esc でも閉じない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><RetentionDialog {...base} writing /></IntentRoot>);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('書き込む、ほかの期間、やめるがそれぞれの Intent を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><RetentionDialog {...base} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '書き込む' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'retention.write' });
    fireEvent.click(screen.getByRole('button', { name: 'ほかの期間…' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'retention.settings' });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('書き込んでいる間は、やめるも背景も閉じる Intent を出さない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><RetentionDialog {...base} writing /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'やめる' })).toBeDisabled();
    fireEvent.click(document.querySelector('.overlay')!);
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('下見に失敗したら、読み込み中ではなく理由を出す', () => {
    render(<IntentRoot onIntent={() => {}}><RetentionDialog {...base} lines={null} previewError="設定ファイルの書式を読み取れなかったので書き換えませんでした" /></IntentRoot>);
    expect(screen.getByRole('alert')).toHaveTextContent('設定ファイルの書式を読み取れなかったので書き換えませんでした');
    expect(screen.queryByText('差分を読み込んでいます')).toBeNull();
    expect(screen.getByRole('button', { name: '書き込む' })).toBeDisabled();
  });
  it('送信中と、差分がまだ無いときは書き込めない。読み直したことを出す', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><RetentionDialog {...base} writing /></IntentRoot>);
    expect(screen.getByRole('button', { name: '書き込む' })).toBeDisabled();
    rerender(<IntentRoot onIntent={() => {}}><RetentionDialog {...base} lines={null} reloaded showOther={false} otherPcs={false} /></IntentRoot>);
    expect(screen.getByRole('button', { name: '書き込む' })).toBeDisabled();
    expect(screen.getByText('設定ファイルがほかで変わったので、読み直しました。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ほかの期間…' })).toBeNull();
    expect(screen.queryByText('設定の同期で、次の取り込み時に届きます')).toBeNull();
  });
});
