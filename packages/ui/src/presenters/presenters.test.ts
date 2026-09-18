import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { applyEventsPage, applySubagents, eventsKey, initialStore, type Store } from '../store/store.ts';
import { absoluteTime, relativeTime, shortModel, tokensLabel } from './format.ts';
import { presentHome } from './home.ts';
import { presentProject } from './project.ts';
import { presentProjects } from './projects.ts';
import { presentSession } from './session.ts';
import { presentSessions } from './sessions.ts';
import { presentShell } from './shell.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const project = (id: string, status: ProjectDto['status'] = 'active'): ProjectDto => ({ id, name: id, status, isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW - 3_600_000, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: 'name-' + id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, memo: null, hasTranscript: true, live: null, summary: { title: 't', oneLiner: 'one', body: 'b', state: 'done', nextSteps: [], source: 'baseline', sourceModel: null, basedOnTurns: 2, updatedAt: 1 }, stats: { turns: 2, model: 'claude-fable-5-1', effort: 'high', filesChanged: 1, prUrl: null, inputTokens: 1234567, outputTokens: 10 }, ...over });
function storeWith(): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha'), beta: project('beta', 'paused'), old: project('old', 'archived') };
  s.sessions = { s1: session('s1', { live: 'busy' }), s2: session('s2', { lastActivityAt: NOW - 86_400_000 * 3 }), s3: session('s3', { projectId: null }) };
  return s;
}

describe('format', () => {
  it('相対時刻', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('1 分未満前');
    expect(relativeTime(NOW - 3 * 60_000, NOW)).toBe('3 分前');
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 時間前');
    expect(relativeTime(NOW - 30 * 3_600_000, NOW)).toBe('昨日');
    expect(relativeTime(NOW - 5 * 86_400_000, NOW)).toBe('5 日前');
    const old = relativeTime(NOW - 40 * 86_400_000, NOW);
    expect(old).toBe(absoluteTime(NOW - 40 * 86_400_000).slice(0, 10));
    expect(old).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(relativeTime(null, NOW)).toBe('不明');
  });
  it('モデル名とトークン', () => {
    expect(shortModel('claude-fable-5-1')).toBe('fable 5.1');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
    expect(shortModel(null)).toBe('');
    expect(tokensLabel(1234567)).toBe('1.2M');
    expect(tokensLabel(12345)).toBe('12k');
    expect(tokensLabel(999)).toBe('999');
  });
});

describe('presentShell', () => {
  it('現在のナビ項目とパンくずと索引の進行', () => {
    const state = { ...initialState(), screen: { name: 'project' as const, id: 'alpha' } };
    const store = storeWith();
    store.index = { phase: 'indexing', done: 10, total: 40 };
    const p = presentShell(state, store);
    expect(p.nav.find((n) => n.current)?.label).toBe('Projects');
    expect(p.crumbs.map((c) => c.label)).toEqual(['Projects', 'alpha']);
    expect(p.indexLabel).toBe('索引 10 / 40 件');
  });
});

describe('presentHome', () => {
  it('実行中の帯、active のカード、最近のセッション', () => {
    const p = presentHome(initialState(), storeWith(), NOW);
    expect(p.running.map((r) => r.id)).toEqual(['s1']);
    expect(p.running[0]!.elapsed).toBe('2 時間');
    expect(p.activeProjects.map((c) => c.id)).toEqual(['alpha']);
    expect(p.activeProjects[0]!.lastOneLiner).toBe('one');
    expect(p.recent.map((r) => r.id)).toEqual(['s1', 's3', 's2']);
    expect(p.recent[0]).toMatchObject({ name: 'name-s1', projectName: 'alpha', live: 'busy', model: 'fable 5.1', effort: 'high', stateLabel: '完了', when: '1 分前' });
  });
});

