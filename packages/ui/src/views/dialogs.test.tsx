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
    expect(screen.getByText('他の端末の本文 4.0 KB')).toBeInTheDocument();
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

describe('ConfirmDialog（引き取り）', () => {
  it('外のターミナルの claude が終わることと、問いが閉じることを書き、承諾で引き取る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ConfirmDialog confirm={{ kind: 'adoptSession', sessionId: 's1' }} /></IntentRoot>);
    expect(screen.getByRole('dialog', { name: '引き取りの確認' })).toBeInTheDocument();
    expect(screen.getByText(/claude attach/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '引き取る' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.adopt', id: 's1', confirmed: true });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
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
    backupDir: '/Users/me/.agent-hangar/backups/claude-config/', otherPcs: true, shrinkNote: null, reloaded: false, showOther: true, writing: false,
  };
  it('差分を印付きで描き、見込みと控えとほかの PC を並べる', () => {
    render(<IntentRoot onIntent={() => {}}><RetentionDialog {...base} /></IntentRoot>);
    expect(screen.getByText(/^\+\s+"cleanupPeriodDays": 365,$/)).toBeInTheDocument();
    expect(screen.getByText(/^-\s+"cleanupPeriodDays": 30,$/)).toBeInTheDocument();
    expect(screen.getByText('1 年たつと約 18 GB')).toBeInTheDocument();
    expect(screen.getByText('/Users/me/.agent-hangar/backups/claude-config/')).toBeInTheDocument();
    expect(screen.getByText('設定の同期で、次の取り込み時に届きます')).toBeInTheDocument();
    expect(screen.getByText('取り戻せません。これから先の会話が残ります')).toBeInTheDocument();
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
