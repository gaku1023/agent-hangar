import { describe, expect, it } from 'vitest';
import type { ArtifactDto, ProjectDto, RetentionDto, RetentionPreviewDto, RunDto, SearchFilter, SessionDto, SessionLockDto, SessionSummaryDto, SettingsDto, SyncStatusBody, TabDto, TodoDto } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { applyEventsPage, applySubagents, eventsKey, initialStore, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, percentLabel, relativeTime, resetsLabel, shortModel, tokensLabel } from './format.ts';
import { presentConfirm } from './confirm.ts';
import { presentHome } from './home.ts';
import { newSessionTarget, presentNewSession } from './newSession.ts';
import { presentArtifactCard, presentProject } from './project.ts';
import { presentProjects } from './projects.ts';
import { presentSessionRow } from './row.ts';
import { buildItems, presentSession } from './session.ts';
import { presentSessions } from './sessions.ts';
import { presentSettings } from './settings.ts';
import { bytesLabel, daysLabel, transcriptMark } from './retention.ts';
import { presentRetentionDialog } from './retentionDialog.ts';
import { presentShell } from './shell.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const project = (id: string, status: ProjectDto['status'] = 'active'): ProjectDto => ({ id, name: id, status, isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW - 3_600_000, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: 'name-' + id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, memo: null, hasTranscript: true, live: null, summary: { title: 't', oneLiner: 'one', body: 'b', state: 'done', nextSteps: [], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: 2, updatedAt: 1 }, stats: { turns: 2, model: 'claude-fable-5-1', effort: 'high', filesChanged: 1, prUrl: null, inputTokens: 1234567, outputTokens: 10, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, ...over });
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
  it('使用率の枠が戻る時刻は、今日なら時刻だけ、別の日なら日付を添える', () => {
    const now = new Date(2026, 9, 1, 15, 30).getTime();
    expect(resetsLabel(new Date(2026, 9, 1, 18, 0).getTime(), now)).toBe('18:00');
    expect(resetsLabel(new Date(2026, 9, 4, 9, 5).getTime(), now)).toBe('10/4 09:05');
    expect(resetsLabel(null, now)).toBeNull();
  });
  it('ヘッダーの使用率に、枠が戻る時刻を添える', () => {
    const now = new Date(2026, 9, 1, 15, 30).getTime();
    const store = initialStore();
    store.usage = { fiveHour: { usedPercent: 28, resetsAt: new Date(2026, 9, 1, 18, 0).getTime() }, sevenDay: { usedPercent: 7, resetsAt: new Date(2026, 9, 4, 9, 0).getTime() }, updatedAt: now };
    expect(presentShell(initialState(), store, now).usage).toMatchObject({ fiveHour: 28, sevenDay: 7, fiveHourResets: '18:00', sevenDayResets: '10/4 09:00' });
  });
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
    // 問いを閉じたときなどに Claude が書く形だけの返事は、モデルではない。
    expect(shortModel('<synthetic>')).toBe('');
    expect(tokensLabel(1234567)).toBe('1.2M');
    expect(tokensLabel(12345)).toBe('12k');
    expect(tokensLabel(999)).toBe('999');
  });
});

describe('presentConfirm', () => {
  it('一覧から削除する確認には、プロジェクトの名前と未分類に戻るセッションの数を添える', () => {
    const state = { ...initialState(), overlay: { kind: 'confirm' as const, confirm: { kind: 'unlinkProject' as const, projectId: 'alpha' } } };
    expect(presentConfirm(state, storeWith())).toEqual({ confirm: { kind: 'unlinkProject', projectId: 'alpha' }, project: { name: 'alpha', sessions: 2 } });
  });
  it('プロジェクトが store から消えていれば id を名前にし、数は 0 にする', () => {
    const state = { ...initialState(), overlay: { kind: 'confirm' as const, confirm: { kind: 'unlinkProject' as const, projectId: 'gone' } } };
    expect(presentConfirm(state, storeWith())?.project).toEqual({ name: 'gone', sessions: 0 });
  });
  it('ほかの確認には何も添えず、確認が出ていなければ null', () => {
    const state = { ...initialState(), overlay: { kind: 'confirm' as const, confirm: { kind: 'adoptSession' as const, sessionId: 's1' } } };
    expect(presentConfirm(state, storeWith())).toEqual({ confirm: { kind: 'adoptSession', sessionId: 's1' }, project: null });
    expect(presentConfirm(initialState(), storeWith())).toBeNull();
  });
});

describe('presentShell', () => {
  // 今いる場所はヘッダのパンくずではなく、各頁の見出しで示す。ヘッダには頁ごとに変わる文字を渡さない。
  it('現在のナビ項目と索引の進行を返し、パンくずは返さない', () => {
    const state = { ...initialState(), screen: { name: 'project' as const, id: 'alpha' } };
    const store = storeWith();
    store.index = { phase: 'indexing', done: 10, total: 40 };
    const p = presentShell(state, store, NOW);
    expect(p.nav.find((n) => n.current)?.label).toBe('プロジェクト');
    expect(p).not.toHaveProperty('crumbs');
    expect(p.indexLabel).toBe('索引 10 / 40 件');
    expect(presentShell(state, { ...store, index: { phase: 'rebuilding', done: 10, total: 200 } }, NOW).indexLabel).toBe('索引の作り直し 10 / 200 件');
    expect(presentShell(state, { ...store, index: { phase: 'scanning', done: 0, total: 0 } }, NOW).indexLabel).toBe('索引を準備中');
    expect(presentShell(state, { ...store, index: { phase: 'idle', done: 0, total: 0 } }, NOW).indexLabel).toBeNull();
  });
  it('設定の索引の文は、ヘッダーと同じ文にし、終わっていれば件数を出す', () => {
    const store = storeWith();
    store.index = { phase: 'rebuilding', done: 10, total: 200 };
    expect(presentSettings(initialState(), store, NOW).indexLabel).toBe('索引の作り直し 10 / 200 件');
    store.index = { phase: 'idle', done: 0, total: 0 };
    expect(presentSettings(initialState(), store, NOW).indexLabel).toBe('3 セッション、3 プロジェクト');
  });
});

describe('ローカルコマンドの記録', () => {
  const sys = (seq: number, text: string) => ({ kind: 'system' as const, seq, ts: 1, text });
  const events = [
    sys(1, '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'),
    sys(2, '<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>'),
    sys(3, '<local-command-stdout>(no content)</local-command-stdout>'),
    sys(4, '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>'),
    sys(5, '<local-command-stdout>Set model to opus</local-command-stdout>'),
  ];
  it('決まり文句と空の出力は落とし、コマンドは 1 行に、出力は中身だけにする', () => {
    expect(buildItems(events, { showThinking: false, showRaw: false, subagents: [] }).map((i) => 'text' in i ? i.text : '')).toEqual(['/exit', '/model opus', 'Set model to opus']);
  });
  it('生の記録を出すときはそのまま出す', () => {
    expect(buildItems(events, { showThinking: false, showRaw: true, subagents: [] }).filter((i) => i.kind === 'system')).toHaveLength(5);
  });
  it('! で打ったシェルは「! コマンド」に、出力は中身だけに、タスクの知らせは要旨だけにする', () => {
    const ev = [
      sys(20, '<bash-input> git status</bash-input>'),
      sys(21, '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'),
      sys(22, '<bash-stdout></bash-stdout><bash-stderr></bash-stderr>'),
      sys(23, '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "調べもの" finished</summary>\n</task-notification>'),
      sys(24, '<system-reminder>内部の注意書き</system-reminder>'),
    ];
    expect(buildItems(ev, { showThinking: false, showRaw: false, subagents: [] }).map((i) => 'text' in i ? i.text : '')).toEqual(['! git status', 'clean', 'Agent "調べもの" finished']);
  });
  it('読み込んだスキルの本文は、スキルの名前の 1 行にする', () => {
    const skill = sys(9, 'Base directory for this skill: /Users/me/.claude/plugins/cache/x/superpowers/6.3.0/skills/brainstorming\n\n# Brainstorming Ideas Into Designs\n\n長い本文…');
    expect(buildItems([skill], { showThinking: false, showRaw: false, subagents: [] }).map((i) => 'text' in i ? i.text : '')).toEqual(['スキル brainstorming を読み込みました']);
    expect(buildItems([skill], { showThinking: false, showRaw: true, subagents: [] })[0]).toMatchObject({ text: skill.text });
  });
});