describe('presentProjects', () => {
  it('セクション分けと絞り込みとアーカイブ', () => {
    const p = presentProjects(initialState(), storeWith(), NOW, '', false);
    expect(p.sections.map((s) => [s.status, s.cards.length])).toEqual([['active', 1], ['paused', 1], ['done', 0]]);
    expect(p.archivedCount).toBe(1);
    expect(presentProjects(initialState(), storeWith(), NOW, 'bet', false).sections[1]!.cards).toHaveLength(1);
    expect(presentProjects(initialState(), storeWith(), NOW, 'bet', false).sections[0]!.cards).toHaveLength(0);
    expect(presentProjects(initialState(), storeWith(), NOW, '', true).sections.map((s) => s.status)).toEqual(['active', 'paused', 'done', 'archived']);
  });
});

describe('presentProject', () => {
  it('実行中を先頭に、その後を新しい順に', () => {
    const store = storeWith();
    store.sessions.s4 = session('s4', { live: 'idle', lastActivityAt: NOW - 86_400_000 * 9 });
    const p = presentProject(initialState(), store, NOW, 'alpha');
    expect(p.sessions.map((s) => s.id)).toEqual(['s1', 's4', 's2']);
    expect(presentProject(initialState(), store, NOW, 'nope').notFound).toBe(true);
  });
});

describe('presentSession', () => {
  it('ツール結果を呼び出しに畳み込み、思考は既定で隠し、サブエージェントを対応づける', () => {
    let store = storeWith();
    store = applyEventsPage(store, eventsKey('s1', null), { sessionId: 's1', total: 6, nextSeq: null, events: [
      { kind: 'user', seq: 0, ts: NOW, text: 'hi' },
      { kind: 'thinking', seq: 1, text: 'think' },
      { kind: 'tool_call', seq: 2, toolId: 't1', name: 'Agent', input: { description: 'x' }, summary: 'Agent x' },
      { kind: 'tool_result', seq: 3, toolId: 't1', text: 'done', isError: false },
      { kind: 'meta', seq: 4, name: 'ai-title', value: {} },
      { kind: 'assistant', seq: 5, text: 'bye' },
    ] }, false);
    store = applySubagents(store, 's1', ['abc']);
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(p.items[1]).toMatchObject({ kind: 'tool', summary: 'Agent x', result: { text: 'done', isError: false }, subagent: { agentId: 'abc', label: 'Agent x' } });
    expect(p).toMatchObject({ name: 'name-s1', live: 'busy', tokens: '1.2M', turns: 2, loaded: 6, total: 6, hasMore: false, projectName: 'alpha' });
    expect(p.summary).toMatchObject({ title: 't', sourceLabel: '自動', stateLabel: '完了' });
    const state = { ...initialState(), sessionView: { s1: { agentId: null, showThinking: true, showRaw: true, follow: true, summaryOpen: true, selectedTab: null, transcriptOpen: true } } };
    const q = presentSession(state, store, NOW, 's1');
    expect(q.items.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool', 'meta', 'assistant']);
    expect(q.summaryOpen).toBe(true);
  });
  it('無いセッションは notFound', () => {
    expect(presentSession(initialState(), storeWith(), NOW, 'zz').notFound).toBe(true);
  });
});

describe('presentSessions', () => {
  it('検索語が無ければ全件、あれば結果だけを抜粋付きで', () => {
    let store = storeWith();
    const all = presentSessions(initialState(), store, NOW);
    expect(all.mode).toBe('all');
    expect(all.rows).toHaveLength(3);
    expect(all.projects.map((p) => p.name)).toEqual(['alpha', 'beta', 'old']);
    store = { ...store, search: { params: { q: 'hi' }, result: { hits: [{ sessionId: 's2', matchCount: 2, snippets: [{ seq: 1, role: 'user', text: '…hi…' }] }], total: 1 }, loading: false } };
    const state = { ...initialState(), screen: { name: 'sessions' as const, q: 'hi' }, search: { text: 'hi', filter: {} } };
    const r = presentSessions(state, store, NOW);
    expect(r.mode).toBe('search');
    expect(r.rows.map((x) => x.id)).toEqual(['s2']);
    expect(r.rows[0]!.snippets).toEqual([{ seq: 1, text: '…hi…' }]);
  });
});
