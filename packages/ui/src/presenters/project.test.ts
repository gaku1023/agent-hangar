import type { ProjectDto, SearchHitDto, SessionDto, SessionStateDto, TodoDto } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentProject, presentTodoCandidate } from './project.ts';

// 1 つのプロジェクトの画面（Q3）の Presenter。左の一覧はホームと同じ部品に渡すもので、このプロジェクトのセッションだけを出す。

const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const DAY = 24 * H;

const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null, ...o });
const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: NOW - H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
const project = (id: string, over: Partial<ProjectDto> = {}): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW - 3 * H, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, ...over });
const doneSt = st({ status: 'done', setBy: 'user', setAt: NOW - 10 * DAY });
const todo = (id: string, over: Partial<TodoDto> = {}): TodoDto => ({ id, projectId: 'alpha', text: `やる ${id}`, done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null, ...over });

function storeOf(sessions: SessionDto[], extra: Partial<Store> = {}): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha'), beta: project('beta') };
  s.sessions = Object.fromEntries(sessions.map((x) => [x.id, x]));
  return { ...s, ...extra };
}
const withLanguage = (store: Store, language: 'ja' | 'en'): Store => ({ ...store, settings: { language } as unknown as Store['settings'] });

describe('presentProject の一覧（ホームと同じ部品に渡す）', () => {
  const sessions = [
    dto('a1', { live: 'busy' }),
    dto('a2', { lastActivityAt: NOW - 2 * DAY }),
    dto('a3', { lastActivityAt: NOW - 3 * DAY, state: doneSt }),
    dto('a4', { lastActivityAt: NOW - 4 * DAY, state: st({ status: 'archived', setBy: 'user', setAt: NOW - DAY }) }),
    dto('b1', { projectId: 'beta' }),
    dto('x1', { projectId: null }),
  ];

  it('このプロジェクトのセッションだけを、ホームと同じ並び（動いているものを先に、残りは新しい順）で出す。Archived は「すべて」に入れない', () => {
    const p = presentProject(initialState(), storeOf(sessions), NOW, 'alpha');
    expect(p.list.rows.map((r) => r.id)).toEqual(['a1', 'a2', 'a3']);
    expect(p.list.total).toBe(3);
    expect(p.list.allCount).toBe(3);
  });
  it('タブの件数は、このプロジェクトの分だけを数える', () => {
    const p = presentProject(initialState(), storeOf(sessions), NOW, 'alpha');
    expect(p.list.tabs.map((t) => [t.tab, t.count])).toEqual([['all', '3'], ['proposed', '0'], ['active', '2'], ['paused', '0'], ['done', '1'], ['archived', '1']]);
  });
  it('状態のタブで絞ると、このプロジェクトの中だけで絞る', () => {
    const state = { ...initialState(), search: { text: '', filter: { status: 'archived' as const }, page: 1 } };
    const p = presentProject(state, storeOf(sessions), NOW, 'alpha');
    expect(p.list.rows.map((r) => r.id)).toEqual(['a4']);
    expect(p.list.tab).toBe('archived');
  });
  it('条件の行と欄のチップにプロジェクトは入らない（プロジェクトは画面が決めている）', () => {
    const state = { ...initialState(), search: { text: '', filter: { status: 'done' as const, days: 7 }, page: 1 } };
    const p = presentProject(state, storeOf(sessions), NOW, 'alpha');
    expect(p.list.conditions).toEqual(['Done', '7 日']);
    expect(p.list.tokens.map((t) => t.key)).toEqual(['status', 'days']);
  });
  it('ページ送りはホームと同じ State.search.page と pageSize で切る', () => {
    const many = Array.from({ length: 30 }, (_, i) => dto(`m${i}`, { lastActivityAt: NOW - i * H }));
    const at = (page: number) => presentProject({ ...initialState(), pageSize: 25, search: { text: '', filter: {}, page } }, storeOf(many), NOW, 'alpha');
    expect(at(1).list.pager).toMatchObject({ page: 1, pageCount: 2, from: 1, to: 25, total: 30 });
    expect(at(2).list.rows.map((r) => r.id)).toEqual(['m25', 'm26', 'm27', 'm28', 'm29']);
    expect(presentProject({ ...initialState(), pageSize: 25 }, storeOf(sessions), NOW, 'alpha').list.pager).toBeNull();
  });
  it('語で検索しているときは、サーバの結果のうちこのプロジェクトの行を出し、続きがあれば「さらに読み込む」の残りを持つ', () => {
    const hit = (id: string): SearchHitDto => ({ sessionId: id, matchCount: 1, snippets: [{ seq: 1, role: 'user', text: '動画を作る', agentId: null }] });
    const store = storeOf(sessions, { search: { params: null, result: { hits: [hit('a2'), hit('a1')], total: 120 }, loading: false } });
    const p = presentProject({ ...initialState(), search: { text: '動画', filter: {}, page: 1 } }, store, NOW, 'alpha');
    expect(p.list.mode).toBe('search');
    expect(p.list.rows.map((r) => r.id)).toEqual(['a2', 'a1']);
    expect(p.loadMore).toEqual({ remaining: 118, step: 50, loading: false });
    // 検索していないときは持たない。
    expect(presentProject(initialState(), storeOf(sessions), NOW, 'alpha').loadMore).toBeNull();
  });
  it('見つからないプロジェクトは notFound で、空の一覧と、一覧へ戻るリンクを持つ', () => {
    const p = presentProject(initialState(), storeOf(sessions), NOW, 'nope');
    expect(p).toMatchObject({ notFound: true, parent: { label: 'プロジェクト', route: { name: 'projects' } } });
    expect(p.list.rows).toEqual([]);
  });
});