describe('本文の無い system', () => {
  const events = [
    { kind: 'system' as const, seq: 1, ts: 1, text: 'turn_duration', subtype: 'turn_duration' },
    { kind: 'system' as const, seq: 2, ts: 1, text: 'stop_hook_summary', subtype: 'stop_hook_summary' },
    { kind: 'system' as const, seq: 3, ts: 1, text: '留守の間の要約', subtype: 'away_summary' },
  ];
  it('種類の名前しか無い行は落とし、本文のある行は残す', () => {
    expect(buildItems(events, { showThinking: false, showRaw: false, subagents: [] }).map((i) => 'text' in i ? i.text : '')).toEqual(['留守の間の要約']);
  });
  it('生の記録を出すときは種類の名前だけの行も出す', () => {
    expect(buildItems(events, { showThinking: false, showRaw: true, subagents: [] })).toHaveLength(3);
  });
});

describe('presentHome', () => {
  // 入力待ちが 2 件（w1 は 12 分、w2 は 3 分）、作業中が 1 件（s1）、休みが 1 件（i1）。
  const homeStore = () => {
    const s = storeWith();
    s.sessions = {
      ...s.sessions,
      w1: session('w1', { live: 'waiting', lastActivityAt: NOW - 12 * 60_000, activity: { tool: 'AskUserQuestion', summary: 'AskUserQuestion', question: 'どちらにしますか？' } }),
      w2: session('w2', { live: 'waiting', lastActivityAt: NOW - 3 * 60_000, activity: null }),
      i1: session('i1', { live: 'idle', lastActivityAt: NOW - 8 * 60_000, stats: { ...session('i1').stats, contextPercent: 22 } }),
    };
    s.sessions.s1 = { ...s.sessions.s1!, activity: { tool: 'Edit', summary: 'packages/ui/src/keys.ts', question: null }, stats: { ...s.sessions.s1!.stats, contextPercent: 38.4 } };
    return s;
  };
  it('確かめるは全プロジェクトの候補を古い順に並べ、完了と矛盾した行は数えない', () => {
    const store = homeStore();
    store.projects = { ...store.projects, beta: { ...project('beta'), name: 'beta' } };
    store.todos = {
      a: todoDto('a', 1, false, { sessionId: 's1', note: '新しい', at: NOW - 60_000 }, 'alpha'),
      b: todoDto('b', 1, false, { sessionId: null, note: null, at: NOW - 30 * 60_000 }, 'beta'),
      // done かつ candidate は DTO では起きない（サーバが null にする）が、古いサーバや手で作った値でも数えない。
      c: todoDto('c', 2, true, { sessionId: 's1', note: 'x', at: NOW - 90 * 60_000 }, 'alpha'),
      d: todoDto('d', 3, false, null, 'alpha'),
    };
    const h = presentHome(initialState(), store, NOW);
    expect(h.confirm).toEqual([
      { id: 'b', text: 'やる b', projectId: 'beta', projectName: 'beta', sessionName: '不明なセッション', ago: '30 分前', note: '根拠は書かれていません' },
      { id: 'a', text: 'やる a', projectId: 'alpha', projectName: 'alpha', sessionName: 'name-s1', ago: '1 分前', note: '新しい' },
    ]);
    expect(h.projects.find((p) => p.id === 'alpha')!.counts).toContain('確かめる 1');
  });
  it('候補が無ければ確かめるは空で、件数にも出さない', () => {
    const h = presentHome(initialState(), homeStore(), NOW);
    expect(h.confirm).toEqual([]);
    expect(h.projects.every((p) => !p.counts.includes('確かめる'))).toBe(true);
  });
  it('要対応は入力待ちを長く待っている順に拾い、問いが無ければ決まりの文を出す', () => {
    // w1 は hangar の run で動いている。w2 は別のターミナル（iTerm など）で動いていて、hangar の run が無い。
    const store = homeStore();
    store.runs = { rw1: runDto('rw1', 'w1') };
    expect(presentHome(initialState(), store, NOW).attention).toEqual([
      { id: 'w1', name: 'name-w1', projectName: 'alpha', waited: '12 分', question: 'どちらにしますか？', answer: 'terminal' },
      { id: 'w2', name: 'name-w2', projectName: 'alpha', waited: '3 分', question: '入力を待っています', answer: null },
    ]);
  });
  it('外のターミナルで動く入力待ちは引き取りを、バックグラウンドのものは attach を出す', () => {
    const store = homeStore();
    const live = (sessionId: string, over = {}) => ({ sessionId, status: 'waiting' as const, name: null, nameSource: null, cwd: '/w/alpha', pid: 1, entrypoint: 'cli', ...over });
    store.live = [live('uw1'), live('uw2', { background: { jobId: 'abcd1234' } })];
    const a = presentHome(initialState(), store, NOW).attention;
    expect(a.find((c) => c.id === 'w1')!.answer).toBe('adopt');
    expect(a.find((c) => c.id === 'w2')!.answer).toBe('attach');
    // hangar の run があれば、その端末で答える。
    store.runs = { rw1: runDto('rw1', 'w1') };
    expect(presentHome(initialState(), store, NOW).attention.find((c) => c.id === 'w1')!.answer).toBe('terminal');
  });
  it('終わった run しか無い入力待ちは、hangar の端末で答えられない', () => {
    const store = homeStore();
    store.runs = { rw1: runDto('rw1', 'w1', NOW - 1_000) };
    expect(presentHome(initialState(), store, NOW).attention.find((a) => a.id === 'w1')!.answer).toBeNull();
  });
  it('答えた後の AskUserQuestion のように、対象がツール名と同じなら対象を空にする', () => {
    const store = homeStore();
    store.sessions.s1 = { ...store.sessions.s1!, activity: { tool: 'AskUserQuestion', summary: 'AskUserQuestion', question: null } };
    expect(presentHome(initialState(), store, NOW).running[0]!.activity).toEqual({ tool: 'AskUserQuestion', summary: '' });
  });
  it('対象の先頭がツール名と半角空白なら、その繰り返しを削る', () => {
    const store = homeStore();
    store.sessions.s1 = { ...store.sessions.s1!, activity: { tool: 'Bash', summary: 'Bash npx vitest run sync', question: null } };
    expect(presentHome(initialState(), store, NOW).running[0]!.activity).toEqual({ tool: 'Bash', summary: 'npx vitest run sync' });
  });
  it('対象がツール名で始まっていても、続きが半角空白でなければそのまま出す', () => {
    const store = homeStore();
    store.sessions.s1 = { ...store.sessions.s1!, activity: { tool: 'Read', summary: 'Readme.md', question: null } };
    expect(presentHome(initialState(), store, NOW).running[0]!.activity).toEqual({ tool: 'Read', summary: 'Readme.md' });
  });
  it('実行中は作業中と休みを拾い、入力待ちは要対応だけに出す', () => {
    const p = presentHome(initialState(), homeStore(), NOW);
    expect(p.running.map((r) => r.id)).toEqual(['s1', 'i1']);
    expect(p.running[0]).toEqual({ id: 's1', name: 'name-s1', live: 'busy', elapsed: '2 時間', meta: 'alpha · fable 5.1 · high', activity: { tool: 'Edit', summary: 'packages/ui/src/keys.ts' }, note: null, contextPercent: 38.4, contextLabel: '38%' });
    expect(p.running[1]).toMatchObject({ live: 'idle', activity: null, note: '休み。最後の返答から 8 分', contextPercent: 22, contextLabel: '22%' });
  });
  it('作業中でも呼び出しがまだ無ければ「作業中」、レジストリに載る前の run は「起動しています」', () => {
    // 信頼確認のダイアログ待ちの run は Claude のレジストリにまだ載らない。
    const store = storeWith();
    store.runs = { r2: runDto('r2', 's2'), r3: runDto('r3', 's3', NOW) };
    const p = presentHome(initialState(), store, NOW);
    expect(p.running.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(p.running[0]).toMatchObject({ activity: null, note: '作業中', contextLabel: '未取得' });
    expect(p.running[1]).toMatchObject({ live: null, activity: null, note: '起動しています' });
  });
  it('最近は要対応と実行中に出したものを除き、新しい順に並べる', () => {
    expect(presentHome(initialState(), homeStore(), NOW).recent.map((r) => r.id)).toEqual(['s3', 's2']);
  });
  it('終わったセッションは札から消えて、最近に入る', () => {
    const store = homeStore();
    store.sessions.s1 = { ...store.sessions.s1!, live: null, lastActivityAt: NOW - 30_000 };
    const p = presentHome(initialState(), store, NOW);
    expect(p.running.map((r) => r.id)).toEqual(['i1']);
    expect(p.recent[0]!.id).toBe('s1');
  });
  it('プロジェクトは active だけを小さな一覧にし、0 の数は出さない', () => {
    const store = homeStore();
    // 数は手元のセッションから数え、サーバの runningCount は見ない。
    // 実行中は作業中、休み、起動中（hangar の run はあるが Claude の一覧にまだ無い）で、入力待ちは要対応に別に数える。
    store.projects.alpha = { ...store.projects.alpha!, runningCount: 99, openTodoCount: 3 };
    store.runs = { r2: runDto('r2', 's2') };
    expect(presentHome(initialState(), store, NOW).projects).toEqual([{ id: 'alpha', name: 'alpha', status: 'active', counts: '実行中 3 · TODO 3 · 要対応 2' }]);
    store.runs = {};
    store.sessions = { w1: store.sessions.w1!, s2: store.sessions.s2! };
    expect(presentHome(initialState(), store, NOW).projects[0]!.counts).toBe('TODO 3 · 要対応 1');
    store.projects.alpha = { ...store.projects.alpha!, openTodoCount: 0 };
    store.sessions = { s2: store.sessions.s2! };
    expect(presentHome(initialState(), store, NOW).projects[0]!.counts).toBe('');
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
  it('カードの実行中と要対応は手元のセッションから数え、ホームと同じ数え方にする', () => {
    const store = storeWith();
    // サーバの runningCount は入力待ちを含み、起動中を含まないので使わない。
    store.projects.alpha = { ...store.projects.alpha!, runningCount: 99 };
    store.sessions.w1 = session('w1', { live: 'waiting' });
    store.runs = { r2: runDto('r2', 's2') };
    const alpha = presentProjects(initialState(), store, NOW, '', false).sections[0]!.cards[0]!;
    expect(alpha).toMatchObject({ runningCount: 2, waitingCount: 1 });
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
  it('見出しの上には、一覧へ戻るリンクを出す', () => {
    const parent = { label: 'プロジェクト', route: { name: 'projects' } };
    expect(presentProject(initialState(), storeWith(), NOW, 'alpha').parent).toEqual(parent);
    expect(presentProject(initialState(), storeWith(), NOW, 'nope').parent).toEqual(parent);
  });
});

describe('presentSession', () => {
  it('見出しの上には、属するプロジェクトへ戻るリンクを出し、属さなければ出さない', () => {
    const store = storeWith();
    expect(presentSession(initialState(), store, NOW, 's1').parent).toEqual({ label: 'alpha', route: { name: 'project', id: 'alpha' } });
    expect(presentSession(initialState(), store, NOW, 's3').parent).toBeNull();
    expect(presentSession(initialState(), store, NOW, 'nope').parent).toBeNull();
  });
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
    expect(p.summary).toMatchObject({ title: 't', sourceLabel: '自動', stateLabel: '済んだ' });
    const state = { ...initialState(), sessionView: { s1: { ...defaultSessionView(), showThinking: true, showRaw: true, summaryOpen: true } } };
    const q = presentSession(state, store, NOW, 's1');
    expect(q.items.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool', 'meta', 'assistant']);
    expect(q.summaryOpen).toBe(true);
  });
  it('ターンの目次を作り、開いたターンの中身だけを渡す', () => {
    let store = storeWith();
    store = applyEventsPage(store, eventsKey('s1', null), { sessionId: 's1', total: 10, nextSeq: null, events: [
      { kind: 'user', seq: 5, ts: NOW, text: 'はじめの指示' },
      { kind: 'tool_call', seq: 6, toolId: 't1', name: 'Bash', input: {}, summary: 'Bash ls' },
      { kind: 'assistant', seq: 7, text: '見ました' },
      { kind: 'user', seq: 8, ts: NOW, text: '次の指示' },
      { kind: 'assistant', seq: 9, text: 'はい' },
    ] }, false);
    const closed = presentSession(initialState(), store, NOW, 's1');
    expect(closed.turnRows.map((t) => [t.seq, t.head, t.tools, t.open])).toEqual([[5, 'はじめの指示', 1, false], [8, '次の指示', 0, false]]);
    // seq 0 から 4 はまだ読み込んでいないので、目次は会話の最初から始まっていない。
    expect(closed.turnsComplete).toBe(false);
    expect(closed.openTurnItems).toEqual([]);
    const state = { ...initialState(), sessionView: { s1: { ...defaultSessionView(), openTurn: 5 } } };
    const open = presentSession(state, store, NOW, 's1');
    expect(open.turnRows[0]!.open).toBe(true);
    expect(open.openTurnItems.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
  });
  it('実行中なら状態と経過の札を作り、変更数を渡す', () => {
    const store = storeWith();
    expect(presentSession(initialState(), store, NOW, 's1')).toMatchObject({ liveLabel: '作業中 2 時間', filesChanged: 1 });
    expect(presentSession(initialState(), store, NOW, 's2').liveLabel).toBeNull();
  });
  // Home の要対応と休みの札は最後の動きから数える。同じセッションで待ちの長さが 2 つに割れないよう揃える。
  it('入力待ちと休みは最後の動きから、作業中は始まりから数える', () => {
    const store = storeWith();
    store.sessions.s1 = { ...store.sessions.s1!, live: 'waiting' };
    expect(presentSession(initialState(), store, NOW, 's1').liveLabel).toBe('入力待ち 1 分');
    store.sessions.s1 = { ...store.sessions.s1!, live: 'idle' };
    expect(presentSession(initialState(), store, NOW, 's1').liveLabel).toBe('休み 1 分');
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
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ sourceLabel: '事後', summarizerLabel: 'LM Studio / gemma-4-26b-a4b-it-heretic', generatedAt: absoluteTime(at) });
    // 種類は source_id が決める。モデル名から推測しない。
    store.sessions.s1 = session('s1', { summary: sum({ sourceId: 'claude-headless', sourceModel: 'haiku' }) });
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ summarizerLabel: 'claude / haiku' });
    // claude を名に含むモデルを LM Studio で使っても、LM Studio のままである。
    store.sessions.s1 = session('s1', { summary: sum({ sourceId: 'lmstudio', sourceModel: 'claude-ish-7b' }) });
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ summarizerLabel: 'LM Studio / claude-ish-7b' });
    // モデル名を言えなかったときは種類だけを出す。
    store.sessions.s1 = session('s1', { summary: sum({ sourceId: 'lmstudio', sourceModel: null }) });
    expect(presentSession(initialState(), store, NOW, 's1').summary).toMatchObject({ summarizerLabel: 'LM Studio' });
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
    expect(r.rows[0]!.excerpt).toEqual([{ text: '…', hit: false }, { text: 'hi', hit: true }, { text: '…', hit: false }]);
  });
  it('切れた結果は、見せている件数と全件の数を分けて持ち、読み足しの最中を区別する', () => {
    const base = storeWith();
    const state = { ...initialState(), screen: { name: 'sessions' as const, q: 'hi' }, search: { text: 'hi', filter: {} } };
    const hits = [{ sessionId: 's1', matchCount: 1, snippets: [] }, { sessionId: 's2', matchCount: 1, snippets: [] }];
    const done = presentSessions(state, { ...base, search: { params: { q: 'hi' }, result: { hits, total: 132 }, loading: false } }, NOW);
    expect(done).toMatchObject({ shown: 2, total: 132, loading: false, loadingMore: false });
    const more = presentSessions(state, { ...base, search: { params: { q: 'hi', offset: 2 }, result: { hits, total: 132 }, loading: true } }, NOW);
    expect(more).toMatchObject({ shown: 2, total: 132, loading: false, loadingMore: true });
    const fresh = presentSessions(state, { ...base, search: { params: { q: 'hi' }, result: { hits, total: 132 }, loading: true } }, NOW);
    expect(fresh).toMatchObject({ loading: true, loadingMore: false });
    expect(presentSessions(initialState(), base, NOW)).toMatchObject({ shown: 3, total: 3, loadingMore: false });
  });
  it('期間は日数で持ち、手元の一覧は今日の 0 時から数えて絞る', () => {
    const now = new Date(2026, 9, 1, 15, 30).getTime();
    const store = initialStore();
    store.bootstrapped = true;
    store.projects = { alpha: project('alpha') };
    store.sessions = {
      today: session('today', { lastActivityAt: new Date(2026, 9, 1, 0, 5).getTime() }),
      yesterday: session('yesterday', { lastActivityAt: new Date(2026, 8, 30, 23, 55).getTime() }),
      week: session('week', { lastActivityAt: new Date(2026, 8, 25, 1).getTime() }),
    };
    const ids = (days: number | undefined) => presentSessions({ ...initialState(), search: { text: '', filter: { days } } }, store, now).rows.map((r) => r.id);
    expect(ids(1)).toEqual(['today']);
    expect(ids(7)).toEqual(['today', 'yesterday', 'week']);
    expect(ids(undefined)).toHaveLength(3);
  });
  it('状態の絞り込みは、実行中（作業中、休み、起動中）、入力待ち、終了に分ける', () => {
    const store = storeWith();
    store.sessions.w1 = session('w1', { live: 'waiting' });
    store.runs = { r2: runDto('r2', 's2') };
    const ids = (live: SearchFilter['live']) => presentSessions({ ...initialState(), search: { text: '', filter: { live } } }, store, NOW).rows.map((r) => r.id).sort();
    expect(ids('running')).toEqual(['s1', 's2']);
    expect(ids('waiting')).toEqual(['w1']);
    expect(ids('ended')).toEqual(['s3']);
    expect(ids(undefined)).toEqual(['s1', 's2', 's3', 'w1']);
  });
  // 見出しの件数は条件に関わらずセッションの全件で、条件の行が絞った結果の件数を言う（D1）。
  it('見出しには全件の数、条件の行にはいま効いている条件を並べる', () => {
    const store = storeWith();
    const none = presentSessions(initialState(), store, NOW);
    expect(none).toMatchObject({ allCount: 3, conditions: [] });
    const state = { ...initialState(), screen: { name: 'sessions' as const, q: '索引' }, search: { text: '索引', filter: { projectId: 'alpha', days: 7, live: 'waiting' as const, file: 'src/a.ts' } } };
    const r = presentSessions(state, { ...store, search: { params: { q: '索引' }, result: { hits: [], total: 0 }, loading: false } }, NOW);
    expect(r.allCount).toBe(3);
    expect(r.conditions).toEqual(['『索引』', 'alpha', '7 日', '入力待ち', 'src/a.ts']);
    const today = presentSessions({ ...initialState(), search: { text: '', filter: { days: 1, live: 'running' } } }, store, NOW);
    expect(today.conditions).toEqual(['今日', '実行中']);
  });
  it('キーワードが無くても、触ったファイルで絞るときはサーバの結果を並べる', () => {
    let store = storeWith();
    store = { ...store, search: { params: { q: '', file: 'a.md' }, result: { hits: [{ sessionId: 's2', matchCount: 3, snippets: [] }], total: 1 }, loading: false } };
    const state = { ...initialState(), screen: { name: 'sessions' as const }, search: { text: '', filter: { file: 'a.md' } } };
    const r = presentSessions(state, store, NOW);
    expect(r.mode).toBe('search');
    expect(r.rows.map((x) => x.id)).toEqual(['s2']);
    expect(r.rows[0]!.excerpt).toBeUndefined();
    expect(r.total).toBe(1);
  });
});

