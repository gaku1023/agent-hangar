import { describe, expect, it } from 'vitest';
import type { ProjectDto, RunDto, SessionDto, SessionStateDto, TodoDto } from '@agent-hangar/shared';
import { periodStart } from '../mediator/screen.ts';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentHome, presentHomeScreen } from './home.ts';

/** 2026-10-02（金）の朝 9 時。 */
const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null, ...o });
const dto = (id: string, hoursAgo: number, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - (hoursAgo + 1) * H, lastActivityAt: NOW - hoursAgo * H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
const paused = (id: string, hoursAgo: number, returnOn: string | null, over: Partial<SessionDto> = {}) => dto(id, hoursAgo, { state: st({ status: 'paused', note: `${id} を確かめる`, returnOn, setBy: 'user', setAt: NOW - hoursAgo * H }), ...over });
const proposed = (id: string, status: 'paused' | 'done', at: number, returnOn: string | null = null, over: Partial<SessionDto> = {}) => dto(id, 3, { state: st({ candidate: { status, note: '直した', returnOn, returnTime: null, source: 'in_session', at } }), ...over });
const todo = (id: string, at: number, projectId = 'alpha'): TodoDto => ({ id, projectId, text: `やる ${id}`, done: false, position: 1, sessionId: null, updatedAt: 1, candidate: { sessionId: null, note: '片付いた', at } });
function storeOf(list: SessionDto[], todos: TodoDto[] = []): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha') };
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  s.todos = Object.fromEntries(todos.map((t) => [t.id, t]));
  return s;
}

describe('presentHome の今日戻る（C1）', () => {
  it('戻る日が今日か過ぎた Paused を、入力待ちの札とは別に戻る日の古い順で出し、先のものと動いているものは出さない', () => {
    const store = storeOf([dto('w', 0.2, { live: 'waiting' }), paused('sync', 24, '2026-10-02'), paused('e2e', 72, '2026-09-29'), paused('later', 30, '2026-10-05'), paused('busy', 1, '2026-10-01', { live: 'busy' })]);
    const h = presentHome(initialState(), store, NOW);
    expect(h.attention.map((a) => a.id)).toEqual(['w']);
    expect(h.returning).toEqual([
      { id: 'e2e', name: 'e2e', projectName: 'alpha', reason: 'e2e を確かめる', returnOn: '2026-09-29', returnTime: null, overdueDays: 3, due: true, pastMin: null },
      { id: 'sync', name: 'sync', projectName: 'alpha', reason: 'sync を確かめる', returnOn: '2026-10-02', returnTime: null, overdueDays: 0, due: true, pastMin: null },
    ]);
  });
  it('今日戻るは要対応の群に数える。生きたセッションではないが、決めるまで毎朝そこに残る', () => {
    const h = presentHome(initialState(), storeOf([paused('sync', 24, '2026-10-02'), paused('later', 30, '2026-10-05'), dto('x', 2)]), NOW);
    expect(h.returning.map((r) => r.id)).toEqual(['sync']);
    const screen = presentHomeScreen(initialState(), storeOf([paused('sync', 24, '2026-10-02'), paused('later', 30, '2026-10-05'), dto('x', 2)]), NOW);
    expect(screen.band.groups[0]).toMatchObject({ id: 'attention', count: 1 });
    expect(screen.idle).toBe(false);
    // 戻る日が先のものだけなら、帯は空で idle になる。
    expect(presentHomeScreen(initialState(), storeOf([paused('later', 30, '2026-10-05')]), NOW).idle).toBe(true);
  });
  it('「今日」の境は手元の暦の 0 時で、期間の「今日」（periodStart(1, now)）と同じ', () => {
    const midnight = periodStart(1, NOW);
    const store = storeOf([paused('p', 24, '2026-10-02')]);
    expect(presentHome(initialState(), store, midnight).returning.map((r) => r.id)).toEqual(['p']);
    expect(presentHome(initialState(), store, midnight - 1).returning).toEqual([]);
  });
  it('戻る日が欠けた Paused と暦に無い日の Paused は、日付なし（null）として先頭に出す', () => {
    const h = presentHome(initialState(), storeOf([paused('ok', 30, '2026-10-01'), paused('none', 40, null), paused('broken', 50, '2026-02-30')]), NOW);
    expect(h.returning.map((r) => [r.id, r.returnOn, r.overdueDays])).toEqual([['none', null, null], ['broken', null, null], ['ok', '2026-10-01', 1]]);
  });
  it('プロジェクトの無いセッションと消えたプロジェクトを指すセッションは、プロジェクト名を null にし、理由が無ければ決まりの文を出す', () => {
    const noNote = dto('n', 7, { projectId: null, state: st({ status: 'paused', returnOn: '2026-10-02', returnTime: null, setBy: 'user', setAt: NOW }) });
    const h = presentHome(initialState(), storeOf([noNote, paused('g', 6, '2026-10-02', { projectId: 'gone' })]), NOW);
    expect(h.returning.map((r) => [r.id, r.projectName, r.reason])).toEqual([['g', null, 'g を確かめる'], ['n', null, '理由は書かれていません']]);
  });
});

