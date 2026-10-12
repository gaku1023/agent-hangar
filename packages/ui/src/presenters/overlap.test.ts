import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto, SessionOverlapDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { presentOverlap } from './overlap.ts';

const NOW = new Date(2026, 9, 12, 4, 20).getTime();
const at = (h: number, m: number) => new Date(2026, 9, 12, h, m).getTime();
const project: ProjectDto = { id: 'p1', name: 'alpha-web', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 };
const dto = (id: string, name: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'p1', name, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: NOW, lastActivityAt: NOW, hasTranscript: true, live: 'busy', summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, interrupted: null, overlap: null, ...over });
const overlap: SessionOverlapDto = {
  with: ['b'],
  files: [
    { path: '/w/alpha/src/search/rank.ts', with: 'b', mineAt: at(4, 10), theirsAt: at(4, 14), alternating: true },
    { path: '/w/alpha/package.json', with: 'b', mineAt: at(4, 5), theirsAt: at(4, 13), alternating: false },
  ],
};
const storeOf = (list: SessionDto[]): Store => ({ ...initialStore(), projects: { p1: project }, sessions: Object.fromEntries(list.map((s) => [s.id, s])) });

describe('presentOverlap', () => {
  it('相手、ファイル（作業ディレクトリからの相対）、時刻、交互の印、札の文を組む', () => {
    const p = presentOverlap(storeOf([dto('a', '検索の並び順を直す', { overlap }), dto('b', '依存の更新', { live: 'busy' })]), 'a', NOW)!;
    expect(p.chip).toBe('同じファイル 2');
    expect(p.title).toBe('同じファイルを編集中');
    expect(p.partners).toEqual([{ id: 'b', name: '依存の更新', context: 'alpha-web · 作業中', live: 'busy', aside: false, open: { type: 'session.open', id: 'b' } }]);
    expect(p.files).toEqual([
      { key: 'b:/w/alpha/src/search/rank.ts', path: 'src/search/rank.ts', mine: '04:10', theirs: '04:14', alternating: true },
      { key: 'b:/w/alpha/package.json', path: 'package.json', mine: '04:05', theirs: '04:13', alternating: false },
    ]);
    expect(p.summary).toBe('も rank.ts、package.json を編集しています（直近 10 分）');
    expect(p.sidebarTitle).toBe('依存の更新 と同じファイルを編集中');
    expect(p.dismiss).toEqual([{ type: 'overlap.dismiss', sessionId: 'a', with: 'b', paths: ['/w/alpha/src/search/rank.ts', '/w/alpha/package.json'] }]);
    expect(p.worktree).toEqual({ type: 'overlap.worktree', sessionId: 'a' });
  });

  it('重なりが無いか、実行中でなければ null', () => {
    expect(presentOverlap(storeOf([dto('a', 'x')]), 'a', NOW)).toBeNull();
    expect(presentOverlap(storeOf([dto('a', 'x', { overlap, live: null })]), 'a', NOW)).toBeNull();
    expect(presentOverlap(storeOf([]), 'a', NOW)).toBeNull();
  });

  it('相手が一覧に無くても、名前の無いセッションとして出す', () => {
    const p = presentOverlap(storeOf([dto('a', 'x', { overlap })]), 'a', NOW)!;
    expect(p.partners[0]).toMatchObject({ id: 'b', name: '（名前なし）', live: null });
  });
});

describe('ホームの帯の実行中の行', () => {
  it('重なっている行に札を足し、錠剤に琥珀の点を付ける。件数は変えない', async () => {
    const { presentHomeScreen } = await import('./home.ts');
    const { initialState } = await import('../mediator/transition.ts');
    const p = presentHomeScreen(initialState(), storeOf([dto('a', '検索の並び順を直す', { overlap }), dto('b', '依存の更新')]), NOW);
    const running = p.band.groups.find((g) => g.id === 'running')!;
    expect(running.count).toBe(2);
    expect(running.mark).toBe('同じファイルを編集中');
    expect(running.rows.find((r) => r.key === 'run:a')?.overlap?.chip).toBe('同じファイル 2');
    expect(running.rows.find((r) => r.key === 'run:b')?.overlap).toBeUndefined();
  });
});
