import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { ConfigPreviewDialog } from './ConfigPreviewDialog.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';

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
