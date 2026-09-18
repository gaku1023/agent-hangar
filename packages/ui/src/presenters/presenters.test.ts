import { describe, expect, it } from 'vitest';
import type { ArtifactDto, ProjectDto, RunDto, SessionDto, SessionSummaryDto, TabDto, TodoDto } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import { initialState } from '../mediator/transition.ts';
import { applyEventsPage, applySubagents, eventsKey, initialStore, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, percentLabel, relativeTime, shortModel, tokensLabel } from './format.ts';
import { presentHome } from './home.ts';
import { presentNewSession } from './newSession.ts';
import { presentArtifactCard, presentProject } from './project.ts';
import { presentProjects } from './projects.ts';
import { presentSessionRow } from './row.ts';
import { presentSession } from './session.ts';
import { presentSessions } from './sessions.ts';
import { presentSettings } from './settings.ts';
import { presentShell } from './shell.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const project = (id: string, status: ProjectDto['status'] = 'active'): ProjectDto => ({ id, name: id, status, isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW - 3_600_000, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: 'name-' + id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, memo: null, hasTranscript: true, live: null, summary: { title: 't', oneLiner: 'one', body: 'b', state: 'done', nextSteps: [], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: 2, updatedAt: 1 }, stats: { turns: 2, model: 'claude-fable-5-1', effort: 'high', filesChanged: 1, prUrl: null, inputTokens: 1234567, outputTokens: 10, contextPercent: null, costUsd: null }, fromScratch: false, ...over });
const runDto = (id: string, sessionId: string, endedAt: number | null = null): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: null, startedAt: NOW - 60_000, endedAt, endReason: endedAt ? 'exited' : null, heartbeatAt: 1 });
const tabDto = (id: string, runId: string, kind: 'agent' | 'shell', closedAt: number | null = null): TabDto => ({ id, runId, sessionId: 's1', kind, title: kind === 'agent' ? 'Claude' : `シェル ${id}`, tmuxName: `hangar-${runId}-${id}`, createdAt: 2, closedAt });
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
    const p = presentShell(state, store, NOW);
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
  it('hangar が起こした run も実行中に出す', () => {
    // 信頼確認のダイアログ待ちの run は Claude のレジストリにまだ載らない。
    const store = storeWith();
    store.runs = { r2: runDto('r2', 's2'), r3: runDto('r3', 's3', NOW) };
    const p = presentHome(initialState(), store, NOW);
    expect(p.running.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(p.running[1]!.live).toBeNull();
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
    const state = { ...initialState(), sessionView: { s1: { ...defaultSessionView(), showThinking: true, showRaw: true, summaryOpen: true } } };
    const q = presentSession(state, store, NOW, 's1');
    expect(q.items.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool', 'meta', 'assistant']);
    expect(q.summaryOpen).toBe(true);
  });
  it('遡って足したページも seq の順に並べ、残りは総数と持っている数で決める', () => {
    let store = storeWith();
    const k = eventsKey('s1', null);
    // 画面を開いたときは最新の側のページが入る。
    store = applyEventsPage(store, k, { sessionId: 's1', total: 4, nextSeq: null, events: [
      { kind: 'user', seq: 2, ts: NOW, text: 'newer' },
      { kind: 'assistant', seq: 3, text: 'newest' },
    ] }, false);
    expect(presentSession(initialState(), store, NOW, 's1')).toMatchObject({ hasMore: true, loaded: 2, total: 4 });
    // 遡ったページは後ろに足されるが、表示は seq の順に戻す。
    store = applyEventsPage(store, k, { sessionId: 's1', total: 4, nextSeq: null, events: [
      { kind: 'user', seq: 0, ts: NOW, text: 'oldest' },
      { kind: 'assistant', seq: 1, text: 'older' },
    ] }, true);
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.items.map((i) => i.seq)).toEqual([0, 1, 2, 3]);
    expect(p.items.map((i) => ('text' in i ? i.text : ''))).toEqual(['oldest', 'older', 'newer', 'newest']);
    expect(p).toMatchObject({ hasMore: false, loaded: 4 });
  });
  it('要約の詳細に出す要約器とモデルと生成の時刻を作る', () => {
    const store = storeWith();
    const at = NOW - 3_600_000;
    const sum = (over: Partial<SessionSummaryDto>): SessionSummaryDto => ({ title: 't', oneLiner: 'one', body: 'b', state: 'done', nextSteps: [], source: 'post_hoc', sourceId: null, sourceModel: null, basedOnTurns: 5, updatedAt: at, ...over });
    store.sessions.s1 = session('s1', { summary: sum({ sourceId: 'lmstudio', sourceModel: 'gemma-4-26b-a4b-it-heretic' }) });
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ sourceLabel: '事後', summarizerLabel: 'lmstudio / gemma-4-26b-a4b-it-heretic', generatedAt: absoluteTime(at) });
    // 種類は source_id が決める。モデル名から推測しない。
    store.sessions.s1 = session('s1', { summary: sum({ sourceId: 'claude-headless', sourceModel: 'haiku' }) });
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ summarizerLabel: 'claude / haiku' });
    // claude を名に含むモデルを LM Studio で使っても、lmstudio のままである。
    store.sessions.s1 = session('s1', { summary: sum({ sourceId: 'lmstudio', sourceModel: 'claude-ish-7b' }) });
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ summarizerLabel: 'lmstudio / claude-ish-7b' });
    // モデル名を言えなかったときは種類だけを出す。
    store.sessions.s1 = session('s1', { summary: sum({ sourceId: 'lmstudio', sourceModel: null }) });
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ summarizerLabel: 'lmstudio' });
    // source_id を持たない古い行は、種類が分からないので不明と出す。
    store.sessions.s1 = session('s1', { summary: sum({ sourceId: null, sourceModel: 'gemma-4-26b-a4b-it-heretic' }) });
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ summarizerLabel: '不明 / gemma-4-26b-a4b-it-heretic' });
    // 土台の要約は要約器を通していないので、種類もモデルも無い。
    store.sessions.s1 = session('s1');
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ summarizerLabel: null, generatedAt: absoluteTime(1) });
  });
  it('無いセッションは notFound。run だけ先に届いていれば読み込み中', () => {
    expect(presentSession(initialState(), storeWith(), NOW, 'zz')).toMatchObject({ notFound: true, loadingSession: false });
    const store = storeWith();
    store.runs = { r9: runDto('r9', 'zz') };
    expect(presentSession(initialState(), store, NOW, 'zz')).toMatchObject({ notFound: false, loadingSession: true });
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

describe('presentSession（実行中）', () => {
  it('run とタブと選択、信頼ダイアログの案内、再開の可否', () => {
    const store = storeWith();
    store.runs = { r1: runDto('r1', 's1') };
    store.tabs = { r1: tabDto('r1', 'r1', 'agent'), t1: tabDto('t1', 'r1', 'shell'), t0: tabDto('t0', 'r1', 'shell', 9) };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.run).toEqual({ id: 'r1', kind: 'start', alive: true, started: '1 分前' });
    expect(p.tabs).toEqual([{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }, { id: 't1', title: 'シェル t1', kind: 'shell', selected: false, closable: true }]);
    expect(p.selectedTab).toBe('r1');
    expect(p).toMatchObject({ trustHint: false, canResume: false, canFork: false, transcriptOpen: true });
    const state = { ...initialState(), sessionView: { s1: { ...defaultSessionView(), selectedTab: 't1', transcriptOpen: false } } };
    const q = presentSession(state, store, NOW, 's1');
    expect(q.selectedTab).toBe('t1');
    expect(q.tabs[1]!.selected).toBe(true);
    expect(q.transcriptOpen).toBe(false);
    store.sessions.s1 = { ...store.sessions.s1!, live: null };
    expect(presentSession(initialState(), store, NOW, 's1').trustHint).toBe(true);
  });
  it('選んでいたタブが閉じたら Claude タブに戻る', () => {
    const store = storeWith();
    store.runs = { r1: runDto('r1', 's1') };
    store.tabs = { r1: tabDto('r1', 'r1', 'agent'), t1: tabDto('t1', 'r1', 'shell', 9) };
    const state = { ...initialState(), sessionView: { s1: { ...defaultSessionView(), selectedTab: 't1' } } };
    const p = presentSession(state, store, NOW, 's1');
    expect(p.selectedTab).toBe('r1');
    expect(p.tabs).toEqual([{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }]);
  });
  it('run が無ければ再開できる。送信中は不可', () => {
    const store = storeWith();
    store.sessions.s2 = { ...store.sessions.s2!, live: null };
    expect(presentSession(initialState(), store, NOW, 's2')).toMatchObject({ run: null, tabs: [], selectedTab: null, canResume: true, canFork: true, trustHint: false });
    expect(presentSession({ ...initialState(), launch: { kind: 'submitting' } }, store, NOW, 's2').canResume).toBe(false);
    store.sessions.s2 = { ...store.sessions.s2!, hasTranscript: false };
    expect(presentSession(initialState(), store, NOW, 's2').canResume).toBe(false);
  });
  it('終了した run でもシェルタブが残っていれば run を出し、Claude タブは alive でない', () => {
    const store = storeWith();
    store.sessions.s2 = { ...store.sessions.s2!, live: null };
    store.runs = { r1: runDto('r1', 's2', NOW) };
    store.tabs = { r1: { ...tabDto('r1', 'r1', 'agent'), sessionId: 's2' }, t1: { ...tabDto('t1', 'r1', 'shell'), sessionId: 's2' } };
    const p = presentSession(initialState(), store, NOW, 's2');
    expect(p.run).toMatchObject({ id: 'r1', alive: false });
    expect(p.canResume).toBe(true);
    expect(p.tabs.map((t) => t.id)).toEqual(['r1', 't1']);
  });
});

describe('presentNewSession', () => {
  it('オーバーレイが newSession のときだけ、解決済みでアーカイブでないプロジェクトを出す', () => {
    const store = storeWith();
    store.projects.gone = { ...project('gone'), resolved: false };
    expect(presentNewSession(initialState(), store)).toBeNull();
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: 'beta', scratch: false }, launch: { kind: 'failed' as const, message: 'x' } };
    const p = presentNewSession(state, store)!;
    expect(p.projects.map((x) => x.id)).toEqual(['alpha', 'beta']);
    expect(p).toMatchObject({ projectId: 'beta', submitting: false, error: 'x' });
    expect(presentNewSession({ ...state, launch: { kind: 'submitting' } }, store)!.submitting).toBe(true);
  });
});