describe('セッションの並び順', () => {
  it('生きているものを先に、waiting、busy、idle の順に並べ、同じ状態の中は新しい順', () => {
    const store = initialStore();
    store.bootstrapped = true;
    store.projects = { alpha: project('alpha') };
    store.sessions = {
      idleNew: session('idleNew', { live: 'idle', lastActivityAt: NOW - 1_000 }),
      busyOld: session('busyOld', { live: 'busy', lastActivityAt: NOW - 90_000 }),
      waitOld: session('waitOld', { live: 'waiting', lastActivityAt: NOW - 80_000 }),
      busyNew: session('busyNew', { live: 'busy', lastActivityAt: NOW - 5_000 }),
      waitNew: session('waitNew', { live: 'waiting', lastActivityAt: NOW - 70_000 }),
      endedNew: session('endedNew', { lastActivityAt: NOW }),
      endedOld: session('endedOld', { lastActivityAt: NOW - 100_000 }),
    };
    expect(presentSessions(initialState(), store, NOW).rows.map((r) => r.id)).toEqual(['waitNew', 'waitOld', 'busyNew', 'busyOld', 'idleNew', 'endedNew', 'endedOld']);
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

describe('newSessionTarget', () => {
  const at = (screen: State['screen']) => ({ ...initialState(), screen });
  it('プロジェクトの画面ならそのプロジェクト、セッションの画面ならそのセッションのプロジェクト', () => {
    const store = storeWith();
    expect(newSessionTarget(at({ name: 'project', id: 'alpha' }), store)).toEqual({ projectId: 'alpha' });
    expect(newSessionTarget(at({ name: 'session', id: 's1' }), store)).toEqual({ projectId: 'alpha' });
    expect(presentShell(at({ name: 'session', id: 's1' }), store, NOW).newSession).toEqual({ projectId: 'alpha' });
  });
  it('ほかの画面と、プロジェクトの無いセッションでは何も選ばない', () => {
    const store = storeWith();
    expect(newSessionTarget(at({ name: 'home' }), store)).toEqual({});
    expect(newSessionTarget(at({ name: 'sessions' }), store)).toEqual({});
    expect(newSessionTarget(at({ name: 'session', id: 's3' }), store)).toEqual({});
    expect(newSessionTarget(at({ name: 'session', id: 'zz' }), store)).toEqual({});
  });
  // スクラッチの擬似プロジェクトは選べないので、その画面の「新規」と同じくスクラッチで始める。
  it('スクラッチのプロジェクトとそのセッションではスクラッチで開く', () => {
    const store = storeWith();
    store.projects = { ...store.projects, scratch: { ...project('scratch'), isScratch: true } };
    store.sessions = { ...store.sessions, sc: session('sc', { projectId: 'scratch' }) };
    expect(newSessionTarget(at({ name: 'project', id: 'scratch' }), store)).toEqual({ scratch: true });
    expect(newSessionTarget(at({ name: 'session', id: 'sc' }), store)).toEqual({ scratch: true });
  });
});

describe('presentNewSession', () => {
  it('オーバーレイが newSession のときだけ、解決済みでアーカイブでないプロジェクトを名前順に出す', () => {
    const store = storeWith();
    store.projects.gone = { ...project('gone'), resolved: false };
    expect(presentNewSession(initialState(), store, NOW)).toBeNull();
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: 'beta', scratch: false }, launch: { kind: 'failed' as const, message: 'x' } };
    const p = presentNewSession(state, store, NOW)!;
    expect(p.projects.map((x) => x.id)).toEqual(['alpha', 'beta']);
    expect(p).toMatchObject({ projectId: 'beta', submitting: false, error: 'x' });
    expect(presentNewSession({ ...state, launch: { kind: 'submitting' } }, store, NOW)!.submitting).toBe(true);
  });
  it('ステータスと最後に使った時期を添え、最近は最後に使った順の上位 5 件', () => {
    const store = storeWith();
    for (const [id, ago] of [['p1', 1], ['p2', 5], ['p3', 3], ['p4', 9], ['p5', 2], ['p6', 7], ['p7', null]] as const) {
      store.projects[id] = { ...project(id), lastActivityAt: ago === null ? null : NOW - ago * 60_000 };
    }
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false } };
    const p = presentNewSession(state, store, NOW)!;
    expect(p.recentIds).toEqual(['p1', 'p5', 'p3', 'p2', 'p6']);
    const p1 = p.projects.find((x) => x.id === 'p1')!;
    expect(p1).toMatchObject({ status: store.projects.p1!.status, lastActivity: '1 分前' });
    expect(p.projects.find((x) => x.id === 'p7')!.lastActivity).toBe('');
  });
});

