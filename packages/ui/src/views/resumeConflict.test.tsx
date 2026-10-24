import { fireEvent, render, screen, within } from '@testing-library/react';
import type { InterruptedDto, ProjectDto, SessionDto, SessionOverlapDto, UiAction } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { presentHomeScreen } from '../presenters/home.ts';
import { presentOverlap } from '../presenters/overlap.ts';
import { presentShell } from '../presenters/shell.ts';
import { initialStore, type Store } from '../store/store.ts';
import { HomeBand } from './HomeBand.tsx';
import { OverlapBlock } from './OverlapPopover.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import { ToastStack } from './ToastStack.tsx';

// 中断の群の引き出しと、同じファイルの編集の札（2026-10-12 の試作の推す組み合わせ）。

const NOW = new Date(2026, 9, 12, 9, 0).getTime();
const at = (h: number, m: number) => new Date(2026, 9, 12, h, m).getTime();
const project: ProjectDto = { id: 'p1', name: 'alpha-web', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 };
const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'p1', name: `n-${id}`, cwd: '/w/alpha', firstPrompt: `first ${id}`, aiTitle: null, startedAt: at(1, 0), lastActivityAt: at(3, 0), hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, ...over });
const group: InterruptedDto = { at: at(3, 12), cause: 'restart', items: [{ sessionId: 'a', runId: 'ra', lastLive: 'busy', endedAt: at(3, 12), account: null }, { sessionId: 'b', runId: 'rb', lastLive: 'idle', endedAt: at(3, 12), account: null }] };
const storeOf = (list: SessionDto[], over: Partial<Store> = {}): Store => ({ ...initialStore(), projects: { p1: project }, sessions: Object.fromEntries(list.map((s) => [s.id, s])), ...over });
const interruptedStore = () => storeOf([dto('a', { interrupted: { at: at(3, 12), cause: 'restart' } }), dto('b', { interrupted: { at: at(3, 12), cause: 'restart' } })], { interrupted: group });

function mountHome(store: Store, state: State = initialState()) {
  const onAction = vi.fn<(i: UiAction) => void>();
  const p = presentHomeScreen(state, store, NOW);
  render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><HomeBand {...p.band} /></ActionRoot></LanguageRoot>);
  return onAction;
}

describe('前回実行中の引き出し', () => {
  it('静かな朝は開いていて、見出しに原因と時刻、すべて再開と閉じるを置く', () => {
    const onAction = mountHome(interruptedStore());
    const drawer = screen.getByRole('region', { name: '前回実行中' });
    expect(drawer.textContent).toContain('PC の再起動で中断（03:12）');
    fireEvent.click(within(drawer).getByRole('button', { name: 'すべて再開、前回実行中' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'interrupted.resume', ids: ['a', 'b'] });
    fireEvent.click(within(drawer).getByRole('button', { name: '閉じる、前回実行中' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'interrupted.dismiss', runIds: ['ra', 'rb'], dismissed: true });
  });

  it('行は中断の輪、止まる前の状態の語、再開と再開しない（× の絵）を持つ', () => {
    const onAction = mountHome(interruptedStore());
    const drawer = screen.getByRole('region', { name: '前回実行中' });
    expect(within(drawer).getAllByRole('img', { name: '中断' })).toHaveLength(2);
    expect(drawer.textContent).toContain('作業中だった');
    fireEvent.click(within(drawer).getByRole('button', { name: '再開しない、n-a' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'interrupted.dismiss', runIds: ['ra'], dismissed: true, name: 'n-a' });
  });

  it('再開中の行は押せず、順番待ちが残っていれば残りをキャンセルを出す', () => {
    const state: State = { ...initialState(), resumeQueue: { queued: ['b'], active: ['a'], failed: {} } };
    mountHome(interruptedStore(), state);
    const drawer = screen.getByRole('region', { name: '前回実行中' });
    expect(within(drawer).getByRole('button', { name: '再開、n-a' })).toBeDisabled();
    expect(drawer.textContent).toContain('再開中');
    expect(drawer.textContent).toContain('順番待ち');
    expect(within(drawer).getByRole('button', { name: '残りをキャンセル、前回実行中' })).toBeEnabled();
  });
});

const overlap: SessionOverlapDto = { with: ['y'], files: [{ path: '/w/alpha/src/rank.ts', with: 'y', mineAt: at(8, 50), theirsAt: at(8, 55), alternating: true }] };
const overlapStore = () => storeOf([dto('x', { live: 'busy', overlap }), dto('y', { live: 'busy' })]);

describe('同じファイルの編集', () => {
  it('実行中の行に琥珀の札、錠剤に点。札を押すと中身が開き、worktree と表示しないを押せる', () => {
    const state: State = { ...initialState() };
    const onAction = vi.fn<(i: UiAction) => void>();
    const p = presentHomeScreen(state, overlapStore(), NOW);
    render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><HomeBand {...p.band} morning="running" /></ActionRoot></LanguageRoot>);
    expect(screen.getByRole('img', { name: '同じファイルを編集中' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '同じファイル 1、n-x' }));
    const pop = screen.getByRole('dialog', { name: '同じファイルを編集中' });
    expect(pop.textContent).toContain('src/rank.ts');
    expect(pop.textContent).toContain('交互');
    expect(pop.textContent).toContain('Bash での変更は含みません');
    // 相手は名前の押下で開く。行ごとの「開く」と worktree の言い直しは置かない。
    expect(within(pop).queryByRole('button', { name: /^開く/ })).toBeNull();
    expect(pop.textContent).not.toContain('互いの変更を上書きしません');
    fireEvent.click(within(pop).getByRole('button', { name: 'worktree で新しいセッション' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'overlap.worktree', sessionId: 'x' });
    fireEvent.click(screen.getByRole('button', { name: '同じファイル 1、n-x' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '同じファイルを編集中' })).getByRole('button', { name: 'このファイルでは表示しない' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'overlap.dismiss', sessionId: 'x', with: 'y', paths: ['/w/alpha/src/rank.ts'] });
  });

  it('現在の札の 1 節は、相手の名前を押すとそのセッションを開く', () => {
    const onAction = vi.fn<(i: UiAction) => void>();
    render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><OverlapBlock overlap={presentOverlap(overlapStore(), 'x', NOW)!} /></ActionRoot></LanguageRoot>);
    expect(screen.getByRole('note').textContent).toContain('も rank.ts を編集しています（直近 10 分）');
    fireEvent.click(screen.getByRole('button', { name: 'n-y' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 'y' });
  });

  it('サイドバーの行は、語を出さずに印と相手の名前だけを持つ', () => {
    const rows = presentShell(initialState(), overlapStore(), NOW).live.rows;
    expect(rows.find((r) => r.id === 'x')?.overlap).toBe('n-y と同じファイルを編集中');
    expect(rows.find((r) => r.id === 'y')?.overlap).toBeNull();
  });
});

describe('トーストの元に戻す', () => {
  it('押すとその操作を出してトーストを閉じる', () => {
    const onAction = vi.fn<(i: UiAction) => void>();
    const undo: UiAction = { type: 'interrupted.dismiss', runIds: ['ra'], dismissed: false };
    render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><ToastStack toasts={[{ id: '1', level: 'info', message: '「n-a」は再開しません', action: { label: '元に戻す', send: undo } }]} waiting={[]} more={0} blocked={false} arrived={null} update={null} whatsNew={null} join={null} /></ActionRoot></LanguageRoot>);
    fireEvent.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(onAction).toHaveBeenCalledWith(undo);
    expect(onAction).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
});
