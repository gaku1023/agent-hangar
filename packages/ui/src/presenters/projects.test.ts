import { describe, expect, it } from 'vitest';
import type { ProjectDto, RunDto, SessionDto, SessionStateDto, SettingsDto, TodoDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { placeOutside, presentProjects } from './projects.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const project = (id: string, status: ProjectDto['status'] = 'active', over: Partial<ProjectDto> = {}): ProjectDto => ({ id, name: id, status, isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW - 3_600_000, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, ...over });
const paused = (returnOn: string | null, returnTime: string | null = null): SessionStateDto => ({ status: 'paused', note: null, returnOn, returnTime, setBy: 'user', setAt: 1, candidate: null });
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: 'name-' + id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
const runDto = (id: string, sessionId: string): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: null, startedAt: NOW - 60_000, endedAt: null, endReason: null, heartbeatAt: 1 });
const todo = (id: string, projectId: string, over: Partial<TodoDto> = {}): TodoDto => ({ id, projectId, text: 't', done: false, position: 0, sessionId: null, updatedAt: 1, candidate: null, ...over });
const settings = (over: Partial<SettingsDto> = {}): SettingsDto => ({ workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: '', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null, ...over });

function storeWith(): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.settings = settings();
  s.projects = { alpha: project('alpha'), beta: project('beta', 'paused'), old: project('old', 'archived') };
  s.sessions = { s1: session('s1', { live: 'busy' }), s2: session('s2'), s3: session('s3', { projectId: null }) };
  return s;
}
const present = (store: Store, filter = '', showArchived = false) => presentProjects(initialState(), store, NOW, filter, showArchived);