describe('presentSettings（フェーズ 2）', () => {
  it('ツールのパスと MCP のコマンド', () => {
    const store = storeWith();
    store.settings = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'iterm', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null };
    expect(presentSettings(initialState(), store)).toMatchObject({ tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'iterm', codePath: null, mcpInstallCommand: 'npm run hangar -- mcp install' });
    store.settings = null;
    expect(presentSettings(initialState(), store)).toMatchObject({ tmuxPath: null, terminalApp: 'terminal', codePath: null });
  });
});

const todoDto = (id: string, position: number, done = false, candidate: TodoDto['candidate'] = null, projectId = 'p1'): TodoDto => ({ id, projectId, text: `やる ${id}`, done, position, sessionId: null, updatedAt: 1, candidate });
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

describe('presentShell の接続', () => {
  it('つながっている間は何も出さない', () => {
    const s = { ...initialState(), connection: 'connected' as const };
    expect(presentShell(s, initialStore(), NOW).conn).toEqual({ visible: false, staleLabel: '', retryLabel: '' });
  });
  it('切れている間は、止まった時刻と次に試すまでの秒を出す', () => {
    const s = { ...initialState(), connection: 'disconnected' as const, staleSince: NOW - 120_000, nextRetryAt: NOW + 7_500 };
    expect(presentShell(s, initialStore(), NOW).conn).toEqual({ visible: true, staleLabel: '画面は 2 分前のまま止まっています', retryLabel: '8 秒後に再接続します' });
  });
  it('切れた直後は、時刻を言わずに止まったとだけ言う', () => {
    const s = { ...initialState(), connection: 'disconnected' as const, staleSince: NOW - 30_000, nextRetryAt: NOW + 2_000 };
    expect(presentShell(s, initialStore(), NOW).conn.staleLabel).toBe('画面の更新が止まっています');
  });
  it('待ち時間が尽きたら、試している最中だと出す', () => {
    const s = { ...initialState(), connection: 'disconnected' as const, staleSince: NOW, nextRetryAt: NOW };
    expect(presentShell(s, initialStore(), NOW).conn.retryLabel).toBe('再接続しています');
  });
  it('最初の接続の間はヘッダーに出さない。読み込み中の画面が担うからである', () => {
    expect(presentShell(initialState(), initialStore(), NOW).conn.visible).toBe(false);
  });
});

