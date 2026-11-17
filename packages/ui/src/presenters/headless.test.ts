import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { applySearch, initialStore, type Store } from '../store/store.ts';
import { presentSessionList } from './sessions.ts';

// 非対話の会話（SessionDto.headless）。サーバは一覧に載せず、検索の結果に DTO を添えて返す。
// 画面は検索の結果からだけ行を組み、ふだんの一覧には出さない。

const NOW = new Date(2026, 10, 18, 9, 0).getTime();
const H = 3_600_000;
const project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, updatedAt: 1 });
const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 2 * H, lastActivityAt: NOW - H, lastTurnAt: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, pinnedAt: null, unread: null, spawnedBy: null, spawnPeer: null, ...over });
function storeOf(list: SessionDto[]): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha') };
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  return s;
}

describe('非対話の会話', () => {
  it('検索の結果に添えた DTO を Store に入れ、検索の行には出す', () => {
    const params = { q: '分類' };
    const store = applySearch(storeOf([dto('a')]), params, { hits: [{ sessionId: 'b', matchCount: 1, snippets: [] }], total: 1, sessions: [dto('b', { headless: true })] }, false);
    expect(store.sessions.b?.headless).toBe(true);
    const state = { ...initialState(), search: { ...initialState().search, text: '分類' } };
    expect(presentSessionList(state, store, NOW).rows.map((r) => r.id)).toEqual(['b']);
  });

  it('検索していない一覧と件数には、Store にあっても出さない', () => {
    const store = storeOf([dto('a'), dto('b', { headless: true })]);
    const list = presentSessionList(initialState(), store, NOW);
    expect(list.rows.map((r) => r.id)).toEqual(['a']);
    expect(list.allCount).toBe(1);
  });
});