describe('presentProjects の節と並び', () => {
  it('節は Active、Paused、Done の順で、該当の無い節は出さない', () => {
    const p = present(storeWith());
    expect(p.sections.map((s) => [s.status, s.label, s.rows.map((r) => r.id)])).toEqual([['active', 'Active', ['alpha']], ['paused', 'Paused', ['beta']]]);
  });
  it('節の中は最後の活動の新しい順で、活動の無いものは末尾', () => {
    const store = storeWith();
    store.projects = { a: project('a', 'active', { lastActivityAt: NOW - 5 * 3_600_000 }), b: project('b', 'active', { lastActivityAt: NOW - 3_600_000 }), c: project('c', 'active', { lastActivityAt: null }) };
    store.sessions = {};
    expect(present(store).sections[0]!.rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
  it('Done の節は Paused の後に出る', () => {
    const store = storeWith();
    store.projects = { ...store.projects, fin: project('fin', 'done') };
    expect(present(store).sections.map((s) => s.status)).toEqual(['active', 'paused', 'done']);
  });
  it('スクラッチの擬似プロジェクトは出さず、数にも入れない', () => {
    const store = storeWith();
    store.projects = { ...store.projects, sc: project('sc', 'active', { isScratch: true }) };
    const p = present(store);
    expect(p.sections[0]!.rows.map((r) => r.id)).toEqual(['alpha']);
    expect(p.total).toBe(3);
  });
  it('名前で絞り込む。大文字と小文字は区別しない', () => {
    const store = storeWith();
    expect(present(store, 'BET').sections.map((s) => [s.status, s.rows.length])).toEqual([['paused', 1]]);
    expect(present(store, 'ol').archived).toMatchObject({ count: 1 });
  });
});

describe('presentProjects の Archived の末尾の 1 行', () => {
  it('Archived は節にせず、数だけを持つ 1 行にする。開くまで行は渡さない', () => {
    const p = present(storeWith());
    expect(p.sections.map((s) => s.status)).not.toContain('archived');
    expect(p.archived).toEqual({ count: 1, open: false, rows: [] });
  });
  it('開くと、その行の下に Archived の行が付く', () => {
    const p = present(storeWith(), '', true);
    expect(p.archived).toMatchObject({ count: 1, open: true });
    expect(p.archived!.rows.map((r) => [r.id, r.status])).toEqual([['old', 'archived']]);
  });
  it('Archived が 1 つも無ければ、行を出さない', () => {
    const store = storeWith();
    delete store.projects.old;
    expect(present(store, '', true).archived).toBeNull();
  });
  it('絞り込みの外にある Archived は数えない', () => {
    expect(present(storeWith(), 'alpha').archived).toBeNull();
  });
});

describe('presentProjects の空のとき', () => {
  it('プロジェクトがひとつも無ければ none にする', () => {
    const store = storeWith();
    store.projects = {};
    expect(present(store)).toMatchObject({ empty: 'none', sections: [], archived: null, total: 0 });
  });
  it('スクラッチだけでも none にする', () => {
    const store = storeWith();
    store.projects = { sc: project('sc', 'active', { isScratch: true }) };
    expect(present(store).empty).toBe('none');
  });
  it('絞り込みで 0 件のときは noMatch にし、none にはしない', () => {
    expect(present(storeWith(), 'zzz').empty).toBe('noMatch');
    expect(present(storeWith()).empty).toBeNull();
  });
  it('クイックセッションがあれば、昇格の入口の相手に最後に動いたものを渡す。無ければ null', () => {
    const store = storeWith();
    store.projects = { sc: project('sc', 'active', { isScratch: true }) };
    expect(present(store).promoteSessionId).toBeNull();
    store.sessions = { q1: session('q1', { projectId: 'sc', lastActivityAt: NOW - 9_000 }), q2: session('q2', { projectId: 'sc', lastActivityAt: NOW - 1_000 }), x: session('x', { projectId: null }) };
    expect(present(store).promoteSessionId).toBe('q2');
  });
  it('プロジェクトがあるときは、昇格の入口を渡さない', () => {
    const store = storeWith();
    store.projects = { ...store.projects, sc: project('sc', 'active', { isScratch: true }) };
    store.sessions = { q1: session('q1', { projectId: 'sc' }) };
    expect(present(store).promoteSessionId).toBeNull();
  });
});

describe('presentProjects の「いま」', () => {
  const nowOf = (store: Store) => present(store).sections[0]!.rows[0]!.now;
  it('入力待ち、実行中、確認待ち、TODO、リマインダーの順に並べ、0 のものは出さない', () => {
    const store = storeWith();
    store.sessions = {
      w1: session('w1', { live: 'waiting' }), r1: session('r1', { live: 'busy' }), r2: session('r2', { live: 'idle' }),
      p1: session('p1', { state: { ...paused('2026-09-04'), candidate: null } }),
      c1: session('c1', { state: { status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: { status: 'done', note: null, returnOn: null, returnTime: null, source: 'in_session', at: NOW } } }),
    };
    store.projects.alpha = project('alpha', 'active', { openTodoCount: 3 });
    store.todos = { t1: todo('t1', 'alpha', { candidate: { sessionId: null, note: null, at: NOW } }) };
    expect(nowOf(store).map((n) => [n.kind, n.text])).toEqual([['waiting', '入力待ち 1'], ['running', '実行中 2'], ['pending', '確認待ち 2'], ['todo', 'TODO 3'], ['reminder', 'リマインダー 9/4（金）']]);
  });
  it('何も無ければ空', () => {
    const store = storeWith();
    store.sessions = {};
    expect(nowOf(store)).toEqual([]);
  });
  it('実行中と入力待ちはホームと同じに、手元のセッションと run から数える', () => {
    const store = storeWith();
    // サーバの runningCount は入力待ちを含み、起動中を含まないので使わない。
    store.projects.alpha = project('alpha', 'active', { runningCount: 99 });
    store.sessions = { w1: session('w1', { live: 'waiting' }), s2: session('s2') };
    store.runs = { r2: runDto('r2', 's2') };
    expect(nowOf(store).map((n) => n.text)).toEqual(['入力待ち 1', '実行中 1']);
  });
  it('確認待ちは完了済みの TODO の候補と、別のプロジェクトの提案を数えない', () => {
    const store = storeWith();
    store.sessions = {};
    store.todos = { t1: todo('t1', 'alpha', { done: true, candidate: { sessionId: null, note: null, at: NOW } }), t2: todo('t2', 'beta', { candidate: { sessionId: null, note: null, at: NOW } }) };
    expect(nowOf(store)).toEqual([]);
  });
  it('言語を English にすると、語も English になる', () => {
    const store = storeWith();
    store.settings = settings({ language: 'en' });
    store.sessions = { w1: session('w1', { live: 'waiting' }) };
    expect(nowOf(store).map((n) => n.text)).toEqual(['Needs input 1']);
  });
});

describe('presentProjects のリマインダー（セッションのいちばん近いもの）', () => {
  const remind = (sessions: Record<string, SessionDto>) => {
    const store = storeWith();
    store.sessions = sessions;
    return present(store).sections[0]!.rows[0]!.now.find((n) => n.kind === 'reminder')?.text ?? null;
  };
  it('そのプロジェクトの Paused のセッションのうち、日付のいちばん早いものを出す', () => {
    expect(remind({ a: session('a', { state: paused('2026-09-10') }), b: session('b', { state: paused('2026-09-04') }), c: session('c', { state: paused('2026-09-20') }) })).toBe('リマインダー 9/4（金）');
  });
  it('同じ日なら時刻のあるものを先にし、時刻の早いほうを出す', () => {
    expect(remind({ a: session('a', { state: paused('2026-09-04') }), b: session('b', { state: paused('2026-09-04', '15:00') }), c: session('c', { state: paused('2026-09-04', '09:30') }) })).toBe('リマインダー 9/4（金）09:30');
  });
  it('過ぎたものは、先のものより先に出す（見落としたものが前に来る）', () => {
    expect(remind({ a: session('a', { state: paused('2026-09-01') }), b: session('b', { state: paused('2026-09-04') }) })).toBe('リマインダー 1 日過ぎ');
  });
  it('今日のものは「今日」と言う', () => {
    expect(remind({ a: session('a', { state: paused('2026-09-02') }) })).toBe('リマインダー 今日');
  });
  it('Paused でないセッションと、日付の無い Paused は数えない', () => {
    expect(remind({ a: session('a', { state: { ...paused('2026-09-04'), status: 'done' } }), b: session('b', { state: paused(null) }), c: session('c', { state: { ...paused('2026-09-04'), status: null } }) })).toBeNull();
  });
  it('ほかのプロジェクトのセッションは見ない', () => {
    expect(remind({ a: session('a', { projectId: 'beta', state: paused('2026-09-04') }), b: session('b', { projectId: null, state: paused('2026-09-04') }) })).toBeNull();
  });
  it('形の壊れた日付は読み飛ばす', () => {
    expect(remind({ a: session('a', { state: paused('明日') }), b: session('b', { state: paused('2026-09-06') }) })).toBe('リマインダー 9/6（日）');
  });
  it('プロジェクト自身には持たせない（Paused のプロジェクトでも、セッションが無ければ出さない）', () => {
    const store = storeWith();
    store.sessions = {};
    expect(present(store).sections[1]!.rows[0]!.now).toEqual([]);
  });
});

describe('presentProjects の 1 行', () => {
  const row = (store: Store) => present(store).sections[0]!.rows[0]!;
  it('セッションの数は、そのプロジェクトのセッションを全部数える（終わったものも）', () => {
    expect(row(storeWith())).toMatchObject({ sessionCount: 2, sessionsText: '2 本' });
    const store = storeWith();
    store.sessions = {};
    expect(row(store)).toMatchObject({ sessionCount: 0, sessionsText: '0 本' });
  });
  it('最後の活動は相対の時刻、活動が無ければ「不明」', () => {
    expect(row(storeWith()).lastActivity).toBe('1 時間前');
    const store = storeWith();
    store.projects.alpha = project('alpha', 'active', { lastActivityAt: null });
    expect(row(store).lastActivity).toBe('不明');
  });
  it('親フォルダの下にあるプロジェクトは場所を出さない', () => {
    expect(row(storeWith()).place).toBeNull();
    const store = storeWith();
    store.projects.alpha = project('alpha', 'active', { path: '/w/tools/alpha' });
    expect(row(store).place).toBeNull();
  });
  it('親フォルダの外にあるプロジェクトは、パスを場所に出す', () => {
    const store = storeWith();
    store.projects.alpha = project('alpha', 'active', { path: '/opt/tools/alpha' });
    expect(row(store).place).toEqual({ kind: 'outside', path: '/opt/tools/alpha' });
  });
  it('この PC でパスが見つからなければ missing にする（パスの有無によらず）', () => {
    const store = storeWith();
    store.projects.alpha = project('alpha', 'active', { resolved: false });
    expect(row(store).place).toEqual({ kind: 'missing' });
    store.projects.alpha = project('alpha', 'active', { path: null, resolved: false });
    expect(row(store).place).toEqual({ kind: 'missing' });
  });
  it('読み上げの名前は、名前、ステータス、「いま」の数を含む', () => {
    const store = storeWith();
    store.sessions = { w1: session('w1', { live: 'waiting' }), r1: session('r1', { live: 'busy' }) };
    expect(row(store).label).toBe('alpha、Active、入力待ち 1、実行中 1');
    store.sessions = {};
    expect(row(store).label).toBe('alpha、Active');
  });
  it('English の読み上げの名前は英語の区切りになる', () => {
    const store = storeWith();
    store.settings = settings({ language: 'en' });
    store.sessions = { w1: session('w1', { live: 'waiting' }) };
    expect(row(store).label).toBe('alpha, Active, Needs input 1');
  });
});

describe('placeOutside', () => {
  it('親フォルダの下なら、直下でも深くても null', () => {
    expect(placeOutside('/Users/a/workspace/agent-hangar', '/Users/a/workspace')).toBeNull();
    expect(placeOutside('/Users/a/workspace/agent-hangar', '/Users/a/workspace/')).toBeNull();
    expect(placeOutside('/Users/a/workspace/tools/hangar', '/Users/a/workspace')).toBeNull();
  });
  it('フォルダ名が NFD で届いても、下にあるものとして読む', () => {
    const nfd = 'ご注文ガイド'.normalize('NFD');
    expect(placeOutside(`/Users/a/workspace/${nfd}`, '/Users/a/workspace')).toBeNull();
    expect(placeOutside('/Users/a/workspace/x', '/Users/a/ワークス'.normalize('NFD'))).toBe('/Users/a/workspace/x');
  });
  it('親フォルダの外なら、そのままのパスを返す。名前が前方一致するだけの別のフォルダも外', () => {
    expect(placeOutside('/opt/tools/hangar', '/Users/a/workspace')).toBe('/opt/tools/hangar');
    expect(placeOutside('/Users/a/workspace2/hangar', '/Users/a/workspace')).toBe('/Users/a/workspace2/hangar');
  });
  it('親フォルダがまだ分からないときは、パスをそのまま返す', () => {
    expect(placeOutside('/Users/a/workspace/hangar', '')).toBe('/Users/a/workspace/hangar');
  });
  it('パスが無ければ null', () => {
    expect(placeOutside(null, '/Users/a/workspace')).toBeNull();
  });
});