describe('presentShell の使用量', () => {
  it('値が無ければ null、あれば百分率と最終更新', () => {
    const empty = presentShell(initialState(), initialStore(), NOW);
    expect(empty.usage).toEqual({ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null });
    const store = { ...initialStore(), usage: { fiveHour: { usedPercent: 47, resetsAt: null }, sevenDay: { usedPercent: 7, resetsAt: null }, updatedAt: NOW - 600_000 } };
    expect(presentShell(initialState(), store, NOW).usage).toEqual({ fiveHour: 47, sevenDay: 7, fiveHourResets: null, sevenDayResets: null, updatedLabel: '10 分前' });
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
    expect(p.todos).toEqual([{ id: 't1', text: 'やる t1', done: false, candidate: null }, { id: 't2', text: 'やる t2', done: true, candidate: null }]);
    expect(p.memo).toEqual({ markdown: '# alpha\n本文', updatedAt: 5 });
    expect(p.artifacts.map((a) => a.id)).toEqual(['a1']);
    expect(p.isScratch).toBe(false);
  });
  it('候補の TODO は根拠とセッションと経過を出し、分からないものは決まりの文にする', () => {
    const store = storeWith();
    store.projects = { p1: { ...project('p1'), name: 'alpha' } };
    store.sessions = { s1: session('s1', { name: '起動画面の作り直し', projectId: 'p1' }) };
    store.todos = {
      t1: todoDto('t1', 1, false, { sessionId: 's1', note: '直して確かめた', at: NOW - 12 * 60_000 }),
      t2: todoDto('t2', 2, false, { sessionId: 'gone', note: null, at: NOW - 60 * 60_000 }),
      t3: todoDto('t3', 3, false, { sessionId: null, note: 'n', at: NOW - 5 * 60_000 }),
      t4: todoDto('t4', 4),
    };
    const p = presentProject(initialState(), store, NOW, 'p1');
    expect(p.todos.map((t) => t.candidate)).toEqual([
      { note: '直して確かめた', sessionId: 's1', sessionName: '起動画面の作り直し', ago: '12 分前' },
      { note: '根拠は書かれていません', sessionId: null, sessionName: '不明なセッション', ago: '1 時間前' },
      { note: 'n', sessionId: null, sessionName: '不明なセッション', ago: '5 分前' },
      null,
    ]);
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
    expect(presentHome(initialState(), store, NOW).projects.map((c) => c.id)).toEqual(['p1']);
  });
  it('起動ダイアログの選択肢からも外す。並びは名前順のまま', () => {
    const store: Store = { ...storeWith(), projects: { ...storeWith().projects, sc: scratchProject() } };
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false } };
    const p = presentNewSession(state, store, NOW)!;
    expect(p.projects.map((x) => x.id)).toEqual(['alpha', 'beta']);
    expect(p.scratch).toBe(false);
    expect(presentNewSession({ ...state, overlay: { kind: 'newSession', projectId: null, scratch: true } }, store, NOW)!.scratch).toBe(true);
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
      settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null },
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
    expect(presentSessions(initialState(), store, NOW).rows[0]).toMatchObject({ id: 's1', cost: '$3.00', runId: 'r1' });
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
  it('nodePath は無ければ空文字、あればそのまま', () => {
    expect(presentSettings(initialState(), initialStore()).nodePath).toBe('');
    const store: Store = { ...initialStore(), settings: fullSettings() };
    expect(presentSettings(initialState(), store).nodePath).toBe('');
    const withNode: Store = { ...initialStore(), settings: fullSettings({ nodePath: '/x/node' }) };
    expect(presentSettings(initialState(), withNode).nodePath).toBe('/x/node');
  });
});