describe('presentProject の見出しと (i) の詳細', () => {
  it('場所、セッションの数（Archived も数える）、最後の活動を持つ。作成日は持たない', () => {
    const sessions = [dto('a1'), dto('a2', { state: st({ status: 'archived', setBy: 'user', setAt: NOW }) }), dto('b1', { projectId: 'beta' })];
    const p = presentProject(initialState(), storeOf(sessions), NOW, 'alpha');
    expect(p.info).toEqual({ sessionsText: '2 本', lastActivity: '3 時間前' });
    expect(p).toMatchObject({ path: '/w/alpha', resolved: true, status: 'active', isScratch: false });
    expect(Object.keys(p.info)).not.toContain('createdAt');
  });
  it('この PC にパスが無いプロジェクトは path が null で、見つからないものは resolved が false', () => {
    const store = storeOf([]);
    store.projects = { alpha: project('alpha', { path: null, resolved: false }), beta: project('beta', { resolved: false }) };
    expect(presentProject(initialState(), store, NOW, 'alpha')).toMatchObject({ path: null, resolved: false });
    expect(presentProject(initialState(), store, NOW, 'beta')).toMatchObject({ path: '/w/beta', resolved: false });
  });
  it('クイックセッションの置き場（スクラッチ）は isScratch を立てる', () => {
    const store = storeOf([]);
    store.projects = { sc: project('sc', { isScratch: true }) };
    expect(presentProject(initialState(), store, NOW, 'sc').isScratch).toBe(true);
  });
});

describe('presentProject の右パネル', () => {
  const cand = { sessionId: null, note: '直した', at: NOW - H };
  it('TODO の見出しの確認待ちは、完了の候補が付いた未完の TODO の数。完了済みの候補は数えない', () => {
    const store = storeOf([], { todos: { t1: todo('t1', { candidate: cand }), t2: todo('t2', { candidate: cand, position: 2 }), t3: todo('t3', { position: 3 }), t4: todo('t4', { done: true, position: 4, candidate: cand }) } });
    const p = presentProject(initialState(), store, NOW, 'alpha');
    expect(p.pendingTodos).toBe(2);
    expect(p.todos.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    // セッションの状態の提案は TODO の数に入れない（そちらは一覧のタブの「確認待ち」が言う）。
    const proposed = dto('a1', { state: st({ candidate: { status: 'done', note: 'n', returnOn: null, returnTime: null, source: 'post_hoc', at: NOW - H } }) });
    expect(presentProject(initialState(), storeOf([proposed]), NOW, 'alpha').pendingTodos).toBe(0);
  });
  it('ノートは本文と、中身があるかを返す。メモが無いプロジェクトも空のノートとして返す（読む表示の出し分けは中身で決める）', () => {
    expect(presentProject(initialState(), storeOf([]), NOW, 'alpha').note).toEqual({ text: '', filled: false });
    const memo = (markdown: string) => ({ memos: { alpha: { projectId: 'alpha', markdown, updatedAt: 5 } } });
    expect(presentProject(initialState(), storeOf([], memo('決済は v3')), NOW, 'alpha').note).toEqual({ text: '決済は v3', filled: true });
    expect(presentProject(initialState(), storeOf([], memo('  \n')), NOW, 'alpha').note.filled).toBe(false);
  });
  it('候補の TODO の、根拠が無いとき、出したセッションが手元に無いときの文は、言語に従う', () => {
    const t = todo('t1', { candidate: { sessionId: 'gone', note: null, at: NOW - 60_000 } });
    const ja = storeOf([]);
    expect(presentTodoCandidate(t, ja, NOW)).toEqual({ note: '根拠は書かれていません', sessionId: null, sessionName: '不明なセッション', ago: '1 分前' });
    const en = withLanguage(ja, 'en');
    expect(presentTodoCandidate(t, en, NOW)).toMatchObject({ note: 'No reason was written', sessionName: 'Unknown session' });
    const named = storeOf([dto('s1', { name: null })]);
    expect(presentTodoCandidate(todo('t2', { candidate: { sessionId: 's1', note: 'n', at: NOW } }), named, NOW)?.sessionName).toBe('（名前なし）');
    expect(presentTodoCandidate(todo('t2', { candidate: { sessionId: 's1', note: 'n', at: NOW } }), withLanguage(named, 'en'), NOW)?.sessionName).toBe('(no name)');
  });
});
