import { describe, expect, it } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { applyHeadlessPage, initialStore, type Store } from '../store/store.ts';
import { presentProject } from './project.ts';
import { sessionDto } from '../test/sessionDto.ts';

// 一覧の末尾に畳む非対話の会話（claude -p など）。件数は先に読み、行は読み込んだ頁の分だけ新しい順に持つ。

const NOW = new Date(2026, 10, 18, 9, 0).getTime();
const H = 3_600_000;
const dto = (id: string, at: number, over: Partial<SessionDto> = {}): SessionDto => (sessionDto({ id, providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', startedAt: at, lastActivityAt: at, hasTranscript: true, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, ...over }));
function storeOf(): Store {
  let s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: { id: 'alpha', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, updatedAt: 1 } };
  s.sessions = { n1: dto('n1', NOW - H) };
  s = applyHeadlessPage(s, 'alpha', 0, { total: 3, sessions: [dto('h1', NOW - 2 * H, { headless: true }), dto('h2', NOW - 3 * H, { headless: true })] });
  return s;
}

describe('presentProject の非対話のまとまり', () => {
  it('読んだ頁の分だけ行を持ち、残りの件数を言う。ふだんの一覧には混ぜない', () => {
    const p = presentProject(initialState(), storeOf(), NOW, 'alpha');
    expect(p.headless?.total).toBe(3);
    expect(p.headless?.rows.map((r) => r.id)).toEqual(['h1', 'h2']);
    expect(p.headless?.remaining).toBe(1);
    expect(p.list.rows.map((r) => r.id)).toEqual(['n1']);
  });
  it('1 件も無ければ出さず、語で検索しているときも出さない', () => {
    expect(presentProject(initialState(), initialStore(), NOW, 'alpha').headless ?? null).toBeNull();
    const none = applyHeadlessPage(storeOf(), 'alpha', undefined, { total: 0, sessions: [] });
    expect(presentProject(initialState(), none, NOW, 'alpha').headless ?? null).toBeNull();
    const searching = { ...initialState(), search: { ...initialState().search, text: 'x' } };
    expect(presentProject(searching, storeOf(), NOW, 'alpha').headless ?? null).toBeNull();
  });
});