const fullSettings = (over: Partial<SettingsDto> = {}): SettingsDto => ({ workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: '', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null, ...over });
const syncStatus = (over: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', url: 'https://h', lastPushAt: NOW - 1000, lastPullAt: NOW - 60_000, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false }, skipped: [], sweepPending: null, ...over });
const lockDto = (over: Partial<SessionLockDto> = {}): SessionLockDto => ({ deviceId: 'dev-b', deviceName: 'mini', runId: 'r1', heartbeatAt: NOW - 60_000, stale: false, ...over });

describe('同期の Presenter（フェーズ 4）', () => {
  it('ヘッダーの同期状態は種別ごとに文言が変わる', () => {
    const s = { ...initialState(), sync: { kind: 'idle' as const, lastAt: NOW - 60_000 }, pending: 2 };
    expect(presentShell(s, initialStore(), NOW).sync).toEqual({ visible: true, state: 'idle', label: '同期 1 分前', pending: 2, sweepPending: 0, skipped: 0, paused: false });
    expect(presentShell({ ...s, sync: { kind: 'off' } }, initialStore(), NOW).sync).toMatchObject({ visible: false, state: 'off', label: '' });
    expect(presentShell({ ...s, sync: { kind: 'pushing' } }, initialStore(), NOW).sync).toMatchObject({ visible: true, state: 'pushing', label: '送信中' });
    expect(presentShell({ ...s, sync: { kind: 'pulling' } }, initialStore(), NOW).sync).toMatchObject({ state: 'pulling', label: '受信中' });
    expect(presentShell({ ...s, sync: { kind: 'paused' } }, initialStore(), NOW).sync).toMatchObject({ state: 'paused', label: '一時停止中', paused: true });
    expect(presentShell({ ...s, sync: { kind: 'error', message: '切れました' } }, initialStore(), NOW).sync).toMatchObject({ state: 'error', label: '同期エラー: 切れました' });
    // まだ一度も往復していない間は、時刻の代わりに準備中と出す。
    expect(presentShell({ ...s, sync: { kind: 'idle', lastAt: null } }, initialStore(), NOW).sync).toMatchObject({ state: 'idle', label: '同期の準備中' });
  });
  it('ヘッダーに取り残しの件数と送れなかった本文の件数が出る', () => {
    // 本文は 60 秒に 20 件ずつしか流れないので、残りが見えないと進んでいるか分からない。
    const state = { ...initialState(), sync: { kind: 'idle' as const, lastAt: NOW }, pending: 2 };
    const store: Store = { ...initialStore(), sync: syncStatus({ sweepPending: 1500, skipped: [{ key: 'k1', attempts: 3, message: 'x' }, { key: 'k2', attempts: 1, message: 'y' }] }) };
    expect(presentShell(state, store, NOW).sync).toMatchObject({ pending: 2, sweepPending: 1500, skipped: 2 });
    // 数えられない端末は 0 として渡す。ヘッダーは 0 件を描かないので、「分からない」と「無い」を分けなくてよい。
    expect(presentShell(state, { ...initialStore(), sync: syncStatus() }, NOW).sync).toMatchObject({ sweepPending: 0, skipped: 0 });
    expect(presentShell(state, initialStore(), NOW).sync).toMatchObject({ sweepPending: 0, skipped: 0 });
  });
  it('設定のクラウドの節に取り残しと送れなかった本文が出る', () => {
    // ヘッダーと違って、ここは 0 件も描く。0 と書いてあれば「追いついた」と読める。
    const store: Store = { ...initialStore(), sync: syncStatus({ sweepPending: 0, skipped: [{ key: 'k1', attempts: 3, message: '復号できません' }] }) };
    const p = presentSettings(initialState(), store, NOW).cloud;
    expect(p.sweepPending).toBe(0);
    expect(p.skipped).toEqual([{ key: 'k1', attempts: 3, message: '復号できません' }]);
    // 数えられない端末は null のまま渡し、画面が描かない。
    expect(presentSettings(initialState(), { ...initialStore(), sync: syncStatus() }, NOW).cloud.sweepPending).toBeNull();
    expect(presentSettings(initialState(), initialStore(), NOW).cloud).toMatchObject({ sweepPending: null, skipped: [] });
  });
  it('同期の行を足してもフェーズ 3 の使用量ゲージは残る', () => {
    const store = storeWith();
    store.usage = { fiveHour: { usedPercent: 40, resetsAt: null }, sevenDay: null, updatedAt: NOW - 60_000 };
    const p = presentShell({ ...initialState(), sync: { kind: 'idle', lastAt: NOW } }, store, NOW);
    expect(p.usage).toEqual({ fiveHour: 40, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: '1 分前' });
    expect(p.sync.visible).toBe(true);
  });
  it('Settings のクラウドの節', () => {
    const store: Store = { ...initialStore(), sync: syncStatus({ pending: 3 }), devices: [{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: NOW - 120_000, self: true, shell: null }], joinToken: 'tok', settings: fullSettings({ syncClaudeConfig: true }) };
    const p = presentSettings(initialState(), store, NOW).cloud;
    expect(p).toMatchObject({ configured: true, url: 'https://h', state: 'idle', stateLabel: '同期済み', paused: false, pending: 3, lastPullAt: '1 分前', joinToken: 'tok', syncClaudeConfig: true, configConfirmed: false });
    expect(p.devices).toEqual([{ id: 'd', name: 'mac', platform: 'darwin', lastSeen: '2 分前', self: true }]);
    const paused = presentSettings(initialState(), { ...store, sync: syncStatus({ state: 'paused', claudeConfig: { enabled: true, confirmed: true } }) }, NOW).cloud;
    expect(paused).toMatchObject({ configured: true, state: 'paused', stateLabel: '一時停止中', paused: true, configConfirmed: true });
    // ヘッダーと同じ語を使う。
    // エラーの理由はヘッダーにだけ出す。
    expect(presentSettings(initialState(), { ...store, sync: syncStatus({ state: 'pushing' }) }, NOW).cloud.stateLabel).toBe('送信中');
    expect(presentSettings(initialState(), { ...store, sync: syncStatus({ state: 'pulling' }) }, NOW).cloud.stateLabel).toBe('受信中');
    expect(presentSettings(initialState(), { ...store, sync: syncStatus({ state: 'error' }) }, NOW).cloud.stateLabel).toBe('同期エラー');
  });
  it('Settings の外のターミナルの節。自端末は測り直した値を使い、古い版の端末は分からないと書く', () => {
    const devices = [
      { id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: NOW, self: true, shell: 'off' as const },
      { id: 'd2', name: 'mini', platform: 'darwin', lastSeenAt: NOW, self: false, shell: 'unsupported' as const },
      { id: 'd3', name: 'old', platform: 'darwin', lastSeenAt: NOW, self: false, shell: null },
    ];
    const store: Store = { ...initialStore(), devices, shellHook: { state: 'on', zshrc: '/Users/me/.zshrc', line: 'x', command: '/A/bin/hangar shell install' } };
    expect(presentSettings(initialState(), store, NOW).shell).toEqual({
      state: 'on', zshrc: '/Users/me/.zshrc', line: 'x', command: '/A/bin/hangar shell install', uninstallCommand: '/A/bin/hangar shell uninstall',
      devices: [{ id: 'd', name: 'mac', self: true, label: '入っています' }, { id: 'd2', name: 'mini', self: false, label: 'この Claude Code では使えません' }, { id: 'd3', name: 'old', self: false, label: '分かりません（hangar が古い版です）' }],
    });
    expect(presentSettings(initialState(), { ...store, shellHook: null }, NOW).shell.state).toBeNull();
  });
  it('同期を設定していない端末のクラウドの節', () => {
    const p = presentSettings(initialState(), initialStore(), NOW).cloud;
    expect(p).toMatchObject({ configured: false, url: null, state: 'off', paused: false, pending: 0, lastPullAt: '不明', joinToken: null, syncClaudeConfig: false, configConfirmed: false });
    expect(p.devices).toEqual([]);
    // off が届いているだけの端末も「設定していない」と同じ扱いにする。
    expect(presentSettings(initialState(), { ...initialStore(), sync: syncStatus({ state: 'off', url: null }) }, NOW).cloud.configured).toBe(false);
  });
  it('フェーズ 3 までの Settings の項目は消えていない', () => {
    const p = presentSettings(initialState(), { ...initialStore(), settings: fullSettings({ tmuxPath: '/t' }) }, NOW);
    expect(p).toMatchObject({ workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/t', terminalApp: 'terminal', mcpInstallCommand: 'npm run hangar -- mcp install', statuslineCommand: 'npm run hangar -- statusline install', summaryHourlyCap: 20 });
  });
  it('now を渡さない既存の呼び出しも通る', () => {
    expect(presentSettings(initialState(), initialStore()).cloud.state).toBe('off');
  });
});

describe('セッションのロック（フェーズ 4）', () => {
  it('他端末で実行中なら再開もフォークもこの PC で再開も止める', () => {
    const store: Store = { ...initialStore(), sessions: { s1: session('s1', { lock: lockDto(), remoteOnly: true, transcriptMtime: null }) } };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.lock).toEqual({ deviceName: 'mini', stale: false, heartbeat: '1 分前', label: 'mini で実行中' });
    expect(p.remoteOnly).toBe(true);
    expect(p.canResume).toBe(false);
    expect(p.canFork).toBe(false);
    expect(p.canResumeHere).toBe(false);
  });
  it('heartbeat が途絶えたロックは応答がありませんと見せ、この PC で再開だけを開ける（Ruling 14）', () => {
    const store: Store = { ...initialStore(), sessions: { s1: session('s1', { lock: lockDto({ heartbeatAt: NOW - 600_000, stale: true }) }) } };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.lock).toEqual({ deviceName: 'mini', stale: true, heartbeat: '10 分前', label: 'mini から応答がありません' });
    // 相手の run を止めには行かないので、同じ run の続きである再開とフォークは閉じたままにする。
    expect(p.canResume).toBe(false);
    expect(p.canFork).toBe(false);
    expect(p.canResumeHere).toBe(true);
  });
  it('stale のロックは、写しだけのセッションでもこの PC で再開ができる', () => {
    const store: Store = { ...initialStore(), sessions: { s1: session('s1', { lock: lockDto({ stale: true }), remoteOnly: true, transcriptMtime: null }) } };
    expect(presentSession(initialState(), store, NOW, 's1')).toMatchObject({ remoteOnly: true, canResume: false, canFork: false, canResumeHere: true });
  });
  it('生きているロックでは、写しの有無にかかわらずこの PC で再開を閉じる', () => {
    const local: Store = { ...initialStore(), sessions: { s1: session('s1', { lock: lockDto({ stale: false }) }) } };
    expect(presentSession(initialState(), local, NOW, 's1').canResumeHere).toBe(false);
    const remote: Store = { ...initialStore(), sessions: { s1: session('s1', { lock: lockDto({ stale: false }), remoteOnly: true, transcriptMtime: null }) } };
    expect(presentSession(initialState(), remote, NOW, 's1').canResumeHere).toBe(false);
  });
  it('写しだけで誰も動かしていなければ、この PC で再開ができる', () => {
    const store: Store = { ...initialStore(), sessions: { s1: session('s1', { lock: null, remoteOnly: true, transcriptMtime: null }) } };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.lock).toBeNull();
    expect(p.canResumeHere).toBe(true);
    expect(p.canResume).toBe(false);
    expect(p.canFork).toBe(false);
  });
  it('手元に本文があってロックが無ければ普通に再開できる', () => {
    const store: Store = { ...initialStore(), sessions: { s1: session('s1') } };
    expect(presentSession(initialState(), store, NOW, 's1')).toMatchObject({ lock: null, remoteOnly: false, canResume: true, canFork: true, canResumeHere: false });
  });
  it('hangar の run が無く外で動くセッションは、引き取りか attach の手を出す。作業中は出さない', () => {
    const live = (over = {}) => ({ sessionId: 'us1', status: 'idle' as const, name: null, nameSource: null, cwd: '/w/alpha', pid: 1, entrypoint: 'cli', ...over });
    const store: Store = { ...initialStore(), sessions: { s1: session('s1', { live: 'idle' }) }, live: [live()] };
    expect(presentSession(initialState(), store, NOW, 's1').outsideOpen).toBe('adopt');
    store.live = [live({ status: 'busy' })];
    expect(presentSession(initialState(), store, NOW, 's1').outsideOpen).toBeNull();
    // VS Code の拡張の中の claude は引き取らない。
    store.live = [live({ entrypoint: 'claude-vscode' })];
    expect(presentSession(initialState(), store, NOW, 's1').outsideOpen).toBeNull();
    store.live = [live({ status: 'busy', background: { jobId: 'abcd1234' } })];
    expect(presentSession(initialState(), store, NOW, 's1').outsideOpen).toBe('attach');
    store.runs = { r1: runDto('r1', 's1') };
    expect(presentSession(initialState(), store, NOW, 's1').outsideOpen).toBeNull();
  });
  it('本文が無いセッションと、そもそも無いセッションはロックの欄を空にする', () => {
    const store: Store = { ...initialStore(), sessions: { s1: session('s1', { hasTranscript: false }) } };
    expect(presentSession(initialState(), store, NOW, 's1')).toMatchObject({ lock: null, remoteOnly: false, canResume: false, canResumeHere: false });
    expect(presentSession(initialState(), store, NOW, 'zz')).toMatchObject({ notFound: true, lock: null, remoteOnly: false, canResumeHere: false });
  });
});