describe('presentSettings（フェーズ 2）', () => {
  it('ツールのパスと MCP のコマンド', () => {
    const store = storeWith();
    store.settings = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'iterm', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false };
    expect(presentSettings(initialState(), store)).toMatchObject({ tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'iterm', codePath: null, mcpInstallCommand: 'npm run hangar -- mcp install' });
    store.settings = null;
    expect(presentSettings(initialState(), store)).toMatchObject({ tmuxPath: null, terminalApp: 'terminal', codePath: null });
  });
});

const todoDto = (id: string, position: number, done = false): TodoDto => ({ id, projectId: 'p1', text: `やる ${id}`, done, position, sessionId: null, updatedAt: 1 });
const artDto = (id: string, over: Partial<ArtifactDto> = {}): ArtifactDto => ({ id, projectId: 'p1', url: `https://claude.ai/code/artifact/${id}`, title: `題名 ${id}`, description: '説明', favicon: '📊', filePath: null, fileExists: false, firstPublishedAt: NOW - 100_000, lastPublishedAt: NOW - 60_000, versionCount: 2, sessionIds: ['s1'], ...over });
const scratchProject = (): ProjectDto => ({ ...project('sc'), name: 'スクラッチ', isScratch: true, path: '/h/.agent-hangar/scratch', lastActivityAt: NOW });

