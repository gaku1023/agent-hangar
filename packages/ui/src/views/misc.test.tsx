import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { ResolveProjectDialog } from './ResolveProjectDialog.tsx';
import { SessionRows } from './SessionRows.tsx';
import { SessionsScreen } from './SessionsScreen.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { ToastStack } from './ToastStack.tsx';

describe('SessionsScreen', () => {
  it('絞り込みは search.filter、キーワードは search.query', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('プロジェクト'), { target: { value: 'p1' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: 'p1' } });
    fireEvent.change(screen.getByLabelText('実行中'), { target: { value: 'running' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { running: true } });
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: 'x y' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: 'x y' });
  });
  it('期間は since を now から N 日前にする', () => {
    const onIntent = vi.fn();
    const before = Date.now();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('期間'), { target: { value: '7' } });
    const call = onIntent.mock.calls.find((c) => c[0].type === 'search.filter')?.[0];
    expect(call).toBeDefined();
    const since = call.patch.since as number;
    expect(since).toBeGreaterThanOrEqual(before - 7 * 86_400_000);
    expect(since).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    expect(call.patch.until).toBeUndefined();
  });
  it('検索中と件数の表示', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} total={0} loading mode="search" /></IntentRoot>);
    expect(screen.getByText('検索しています')).toBeInTheDocument();
  });
});

describe('SettingsScreen', () => {
  it('保存と作り直し', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen workspaceRoot="/w" claudeDir="/c" device={{ id: 'd', name: 'mac' }} version="0.1.0" index={{ phase: 'idle', done: 3, total: 3 }} sessionCount={3} projectCount={1} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('ワークスペースのルート'), { target: { value: '/w2' } });
    fireEvent.click(screen.getByText('保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { workspaceRoot: '/w2' } });
    fireEvent.click(screen.getByText('索引を作り直す'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'index.rebuild' });
    expect(screen.getByText('mac')).toBeInTheDocument();
  });
});

describe('ResolveProjectDialog', () => {
  it('三つの解決と閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ResolveProjectDialog projectId="p1" name="alpha" path="/w/alpha" candidates={['/w/alpha-moved']} onQueryCandidates={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByText('/w/alpha-moved'));
    fireEvent.click(screen.getByText('この場所にする'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'repoint', path: '/w/alpha-moved' } });
    fireEvent.click(screen.getByText('アーカイブにする'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'archive' } });
    fireEvent.click(screen.getByText('紐づけを削除'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' } });
    fireEvent.click(screen.getByText('あとで'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ToastStack', () => {
  it('クリックで消す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ToastStack toasts={[{ id: '1', level: 'error', message: 'oops' }]} /></IntentRoot>);
    fireEvent.click(screen.getByText('oops'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
});

describe('SessionRows（抜粋つき）', () => {
  const row = (id: string, snippets: { seq: number; text: string }[]): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, stateLabel: '完了', model: 'fable 5.1', effort: '', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, snippets });
  it('抜粋の数が違う行も全部描き、高さは行ごとに決める', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[row('a', [{ seq: 1, text: 'snip a1' }]), row('b', [{ seq: 1, text: 'snip b1' }, { seq: 2, text: 'snip b2' }, { seq: 3, text: 'snip b3' }])]} height={400} showProject showSnippets /></IntentRoot>);
    expect(screen.getByText('na')).toBeInTheDocument();
    expect(screen.getByText('nb')).toBeInTheDocument();
    for (const t of ['snip a1', 'snip b1', 'snip b2', 'snip b3']) expect(screen.getByText(t)).toBeInTheDocument();
    const wrapOf = (name: string) => screen.getByText(name).closest('[role="row"]')!.parentElement as HTMLElement;
    expect(wrapOf('na').style.height).toBe('48px');
    expect(wrapOf('nb').style.height).toBe('88px');
  });
});