describe('保持期間の言い方と期限', () => {
  const DAY = 86_400_000;
  it('日数と大きさの言い方', () => {
    expect([30, 90, 365, 3650, 45, 730].map(daysLabel)).toEqual(['30 日', '90 日', '1 年', '10 年', '45 日', '2 年']);
    expect([1_610_612_736, 18 * 1024 ** 3, 52_428_800, 2048, 0].map(bytesLabel)).toEqual(['1.5 GB', '18 GB', '50 MB', '2 KB', '0 KB']);
  });
  it('本文の印は 4 通り', () => {
    expect(transcriptMark(session('a', { transcriptMtime: NOW - 10 * DAY }), 30, NOW)).toBe('present');
    expect(transcriptMark(session('a', { transcriptMtime: NOW - 24 * DAY }), 30, NOW)).toBe('expiring');
    // 期限を過ぎてもまだ消えていなければ、次の起動で消えるので「まもなく」に入れる。
    expect(transcriptMark(session('a', { transcriptMtime: NOW - 31 * DAY }), 30, NOW)).toBe('expiring');
    expect(transcriptMark(session('a', { hasTranscript: false, transcriptMtime: null, lastActivityAt: NOW - 31 * DAY }), 365, NOW)).toBe('gone');
    expect(transcriptMark(session('a', { hasTranscript: false, transcriptMtime: null, lastActivityAt: NOW - 3 * DAY }), 30, NOW)).toBe('none');
    // 他の PC にしか本文が無い会話は、この PC の期限を持たない。
    expect(transcriptMark(session('a', { remoteOnly: true, transcriptMtime: null }), 30, NOW)).toBe('present');
  });
});