describe('書式', () => {
  it('percentLabel と costLabel', () => {
    expect(percentLabel(null)).toBe('未取得');
    expect(percentLabel(47.4)).toBe('47%');
    expect(percentLabel(0)).toBe('0%');
    expect(costLabel(null)).toBe('');
    expect(costLabel(1.234)).toBe('$1.23');
  });
});

describe('presentShell の使用量', () => {
  it('値が無ければ null、あれば百分率と最終更新', () => {
    const empty = presentShell(initialState(), initialStore(), NOW);
    expect(empty.usage).toEqual({ fiveHour: null, sevenDay: null, updatedLabel: null });
    const store = { ...initialStore(), usage: { fiveHour: { usedPercent: 47, resetsAt: null }, sevenDay: { usedPercent: 7, resetsAt: null }, updatedAt: NOW - 600_000 } };
    expect(presentShell(initialState(), store, NOW).usage).toEqual({ fiveHour: 47, sevenDay: 7, updatedLabel: '10 分前' });
  });
});

describe('presentProject の右レール', () => {
  it('TODO とメモとアーティファクトを並べ、スクラッチは印を付ける', () => {
    const store: Store = {
      ...initialStore(),
      projects: { p1: { ...project('p1'), name: 'alpha', path: '/w/alpha', lastActivityAt: NOW, openTodoCount: 1, memoHead: '# alpha' } },
      todos: { t2: todoDto('t2', 2, true), t1: todoDto('t1', 1) },
      memos: { p1: { projectId: 'p1', markdown: '# alpha\n本文', updatedAt: 5 } },
      artifacts: { a1: artDto('a1'), a2: artDto('a2', { projectId: 'p2' }) },
    };
    const p = presentProject(initialState(), store, NOW, 'p1');
    expect(p.todos).toEqual([{ id: 't1', text: 'やる t1', done: false }, { id: 't2', text: 'やる t2', done: true }]);
    expect(p.memo).toEqual({ markdown: '# alpha\n本文', updatedAt: 5 });
    expect(p.artifacts.map((a) => a.id)).toEqual(['a1']);
    expect(p.isScratch).toBe(false);
  });
  it('アーティファクトのカードは題名と最終公開と編集の可否を持つ', () => {
    expect(presentArtifactCard(artDto('a1'), NOW)).toEqual({ id: 'a1', title: '題名 a1', description: '説明', favicon: '📊', url: 'https://claude.ai/code/artifact/a1', lastPublished: '1 分前', versionCount: 2, canOpenEditor: false });
    const manual = presentArtifactCard(artDto('a2', { title: null, favicon: null, description: null, filePath: '/w/alpha/x.html', fileExists: true }), NOW);
    expect(manual).toMatchObject({ title: 'a2', favicon: '📄', canOpenEditor: true });
  });
});