describe('presentHome の、区切りを付けて休みのまま残っているもの（parked）', () => {
  const runOf = (sessionId: string): RunDto => ({ id: `r-${sessionId}`, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-r-${sessionId}`, pid: null, startedAt: NOW - 2 * H, endedAt: null, endReason: null, heartbeatAt: NOW });
  const withRuns = (store: Store, ids: string[]): Store => ({ ...store, runs: Object.fromEntries(ids.map((id) => [`r-${id}`, runOf(id)])) });

  it('帯の実行中には出さず、一覧に印付きの行として出す。hangar の run が生きていても同じ', () => {
    const store = withRuns(storeOf([paused('later', 1, '2026-10-05', { live: 'idle', parked: true }), dto('d', 2, { live: 'idle', parked: true, state: st({ status: 'done', setBy: 'conversation', setAt: NOW - H }) }), dto('i', 3, { live: 'idle' })]), ['later']);
    const h = presentHome(initialState(), store, NOW);
    expect(h.running.map((r) => r.id)).toEqual(['i']);
    const rows = presentHomeScreen(initialState(), store, NOW).list.rows;
    expect(rows.filter((r) => r.id === 'later' || r.id === 'd').map((r) => [r.id, r.state, r.live, r.runId])).toEqual([['later', 'paused', null, null], ['d', 'done', null, null]]);
  });
  it('戻る日が来ている Paused は、プロセスが残っていても今日戻るの札に出す', () => {
    const h = presentHome(initialState(), storeOf([paused('sync', 24, '2026-10-02', { live: 'idle', parked: true })]), NOW);
    expect(h.returning.map((r) => r.id)).toEqual(['sync']);
    expect(h.running).toEqual([]);
  });
  it('ほかに動いているものが無ければ idle にする', () => {
    const screen = presentHomeScreen(initialState(), withRuns(storeOf([paused('later', 1, '2026-10-05', { live: 'idle', parked: true })]), ['later']), NOW);
    expect(screen.idle).toBe(true);
    expect(screen.band.groups[1]).toMatchObject({ id: 'running', count: 0 });
  });
  it('印が付いていても、作業中は実行中の札に、入力待ちは要対応の札に今までどおり出す', () => {
    const h = presentHome(initialState(), storeOf([paused('b', 1, '2026-10-05', { live: 'busy' }), paused('w', 1, '2026-10-05', { live: 'waiting' })]), NOW);
    expect(h.running.map((r) => r.id)).toEqual(['b']);
    expect(h.attention.map((a) => a.id)).toEqual(['w']);
  });
});

describe('presentHome の確かめる', () => {
  it('TODO の候補とセッションの提案を、候補になった時刻の古い順に混ぜる', () => {
    const store = storeOf([proposed('nfd', 'done', NOW - 2 * H), proposed('cpu', 'paused', NOW - 0.5 * H, '2026-10-03')], [todo('a', NOW - 60_000), todo('b', NOW - 3 * H)]);
    const h = presentHome(initialState(), store, NOW);
    expect(h.confirm.map((c) => [c.kind, c.id])).toEqual([['todo', 'b'], ['session', 'nfd'], ['session', 'cpu'], ['todo', 'a']]);
    expect(h.confirm[1]).toEqual({ kind: 'session', id: 'nfd', name: 'nfd', projectName: 'alpha', status: 'done', label: 'Done にする？', note: '直した', ago: '2 時間前' });
  });
  // 文言は行の提案の札（第 1 段の candidateLabel）と同じにする。Home と一覧で言い方が食い違わないように。
  it('提案の札は行の提案の札と同じ文言で、Paused は戻る日を言う', () => {
    const label = (returnOn: string | null) => (presentHome(initialState(), storeOf([proposed('p', 'paused', NOW - H, returnOn)]), NOW).confirm[0] as { label: string }).label;
    expect(label('2026-10-03')).toBe('Paused · 10/3（土）？');
    expect(label(null)).toBe('Paused · 日付なし？');
  });
  it('帯の確認待ちは、TODO の候補もセッションの提案も数える', () => {
    const store = storeOf([proposed('nfd', 'done', NOW - 2 * H), proposed('orphan', 'done', NOW - H, null, { projectId: null })], [todo('a', NOW - 60_000)]);
    expect(presentHomeScreen(initialState(), store, NOW).band.groups[2]).toMatchObject({ id: 'pending', count: 3 });
  });
});

describe('プロジェクトの無いセッション（Review Focus）', () => {
  it('projectId が null のセッションと消えたプロジェクトを指すセッションは、今日戻ると確かめるに落ちずに並び、プロジェクト名は null（画面は「未分類」）', () => {
    const store = storeOf([
      paused('nul', 9, '2026-10-02', { projectId: null }),
      paused('gone', 8, '2026-10-01', { projectId: 'gone' }),
      proposed('p1', 'done', NOW - 2 * H, null, { projectId: null }),
      proposed('p2', 'paused', NOW - H, '2026-10-03', { projectId: 'gone' }),
    ]);
    const h = presentHome(initialState(), store, NOW);
    expect(h.returning.map((r) => [r.id, r.projectName])).toEqual([['gone', null], ['nul', null]]);
    expect(h.confirm.map((c) => [c.id, (c as { projectName: string | null }).projectName])).toEqual([['p1', null], ['p2', null]]);
  });
});