describe('presentShell の保持期間の帯', () => {
  const DAY = 86_400_000;
  const R: RetentionDto = { days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: { bytes: 1_610_612_736, dailyBytes: 52_428_800, freeBytes: 400 * 1024 ** 3, measuredAt: NOW } };
  const withSessions = (list: SessionDto[], retention: RetentionDto | null = R): Store => ({ ...initialStore(), bootstrapped: true, retention, sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
  it('消えかけが無ければ、30 日で消えることと使用量を言う', () => {
    expect(presentShell(initialState(), withSessions([]), NOW).retention).toEqual({ visible: true, title: '会話は 30 日で削除されます', detail: 'hangar の履歴からも消えます ・ いま 1.5 GB', extendTo: 365 });
  });
  it('消えかけがあれば件数を言う', () => {
    const s = [session('a', { transcriptMtime: NOW - 25 * DAY }), session('b', { transcriptMtime: NOW - 26 * DAY }), session('c', { transcriptMtime: NOW - 2 * DAY })];
    expect(presentShell(initialState(), withSessions(s), NOW).retention).toMatchObject({ title: '2 件の会話が、まもなく削除されます', detail: 'Claude Code は 30 日で本文を消します ・ いま 1.5 GB' });
  });
  it('使用量をまだ測っていなければ、その部分を出さない', () => {
    expect(presentShell(initialState(), withSessions([], { ...R, usage: null }), NOW).retention.detail).toBe('hangar の履歴からも消えます');
  });
  it('自分で値を入れた人、組織の設定、書けないとき、閉じた後には出さない', () => {
    for (const r of [{ ...R, source: 'user' as const, userValue: 30 }, { ...R, source: 'managed' as const, writable: false }, { ...R, writable: false }]) {
      expect(presentShell(initialState(), withSessions([], r), NOW).retention.visible).toBe(false);
    }
    expect(presentShell({ ...initialState(), retentionBannerDismissed: true }, withSessions([]), NOW).retention.visible).toBe(false);
    expect(presentShell(initialState(), withSessions([], null), NOW).retention.visible).toBe(false);
  });
});

describe('presentRetentionDialog', () => {
  const DAY = 86_400_000;
  const R: RetentionDto = { days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: { bytes: 1_610_612_736, dailyBytes: 52_428_800, freeBytes: 400 * 1024 ** 3, measuredAt: NOW } };
  const P: RetentionPreviewDto = { days: 365, path: '/Users/me/.claude/settings.json', lines: [{ kind: 'ctx', text: '{' }, { kind: 'add', text: '  "cleanupPeriodDays" : 365,' }], baseSha256: 'abc', backupDir: '/Users/me/.agent-hangar/backups/claude-config', projectedBytes: 365 * 52_428_800 };
  const open = (days = 365, from: 'banner' | 'settings' = 'banner') => ({ ...initialState(), overlay: { kind: 'retention' as const, days, from, reloaded: false, writing: false, previewError: null } });
  const st = (over: Partial<Store> = {}): Store => ({ ...initialStore(), retention: R, retentionPreview: P, ...over });
  it('延ばすときの題、説明、見込み、控えを出す', () => {
    const p = presentRetentionDialog(open(), st(), NOW)!;
    expect(p).toMatchObject({ title: '会話の保持期間を 1 年にします', lead: 'Claude Code の設定ファイルに、次の 1 行を足します。', path: P.path, backupDir: P.backupDir + '/', otherPcs: false, shrinkNote: null, showOther: true });
    expect(p.bar).toMatchObject({ nowLabel: 'いま 1.5 GB', projLabel: '1 年たつと約 18 GB', freeLabel: '空き 400 GB', warn: false });
  });
  it('値を替えるときは「書き換えます」、同期が有効なら他の PC の行を出す', () => {
    const lines = [{ kind: 'del' as const, text: '  "cleanupPeriodDays" : 3650' }, { kind: 'add' as const, text: '  "cleanupPeriodDays" : 365' }];
    const p = presentRetentionDialog(open(365, 'settings'), st({ retention: { ...R, days: 3650, source: 'user', userValue: 3650 }, retentionPreview: { ...P, lines }, settings: { ...fullSettings(), syncClaudeConfig: true } }), NOW)!;
    expect(p.lead).toBe('Claude Code の設定ファイルの、次の 1 行を書き換えます。');
    expect(p.otherPcs).toBe(true);
    expect(p.showOther).toBe(false);
  });
  it('縮めるときは題を変え、消える件数を言う', () => {
    const s = { a: session('a', { transcriptMtime: NOW - 40 * DAY }), b: session('b', { transcriptMtime: NOW - 5 * DAY }) };
    const p = presentRetentionDialog(open(30, 'settings'), st({ retention: { ...R, days: 365, source: 'user', userValue: 365 }, retentionPreview: { ...P, days: 30 }, sessions: s }), NOW)!;
    expect(p.title).toBe('会話の保持期間を 30 日に縮めます');
    expect(p.shrinkNote).toBe('次に Claude Code を使い始めたとき、1 件の会話の本文が削除されます。');
  });
  it('下見の失敗をそのまま渡す', () => {
    const s = { ...initialState(), overlay: { kind: 'retention' as const, days: 365, from: 'banner' as const, reloaded: false, writing: false, previewError: 'x' } };
    expect(presentRetentionDialog(s, st({ retentionPreview: null }), NOW)!.previewError).toBe('x');
  });
  it('見込みが空きの半分を超えたら警告にし、下見が届く前は差分を null にする', () => {
    const big = presentRetentionDialog(open(3650), st({ retentionPreview: { ...P, days: 3650, projectedBytes: 300 * 1024 ** 3 } }), NOW)!;
    expect(big.bar!.warn).toBe(true);
    expect(presentRetentionDialog(open(), st({ retentionPreview: null }), NOW)!.lines).toBeNull();
    expect(presentRetentionDialog(initialState(), st(), NOW)).toBeNull();
  });
});

describe('presentSessionRow の本文の印', () => {
  it('行の本文の印は、保持期間（無ければ 30 日）で決める', () => {
    const DAY = 86_400_000;
    const s = session('a', { transcriptMtime: NOW - 25 * DAY });
    expect(presentSessionRow(s, initialStore(), NOW).transcript).toBe('expiring');
    const kept = { ...initialStore(), retention: { days: 365, source: 'user' as const, userValue: 365, writable: true, unwritableReason: null, usage: null } };
    expect(presentSessionRow(s, kept, NOW).transcript).toBe('present');
  });
});

describe('presentSession の本文が消えた会話', () => {
  const DAY = 86_400_000;
  const gone = session('g', { hasTranscript: false, transcriptMtime: null, lastActivityAt: NOW - 40 * DAY });
  const R = { days: 30, source: 'default' as const, userValue: null, writable: true, unwritableReason: null, usage: null };
  it('注記を出し、要約を開き、既定のままなら延ばす手を添える', () => {
    const p = presentSession(initialState(), { ...initialStore(), retention: R, sessions: { g: gone } }, NOW, 'g');
    expect(p.gone).toEqual({ note: '本文は、Claude Code の保持期間（30 日）を過ぎたため削除されたとみられます。残っているのは要約だけです。', canExtend: true, extendTo: 365 });
    expect(p.summaryOpen).toBe(true);
  });
  it('自分で値を入れた後は、延ばす手を出さない。まだ 30 日を過ぎていなければ gone は null', () => {
    expect(presentSession(initialState(), { ...initialStore(), retention: { ...R, source: 'user', userValue: 365 }, sessions: { g: gone } }, NOW, 'g').gone!.canExtend).toBe(false);
    const recent = session('r', { hasTranscript: false, transcriptMtime: null, lastActivityAt: NOW - 2 * DAY });
    expect(presentSession(initialState(), { ...initialStore(), sessions: { r: recent } }, NOW, 'r').gone).toBeNull();
  });
});

describe('presentSettings の会話の保持', () => {
  const R: RetentionDto = { days: 3650, source: 'user', userValue: 3650, writable: true, unwritableReason: null, usage: { bytes: 1_610_612_736, dailyBytes: 52_428_800, freeBytes: 400 * 1024 ** 3, measuredAt: NOW } };
  it('4 つの選択肢と、今の日数での見込みを出す', () => {
    const p = presentSettings(initialState(), { ...initialStore(), retention: R }, NOW).retention!;
    expect(p.options.map((o) => o.label)).toEqual(['30 日', '90 日', '1 年', '10 年']);
    expect(p.days).toBe(3650);
    expect(p.bar!.projLabel).toBe('10 年たつと約 178 GB');
  });
  it('選択肢に無い値は 5 つめとして順に並べる', () => {
    const p = presentSettings(initialState(), { ...initialStore(), retention: { ...R, days: 45, userValue: 45 } }, NOW).retention!;
    expect(p.options.map((o) => o.value)).toEqual(['30', '45', '90', '365', '3650']);
  });
  it('書けないときは理由と値だけを出す', () => {
    const p = presentSettings(initialState(), { ...initialStore(), retention: { ...R, days: 14, source: 'managed', writable: false, unwritableReason: '組織の設定で決まっています' } }, NOW).retention!;
    expect(p).toMatchObject({ writable: false, reason: '組織の設定で決まっています', valueLabel: '14 日' });
  });
  it('まだ届いていなければ null', () => {
    expect(presentSettings(initialState(), initialStore(), NOW).retention).toBeNull();
  });
});