describe('presentProjects と presentHome（スクラッチ）', () => {
  it('スクラッチのプロジェクトはカードに出さない', () => {
    const store: Store = { ...initialStore(), projects: { p1: { ...project('p1'), name: 'alpha', path: '/w/alpha', lastActivityAt: NOW }, sc: scratchProject() } };
    expect(presentProjects(initialState(), store, NOW, '', false).sections[0]!.cards.map((c) => c.id)).toEqual(['p1']);
    expect(presentHome(initialState(), store, NOW).activeProjects.map((c) => c.id)).toEqual(['p1']);
  });
  it('起動ダイアログの選択肢からも外す。並びは名前順のまま', () => {
    const store: Store = { ...storeWith(), projects: { ...storeWith().projects, sc: scratchProject() } };
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false } };
    const p = presentNewSession(state, store)!;
    expect(p.projects.map((x) => x.id)).toEqual(['alpha', 'beta']);
    expect(p.scratch).toBe(false);
    expect(presentNewSession({ ...state, overlay: { kind: 'newSession', projectId: null, scratch: true } }, store)!.scratch).toBe(true);
  });
});

describe('presentSession のフェーズ 3 の項目', () => {
  it('コンテキストとコストと要約の状態と昇格の可否', () => {
    const base = session('s1');
    const store: Store = {
      ...initialStore(),
      projects: { sc: scratchProject() },
      sessions: { s1: { ...base, projectId: 'sc', fromScratch: false, stats: { ...base.stats, contextPercent: 25, costUsd: 0.5 } } },
      artifacts: { a1: artDto('a1') },
      summaryPending: { s1: true as const },
    };
    const state = { ...initialState(), summaryFailed: { s1: 'LM Studio に繋がりません' } };
    const p = presentSession(state, store, NOW, 's1');
    expect(p.contextPercent).toBe(25);
    expect(p.cost).toBe('$0.50');
    expect(p.artifacts.map((a) => a.id)).toEqual(['a1']);
    expect(p.summaryPending).toBe(true);
    expect(p.summaryError).toBe('LM Studio に繋がりません');
    expect(p.canPromote).toBe(true);
    expect(p.fromScratch).toBe(false);
    expect(p.canSplit).toBe(false);
    expect(p.split).toBeNull();
  });
  it('分割はタブが 2 つ以上あるときだけ左右を返す', () => {
    const store = storeWith();
    store.runs = { r1: runDto('r1', 's1') };
    store.tabs = { t1: { ...tabDto('t1', 'r1', 'agent'), createdAt: 1 }, t2: { ...tabDto('t2', 'r1', 'shell'), createdAt: 2 } };
    const view = { ...defaultSessionView(), selectedTab: 't1', split: true, splitTab: 't9' };
    const state = { ...initialState(), sessionView: { s1: view } };
    const p = presentSession(state, store, NOW, 's1');
    expect(p.canSplit).toBe(true);
    // splitTab が閉じたタブを指していたら、左と違う最初のタブに落とす。
    expect(p.split).toEqual({ left: 't1', right: 't2' });
    const off = presentSession({ ...state, sessionView: { s1: { ...view, split: false } } }, store, NOW, 's1');
    expect(off.split).toBeNull();
    expect(off.canSplit).toBe(true);
  });
});

describe('presentSettings のフェーズ 3 の項目', () => {
  it('要約器と statusline と使用量の集計を渡す', () => {
    const store: Store = {
      ...initialStore(),
      settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5, allowExternalSummarizer: false },
      statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: true },
      summarizerModels: ['gemma', 'qwen'],
      usageAggregate: { days: [{ day: '2026-09-18', inputTokens: 10, outputTokens: 2, sessions: 1 }], projects: [] },
    };
    const p = presentSettings(initialState(), store);
    expect(p).toMatchObject({ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5, summarizerModels: ['gemma', 'qwen'], statuslineCommand: 'npm run hangar -- statusline install' });
    expect(p.statusline?.installed).toBe(true);
    expect(p.usageAggregate?.days).toHaveLength(1);
    expect(p.summarizerTest).toBeNull();
  });
});

describe('presentSessionRow のコストと run', () => {
  it('コストは通貨の記号と小数 2 桁。値が無ければ空文字で桁を崩さない', () => {
    const store = storeWith();
    expect(presentSessionRow(session('s1', { stats: { ...session('s1').stats, costUsd: 12.5 } }), store, NOW).cost).toBe('$12.50');
    expect(presentSessionRow(session('s1', { stats: { ...session('s1').stats, costUsd: 0.005 } }), store, NOW).cost).toBe('$0.01');
    expect(presentSessionRow(session('s1', { stats: { ...session('s1').stats, costUsd: 0 } }), store, NOW).cost).toBe('$0.00');
    expect(presentSessionRow(session('s1'), store, NOW).cost).toBe('');
  });
  it('runId は生きている run の id。run が無いか終わっていれば null', () => {
    const store = storeWith();
    expect(presentSessionRow(store.sessions.s1!, store, NOW).runId).toBeNull();
    store.runs = { r1: runDto('r1', 's1'), r0: runDto('r0', 's2', NOW) };
    expect(presentSessionRow(store.sessions.s1!, store, NOW).runId).toBe('r1');
    expect(presentSessionRow(store.sessions.s2!, store, NOW).runId).toBeNull();
  });
  it('行を組み立てる画面にもコストと run が乗る', () => {
    const store = storeWith();
    store.runs = { r1: runDto('r1', 's1') };
    store.sessions.s1 = { ...store.sessions.s1!, stats: { ...store.sessions.s1!.stats, costUsd: 3 } };
    expect(presentHome(initialState(), store, NOW).recent[0]).toMatchObject({ id: 's1', cost: '$3.00', runId: 'r1' });
    expect(presentProject(initialState(), store, NOW, 'alpha').sessions[0]).toMatchObject({ id: 's1', cost: '$3.00', runId: 'r1' });
  });
});

describe('presentSession のフェーズ 3 の項目（値が無いとき）', () => {
  it('スクラッチでないプロジェクトは昇格できない。無い値はそのまま空にする', () => {
    const store = storeWith();
    store.sessions.s1 = { ...store.sessions.s1!, fromScratch: true };
    store.artifacts = { a1: artDto('a1'), a9: artDto('a9', { sessionIds: ['s9'] }) };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.canPromote).toBe(false);
    expect(p.fromScratch).toBe(true);
    expect(p.summaryPending).toBe(false);
    expect(p.summaryError).toBeNull();
    expect(p.contextPercent).toBeNull();
    expect(p.cost).toBe('');
    // 別のセッションのアーティファクトは出さない。
    expect(p.artifacts.map((a) => a.id)).toEqual(['a1']);
  });
  it('プロジェクトに属さないセッションは昇格できない', () => {
    const store = storeWith();
    expect(presentSession(initialState(), store, NOW, 's3').canPromote).toBe(false);
  });
});

describe('presentProject の右レール（端）', () => {
  it('スクラッチには印が付く。無いプロジェクトの右レールは空', () => {
    const store: Store = { ...initialStore(), projects: { sc: scratchProject() } };
    expect(presentProject(initialState(), store, NOW, 'sc').isScratch).toBe(true);
    expect(presentProject(initialState(), store, NOW, 'nope')).toMatchObject({ notFound: true, isScratch: false, todos: [], memo: null, artifacts: [] });
  });
});

describe('presentSettings の既定値', () => {
  it('設定がまだ届いていないときの要約器の既定と null の項目', () => {
    const p = presentSettings(initialState(), initialStore());
    expect(p).toMatchObject({ lmStudioUrl: '', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20 });
    expect(p.statusline).toBeNull();
    expect(p.summarizerModels).toBeNull();
    expect(p.usageAggregate).toBeNull();
    expect(p.summarizerTest).toBeNull();
  });
});
