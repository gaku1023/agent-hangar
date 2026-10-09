import { describe, expect, expectTypeOf, it } from 'vitest';
import { addDays, localDate } from '@agent-hangar/shared';
import type { ArtifactDto, ProjectDto, ReadinessDto, RetentionDto, RetentionPreviewDto, RunDto, SearchFilter, SessionDto, SessionLockDto, SessionSummaryDto, SettingsDto, SyncStatusBody, TabDto, TodoDto, TranscriptEvent, UsageDto } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import { initialState } from '../mediator/transition.ts';
import { accountsFixture, FIVE_RESETS, SEVEN_RESETS } from '../test/accounts.ts';
import type { State } from '../mediator/types.ts';
import { applyEventsPage, applySubagents, eventsKey, initialStore, setEventsLoading, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, percentLabel, relativeTime, resetsLabel, shortModel, tokensLabel } from './format.ts';
import { presentConfirm } from './confirm.ts';
import { presentHome, presentHomeScreen } from './home.ts';
import { newSessionTarget, presentNewSession } from './newSession.ts';
import { presentArtifactCard, presentProject } from './project.ts';
import { candidateLabel, presentSessionRow, returnOnLabel } from './row.ts';
import { buildItems, presentSession, sessionActions, summarizerLabel, type SessionProps } from './session.ts';
import { presentSessionList } from './sessions.ts';
import { homePath } from './accounts.ts';
import { presentSettings } from './settings.ts';
import { bytesLabel, daysLabel, transcriptMark } from './retention.ts';
import { presentRetentionDialog } from './retentionDialog.ts';
import { presentShell } from './shell.ts';
import { presentToasts } from './toasts.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const project = (id: string, status: ProjectDto['status'] = 'active'): ProjectDto => ({ id, name: id, status, isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW - 3_600_000, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: 'name-' + id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, memo: null, hasTranscript: true, live: null, summary: { title: 't', oneLiner: 'one', body: 'b', state: 'done', nextSteps: [], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: 2, updatedAt: 1 }, stats: { turns: 2, model: 'claude-fable-5-1', effort: 'high', filesChanged: 1, prUrl: null, inputTokens: 1234567, outputTokens: 10, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
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
    const usage = { fiveHour: { usedPercent: 28, resetsAt: new Date(2026, 9, 1, 18, 0).getTime() }, sevenDay: { usedPercent: 7, resetsAt: new Date(2026, 9, 4, 9, 0).getTime() }, updatedAt: now };
    const store: Store = { ...initialStore(), accounts: { currentId: 'primary', accounts: [{ ...accountsFixture.accounts[0]!, usage }], sessions: {} } };
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
    expect(presentConfirm(state, storeWith())).toEqual({ confirm: { kind: 'unlinkProject', projectId: 'alpha' }, project: { name: 'alpha', sessions: 2 }, accountName: null });
  });
  it('プロジェクトが store から消えていれば id を名前にし、数は 0 にする', () => {
    const state = { ...initialState(), overlay: { kind: 'confirm' as const, confirm: { kind: 'unlinkProject' as const, projectId: 'gone' } } };
    expect(presentConfirm(state, storeWith())?.project).toEqual({ name: 'gone', sessions: 0 });
  });
  it('ほかの確認には何も添えず、確認が出ていなければ null', () => {
    const state = { ...initialState(), overlay: { kind: 'confirm' as const, confirm: { kind: 'adoptSession' as const, sessionId: 's1' } } };
    expect(presentConfirm(state, storeWith())).toEqual({ confirm: { kind: 'adoptSession', sessionId: 's1' }, project: null, accountName: null });
    expect(presentConfirm(initialState(), storeWith())).toBeNull();
  });
  it('切り替えと削除の確認には、指すアカウントの名前を添える。一覧に無ければ null', () => {
    const store: Store = { ...storeWith(), accounts: accountsFixture };
    const confirming = (confirm: State['overlay'] extends infer O ? (O extends { kind: 'confirm'; confirm: infer C } ? C : never) : never): State => ({ ...initialState(), overlay: { kind: 'confirm', confirm } });
    const sw = confirming({ kind: 'switchAccount', sessionId: 's1', accountId: 'a1', working: true });
    expect(presentConfirm(sw, store)).toEqual({ confirm: { kind: 'switchAccount', sessionId: 's1', accountId: 'a1', working: true }, project: null, accountName: '大学' });
    expect(presentConfirm(confirming({ kind: 'switchAccount', sessionId: 's1', accountId: 'primary', working: false }), store)?.accountName).toBe('会社');
    expect(presentConfirm(confirming({ kind: 'removeAccount', accountId: 'a1' }), store)).toEqual({ confirm: { kind: 'removeAccount', accountId: 'a1' }, project: null, accountName: '大学' });
    expect(presentConfirm(confirming({ kind: 'removeAccount', accountId: 'gone' }), store)?.accountName).toBeNull();
    expect(presentConfirm(sw, storeWith())?.accountName).toBeNull();
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
  // セッション画面だけ本文の幅の上限を外す（案 b）。
  // ほかの画面は 1200px のまま。
  it('セッション画面だけ幅を広げる', () => {
    expect(presentShell({ ...initialState(), screen: { name: 'session', id: 's1' } }, storeWith(), NOW).wide).toBe(true);
    expect(presentShell({ ...initialState(), screen: { name: 'home' } }, storeWith(), NOW).wide).toBe(false);
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

describe('本文のツール', () => {
  const ev = [
    { kind: 'tool_call' as const, seq: 0, toolId: 't', name: 'Bash', input: { command: 'npm test' }, summary: 'Bash npm test' },
    { kind: 'tool_result' as const, seq: 1, toolId: 't', text: 'ok', isError: false },
    { kind: 'tool_call' as const, seq: 2, toolId: 'u', name: 'Read', input: { file_path: '/w/app/a.ts' }, summary: 'Read /w/app/a.ts' },
  ];
  it('種類ごとの見せ方を持ち、パスは作業ディレクトリからの相対にする', () => {
    const items = buildItems(ev, { showThinking: false, showRaw: false, subagents: [], cwd: '/w/app' });
    expect(items[0]).toMatchObject({ kind: 'tool', view: { step: 'run', head: { main: 'npm test', meta: [{ text: '0', tone: 'ok' }] } }, raw: null });
    expect(items[1]).toMatchObject({ kind: 'tool', view: { step: 'read', head: { main: 'a.ts' } } });
  });
  it('生の入力の JSON は、生の記録を出すときだけ持つ', () => {
    const [item] = buildItems(ev, { showThinking: false, showRaw: true, subagents: [], cwd: '/w/app' });
    expect(item).toMatchObject({ raw: { input: '{\n  "command": "npm test"\n}', result: 'ok' } });
  });
  it('同じ呼び出しと結果の見せ方は、描き直すたびには作らない', () => {
    const a = buildItems(ev, { showThinking: false, showRaw: false, subagents: [], cwd: '/w/app' });
    const b = buildItems(ev, { showThinking: false, showRaw: false, subagents: [], cwd: '/w/app' });
    expect(a[0]!.kind === 'tool' && b[0]!.kind === 'tool' && a[0]!.view === b[0]!.view).toBe(true);
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
      // done かつ candidate は DTO では起きない（サーバが null にする）が、同期の競り合いで食い違っても数えない。
      c: todoDto('c', 2, true, { sessionId: 's1', note: 'x', at: NOW - 90 * 60_000 }, 'alpha'),
      d: todoDto('d', 3, false, null, 'alpha'),
    };
    const h = presentHome(initialState(), store, NOW);
    expect(h.confirm).toEqual([
      { kind: 'todo', id: 'b', text: 'やる b', projectId: 'beta', projectName: 'beta', sessionName: '不明なセッション', ago: '30 分前', note: '根拠は書かれていません' },
      { kind: 'todo', id: 'a', text: 'やる a', projectId: 'alpha', projectName: 'alpha', sessionName: 'name-s1', ago: '1 分前', note: '新しい' },
    ]);
  });
  it('候補が無ければ確かめるは空で、件数にも出さない', () => {
    const h = presentHome(initialState(), homeStore(), NOW);
    expect(h.confirm).toEqual([]);
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
    expect(p.running[0]).toEqual({ id: 's1', name: 'name-s1', live: 'busy', aside: false, elapsed: '2 時間', meta: 'alpha · fable 5.1 · high', intent: null, activity: { tool: 'Edit', summary: 'packages/ui/src/keys.ts' }, note: null, contextPercent: 38.4, contextLabel: '38%' });
    expect(p.running[1]).toMatchObject({ live: 'idle', activity: null, note: '休み。最後の返答から 8 分', contextPercent: 22, contextLabel: '22%' });
  });
  it('意図は、作業中のセッションがこのターンに書いたものだけを出す', () => {
    const store = homeStore();
    const digest = (inThisTurn: boolean) => ({ sessionId: 's1', turnStartSeq: 1, intent: { text: '一覧の枠をなくす', at: NOW - 1000, stepsSince: 2, inThisTurn }, agents: [] });
    store.liveDigests = { s1: digest(true), i1: { ...digest(true), sessionId: 'i1' } };
    const p = presentHome(initialState(), store, NOW);
    expect(p.running[0]).toMatchObject({ id: 's1', intent: '一覧の枠をなくす' });
    // 休みのセッションは、意図が残っていても出さない。
    expect(p.running[1]).toMatchObject({ id: 'i1', intent: null });
    // 前のターンの意図は、いまの作業を言っていないので出さない。
    store.liveDigests = { s1: digest(false) };
    expect(presentHome(initialState(), store, NOW).running[0]).toMatchObject({ intent: null });
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
  it('何も動いていないこと（idle）は、要対応も実行中も確認待ちも無いときだけ真にする', () => {
    expect(presentHomeScreen(initialState(), homeStore(), NOW).idle).toBe(false);
    const store = homeStore();
    store.sessions = { s2: store.sessions.s2!, w1: store.sessions.w1! };
    // 入力待ちも生きているので、「実行中のセッションはありません」とは言わない。
    expect(presentHomeScreen(initialState(), store, NOW).idle).toBe(false);
    store.sessions = { s2: store.sessions.s2! };
    expect(presentHomeScreen(initialState(), store, NOW).idle).toBe(true);
    // Claude の一覧に載る前の run も動いているものに数える。
    store.runs = { r2: runDto('r2', 's2') };
    expect(presentHomeScreen(initialState(), store, NOW).idle).toBe(false);
  });
  it('終わったセッションは帯の実行中から消える（一覧には残る）', () => {
    const store = homeStore();
    store.sessions.s1 = { ...store.sessions.s1!, live: null, lastActivityAt: NOW - 30_000 };
    const p = presentHome(initialState(), store, NOW);
    expect(p.running.map((r) => r.id)).toEqual(['i1']);
    expect(presentHomeScreen(initialState(), store, NOW).list.rows.map((r) => r.id)).toContain('s1');
  });
});

describe('presentProject', () => {
  it('実行中を先頭に、その後を新しい順に', () => {
    const store = storeWith();
    store.sessions.s4 = session('s4', { live: 'idle', lastActivityAt: NOW - 86_400_000 * 9 });
    const p = presentProject(initialState(), store, NOW, 'alpha');
    expect(p.list.rows.map((r) => r.id)).toEqual(['s1', 's4', 's2']);
    expect(presentProject(initialState(), store, NOW, 'nope').notFound).toBe(true);
  });
  it('見出しの上には、一覧へ戻るリンクを出す', () => {
    const parent = { label: 'プロジェクト', route: { name: 'projects' } };
    expect(presentProject(initialState(), storeWith(), NOW, 'alpha').parent).toEqual(parent);
    expect(presentProject(initialState(), storeWith(), NOW, 'nope').parent).toEqual(parent);
  });
});

describe('presentSession', () => {
  describe('account', () => {
    const two = (over: Partial<typeof accountsFixture> = {}): Store => ({ ...storeWith(), sessions: { ...storeWith().sessions, s9: session('s9') }, accounts: { ...accountsFixture, ...over } });
    it('2 件で対応があれば、そのアカウントの名前と色を出す', () => {
      expect(presentSession(initialState(), two(), NOW, 's9').account).toEqual({ name: '大学', color: '#7a4a9e' });
    });
    it('2 件で対応が無ければ、最初のアカウントを出す', () => {
      expect(presentSession(initialState(), two(), NOW, 's1').account).toEqual({ name: '会社', color: '#2a57b8' });
    });
    it('1 件、一覧が空、store.accounts が null なら null', () => {
      expect(presentSession(initialState(), { ...two(), accounts: { ...accountsFixture, accounts: [accountsFixture.accounts[0]!] } }, NOW, 's1').account).toBeNull();
      expect(presentSession(initialState(), two({ accounts: [], sessions: {} }), NOW, 's1').account).toBeNull();
      expect(presentSession(initialState(), storeWith(), NOW, 's1').account).toBeNull();
    });
    it('store に無いセッションの画面には札を出さない', () => {
      expect(presentSession(initialState(), two(), NOW, 'nope').account).toBeNull();
    });
  });
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
    expect(p).toMatchObject({ name: 'name-s1', live: 'busy', loaded: 6, total: 6, hasMore: false });
    const state = { ...initialState(), sessionView: { s1: { ...defaultSessionView(), showThinking: true, showRaw: true } } };
    const q = presentSession(state, store, NOW, 's1');
    expect(q.items.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool', 'meta', 'assistant']);
    expectTypeOf<SessionProps>().not.toHaveProperty('summaryOpen');
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
  it('本文の窓がまだ無いか、最初の読み込みの途中で 0 件なら、目次は pending', () => {
    const k = eventsKey('s1', null);
    expect(presentSession(initialState(), storeWith(), NOW, 's1').turnsPending).toBe(true); // 窓が無い
    expect(presentSession(initialState(), setEventsLoading(storeWith(), k, true), NOW, 's1').turnsPending).toBe(true);
    expect(presentSession(initialState(), setEventsLoading(storeWith(), k, false), NOW, 's1').turnsPending).toBe(false);
  });
  it('本文が無い会話は、窓が作られないので pending にしない（仮の行が出続けない）', () => {
    const store = storeWith();
    store.sessions.s1 = { ...store.sessions.s1!, hasTranscript: false };
    expect(presentSession(initialState(), store, NOW, 's1').turnsPending).toBe(false);
  });
  it('最初の読み込みが失敗しても、窓は loading が戻って残るので pending にしない', () => {
    // runtime の api.loadEvents は、読み込みの前に loading の窓を作り、失敗したら loading を戻す。
    const k = eventsKey('s1', null);
    const failed = setEventsLoading(setEventsLoading(storeWith(), k, true), k, false);
    expect(presentSession(initialState(), failed, NOW, 's1').turnsPending).toBe(false);
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
  it('要約の作成元に出す要約器とモデルを作る（冒頭の 1 枚の作成元の行になる）', () => {
    // 種類は source_id が決める。モデル名から推測しない。
    expect(summarizerLabel('lmstudio', 'gemma-4-26b-a4b-it-heretic')).toBe('LM Studio / gemma-4-26b-a4b-it-heretic');
    expect(summarizerLabel('claude-headless', 'haiku')).toBe('claude / haiku');
    // claude を名に含むモデルを LM Studio で使っても、LM Studio のままである。
    expect(summarizerLabel('lmstudio', 'claude-ish-7b')).toBe('LM Studio / claude-ish-7b');
    // モデル名を言えなかったときは種類だけを出す。
    expect(summarizerLabel('lmstudio', null)).toBe('LM Studio');
    // source_id を持たない古い行は、種類が分からないので不明と出す。
    expect(summarizerLabel(null, 'gemma-4-26b-a4b-it-heretic')).toBe('不明 / gemma-4-26b-a4b-it-heretic');
    // 土台の要約は要約器を通していないので、種類もモデルも無い。
    expect(summarizerLabel(null, null)).toBeNull();
  });
  it('冒頭の 1 枚の作成元の行に、要約器とモデルと生成の時刻が入る', () => {
    const store = storeWith();
    const at = NOW - 3_600_000;
    store.sessions.s1 = session('s1', { live: null, summary: { title: 't', oneLiner: 'one', body: 'b', state: 'done', nextSteps: [], source: 'post_hoc', sourceId: 'lmstudio', sourceModel: 'gemma', basedOnTurns: 5, updatedAt: at } });
    const line = presentSession(initialState(), store, NOW, 's1').lead!.summary!.sourceLine;
    expect(line).toContain('LM Studio / gemma');
    expect(line).toContain(absoluteTime(at));
  });
  it('真ん中の頁から開いた本文は、新しい行がまだあることと跳び先を持ち、遡り終えたら古い行のボタンを出さない', () => {
    let store = storeWith();
    store = applyEventsPage(store, eventsKey('s1', null), { sessionId: 's1', total: 900, nextSeq: 101, events: [{ kind: 'user', seq: 100, text: 'a' }] }, false);
    const state = { ...initialState(), sessionView: { s1: { ...defaultSessionView(), jump: { seq: 100, query: 'a', n: 1 } } } };
    expect(presentSession(state, store, NOW, 's1')).toMatchObject({ hasNewer: true, hasMore: true, jump: { seq: 100, query: 'a', n: 1 } });
    store = applyEventsPage(store, eventsKey('s1', null), { sessionId: 's1', total: 900, nextSeq: null, events: [] }, true, true);
    expect(presentSession(state, store, NOW, 's1')).toMatchObject({ hasNewer: true, hasMore: false });
  });
  it('無いセッションは notFound。run だけ先に届いていれば読み込み中', () => {
    expect(presentSession(initialState(), storeWith(), NOW, 'zz')).toMatchObject({ notFound: true, loadingSession: false });
    const store = storeWith();
    store.runs = { r9: runDto('r9', 'zz') };
    expect(presentSession(initialState(), store, NOW, 'zz')).toMatchObject({ notFound: false, loadingSession: true });
  });
});

describe('presentSessionList', () => {
  it('検索語が無ければ全件、あれば結果だけを抜粋付きで', () => {
    let store = storeWith();
    const all = presentSessionList(initialState(), store, NOW);
    expect(all.mode).toBe('all');
    expect(all.rows).toHaveLength(3);
    expect(all.projects.map((p) => p.name)).toEqual(['alpha', 'beta', 'old']);
    store = { ...store, search: { params: { q: 'hi' }, result: { hits: [{ sessionId: 's2', matchCount: 2, snippets: [{ seq: 1, role: 'user', text: '…hi…', agentId: null }] }], total: 1 }, loading: false } };
    const state = { ...initialState(), screen: { name: 'home' as const, q: 'hi' }, search: { text: 'hi', filter: {} , page: 1 } };
    const r = presentSessionList(state, store, NOW);
    expect(r.mode).toBe('search');
    expect(r.rows.map((x) => x.id)).toEqual(['s2']);
    expect(r.rows[0]!.excerpt).toEqual([{ text: '…', hit: false }, { text: 'hi', hit: true }, { text: '…', hit: false }]);
    // 行を開くと、抜粋の seq と検索語を持って一致へ跳ぶ。
    expect(r.rows[0]!.jump).toEqual({ seq: 1, q: 'hi' });
    expect(all.rows[0]!.jump).toBeUndefined();
  });
  // seq は主線とサブエージェントで別々に振る。サブエージェントの seq で主線の本文へ跳ぶと、違う行に着く。
  it('跳び先は主線の抜粋だけから取り、主線の抜粋が無ければ跳ばない', () => {
    const state = { ...initialState(), screen: { name: 'home' as const, q: 'hi' }, search: { text: 'hi', filter: {} , page: 1 } };
    const withSnippets = (snippets: { seq: number; role: string; text: string; agentId: string | null }[]) => presentSessionList(state, { ...storeWith(), search: { params: { q: 'hi' }, result: { hits: [{ sessionId: 's2', matchCount: snippets.length, snippets }], total: 1 }, loading: false } }, NOW).rows[0]!;
    const sub = { seq: 2, role: 'assistant', text: '…hi…', agentId: 'ag1' };
    const main = { seq: 9, role: 'user', text: '…hi…', agentId: null };
    expect(withSnippets([sub, main]).jump).toEqual({ seq: 9, q: 'hi' });
    const onlySub = withSnippets([sub]);
    expect(onlySub.jump).toBeUndefined();
    // 抜粋そのものは出す。一致がどこにあるかは読める。
    expect(onlySub.excerpt).toEqual([{ text: '…', hit: false }, { text: 'hi', hit: true }, { text: '…', hit: false }]);
  });
  it('検索の結果は、届いた行と全件の数を持ち、ページ送りは組まない（続きは「さらに読み込む」）', () => {
    const base = storeWith();
    const state = { ...initialState(), screen: { name: 'home' as const, q: 'hi' }, search: { text: 'hi', filter: {}, page: 3 }, pageSize: 25 };
    const hits = [{ sessionId: 's1', matchCount: 1, snippets: [] }, { sessionId: 's2', matchCount: 1, snippets: [] }];
    const done = presentSessionList(state, { ...base, search: { params: { q: 'hi', limit: 50 }, result: { hits, total: 132 }, loading: false } }, NOW);
    expect(done).toMatchObject({ total: 132, loading: false, mode: 'search', pager: null });
    expect(done.rows.map((r) => r.id)).toEqual(['s1', 's2']);
    const loading = presentSessionList(state, { ...base, search: { params: { q: 'hi' }, result: { hits, total: 132 }, loading: true } }, NOW);
    expect(loading).toMatchObject({ loading: true });
  });
  // 件数が 1 ページに収まるときは、ページ送りを出さない。
  it('1 ページに収まるときはページ送りを出さない', () => {
    expect(presentSessionList(initialState(), storeWith(), NOW)).toMatchObject({ total: 3, pager: null });
  });
  it('手元で組む平らな一覧は、いまのページの行だけを切り出す', () => {
    const store = initialStore();
    store.bootstrapped = true;
    store.projects = { alpha: project('alpha') };
    store.sessions = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, session(`s${i}`, { lastActivityAt: 1_000_000 - i })]));
    const at = (page: number) => presentSessionList({ ...initialState(), search: { text: '', filter: { projectId: 'alpha' }, page }, pageSize: 25 }, store, NOW);
    expect(at(1)).toMatchObject({ total: 60, pager: { page: 1, pageCount: 3, size: 25, from: 1, to: 25 } });
    expect(at(1).rows.map((r) => r.id).slice(0, 2)).toEqual(['s0', 's1']);
    expect(at(3).rows.map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `s${50 + i}`));
    expect(at(3).pager).toMatchObject({ from: 51, to: 60 });
    // 件数を減らしたあとなどで後ろの端を越えたら、最後のページに丸める。
    expect(at(9).pager).toMatchObject({ page: 3, from: 51, to: 60 });
  });
  it('いちばん小さい件数（25）以下しか無ければ、ページ送りを出さない', () => {
    const r = presentSessionList({ ...initialState(), search: { text: '', filter: { projectId: 'alpha' }, page: 1 } }, storeWith(), NOW);
    expect(r.pager).toBeNull();
  });
  // 状態がどれも同じタブ（Done・Paused・Archived）は、行の状態の列を畳む。見出し（タブ）が言っているから。Active のタブは sessionsTabs.test.ts で見る。
  it('状態がどれも同じタブでは、状態の列を畳む', () => {
    const tab = (status: 'done' | 'paused' | 'archived' | 'proposed' | undefined) => presentSessionList({ ...initialState(), search: { text: '', filter: { status }, page: 1 } }, storeWith(), NOW).statusColumn;
    expect([tab('done'), tab('paused'), tab('archived')]).toEqual([false, false, false]);
    expect([tab('proposed'), tab(undefined)]).toEqual([true, true]);
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
    const ids = (days: number | undefined) => presentSessionList({ ...initialState(), search: { text: '', filter: { days } , page: 1 } }, store, now).rows.map((r) => r.id);
    expect(ids(1)).toEqual(['today']);
    expect(ids(7)).toEqual(['today', 'yesterday', 'week']);
    expect(ids(undefined)).toHaveLength(3);
  });
  it('状態の絞り込みは、実行中（作業中、休み、起動中）、入力待ち、終了に分ける', () => {
    const store = storeWith();
    store.sessions.w1 = session('w1', { live: 'waiting' });
    store.runs = { r2: runDto('r2', 's2') };
    const ids = (live: SearchFilter['live']) => presentSessionList({ ...initialState(), search: { text: '', filter: { live } , page: 1 } }, store, NOW).rows.map((r) => r.id).sort();
    expect(ids('running')).toEqual(['s1', 's2']);
    expect(ids('waiting')).toEqual(['w1']);
    expect(ids('ended')).toEqual(['s3']);
    expect(ids(undefined)).toEqual(['s1', 's2', 's3', 'w1']);
  });
  // 見出しの件数は条件に関わらずセッションの全件で、条件の行が絞った結果の件数を言う（D1）。
  it('見出しには全件の数、条件の行にはいま効いている条件を並べる', () => {
    const store = storeWith();
    const none = presentSessionList(initialState(), store, NOW);
    expect(none).toMatchObject({ allCount: 3, conditions: [] });
    const state = { ...initialState(), screen: { name: 'home' as const, q: '索引' }, search: { text: '索引', filter: { projectId: 'alpha', days: 7, live: 'waiting' as const, file: 'src/a.ts' } , page: 1 } };
    const r = presentSessionList(state, { ...store, search: { params: { q: '索引' }, result: { hits: [], total: 0 }, loading: false } }, NOW);
    expect(r.allCount).toBe(3);
    expect(r.conditions).toEqual(['『索引』', '入力待ち', '7 日', 'alpha', 'src/a.ts']);
    // 見出しの件数は「すべて」のタブと同じ値で、Archived を除く。
    const archived = session('s9', { state: { status: 'archived', note: null, returnOn: null, returnTime: null, setBy: 'import', setAt: 1, candidate: null } });
    const withArchived = presentSessionList(initialState(), { ...store, sessions: { ...store.sessions, s9: archived } }, NOW);
    expect(withArchived.allCount).toBe(3);
    expect(withArchived.tabs.find((t) => t.tab === 'all')!.count).toBe('3');
    const today = presentSessionList({ ...initialState(), search: { text: '', filter: { days: 1, live: 'running' } , page: 1 } }, store, NOW);
    expect(today.conditions).toEqual(['実行中', '今日']);
  });
  it('キーワードが無くても、触ったファイルで絞るときはサーバの結果を並べる', () => {
    let store = storeWith();
    store = { ...store, search: { params: { q: '', file: 'a.md' }, result: { hits: [{ sessionId: 's2', matchCount: 3, snippets: [] }], total: 1 }, loading: false } };
    const state = { ...initialState(), screen: { name: 'home' as const }, search: { text: '', filter: { file: 'a.md' } , page: 1 } };
    const r = presentSessionList(state, store, NOW);
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
    expect(presentSessionList(initialState(), store, NOW).rows.map((r) => r.id)).toEqual(['waitNew', 'waitOld', 'busyNew', 'busyOld', 'idleNew', 'endedNew', 'endedOld']);
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

describe('presentSession（見出しの操作、A1）', () => {
  const ids = (a: { menu: { id: string }[] }) => a.menu.map((m) => m.id);
  it('実行中は VS Code で開くを主にし、残りは「…」へ。停止は危険色で最後、フォークは理由を添えて押せない', () => {
    const store = storeWith();
    store.runs = { r1: runDto('r1', 's1') };
    store.tabs = { r1: tabDto('r1', 'r1', 'agent') };
    const a = presentSession(initialState(), store, NOW, 's1').actions;
    expect(a.primary).toMatchObject({ id: 'openEditor', label: 'VS Code で開く', disabled: null });
    expect(ids(a)).toEqual(['openTerminal', 'fork', 'regenerate', 'stop']);
    expect(a.menu.find((m) => m.id === 'fork')!.disabled).toBe('実行中は押せません。止めると押せます');
    expect(a.menu.at(-1)).toMatchObject({ id: 'stop', label: '停止', danger: true, disabled: null });
  });
  it('終わったセッションは再開を主にし、フォーク、VS Code で開く、要約を作り直すを「…」へ', () => {
    const store = storeWith();
    store.sessions.s2 = { ...store.sessions.s2!, live: null };
    const a = presentSession(initialState(), store, NOW, 's2').actions;
    expect(a.primary).toMatchObject({ id: 'resume', label: '再開', disabled: null });
    expect(ids(a)).toEqual(['fork', 'openEditor', 'regenerate']);
    expect(a.menu[0]).toMatchObject({ disabled: null, note: 'この会話から枝分かれした新しいセッション' });
    // 本文が無ければ、再開もフォークも理由を添えて押せない。
    store.sessions.s2 = { ...store.sessions.s2!, hasTranscript: false };
    const b = presentSession(initialState(), store, NOW, 's2').actions;
    expect(b.primary).toMatchObject({ id: 'resume', disabled: '本文がありません' });
    expect(b.menu[0]!.disabled).toBe('本文がありません');
  });
  it('他の PC で実行中は「この PC で再開」を主にし、再開とフォークはロックの理由で押せない', () => {
    const store = storeWith();
    const lock = { deviceId: 'd2', deviceName: 'MacBook-Air', runId: 'r9', heartbeatAt: NOW - 20_000, stale: false };
    store.sessions.s2 = { ...store.sessions.s2!, live: null, lock, remoteOnly: true };
    const a = presentSession(initialState(), store, NOW, 's2').actions;
    // 生きているロックは横取りさせない（Ruling 14）。
    // 主の操作は出すが、理由を添えて押せなくする。
    expect(a.primary).toMatchObject({ id: 'resumeHere', label: 'この PC で再開', disabled: 'MacBook-Air で実行中です。止まるか応答が無くなると選べます' });
    expect(ids(a)).toEqual(['resume', 'fork', 'openEditor', 'regenerate']);
    expect(a.menu[0]!.disabled).toBe('MacBook-Air で実行中です');
    expect(a.menu[1]!.disabled).toBe('MacBook-Air で実行中です');
    store.sessions.s2 = { ...store.sessions.s2!, lock: { ...lock, stale: true } };
    const b = presentSession(initialState(), store, NOW, 's2').actions;
    expect(b.primary).toMatchObject({ id: 'resumeHere', disabled: null });
    expect(b.menu[0]!.disabled).toBe('MacBook-Air から応答がありません。「この PC で再開」で続けられます');
    // ロックが無く本文だけが他の PC にあるとき。
    store.sessions.s2 = { ...store.sessions.s2!, lock: null, remoteOnly: true };
    const c = presentSession(initialState(), store, NOW, 's2').actions;
    expect(c.primary).toMatchObject({ id: 'resumeHere', disabled: null });
    expect(c.menu[0]!.disabled).toBe('本文が他の PC にあります。「この PC で再開」で本文を降ろして続けられます');
    expect(c.menu[1]!.disabled).toBe('本文が他の PC にあります');
  });
  it('hangar の外で動いているときは、つなぐか引き取るを「…」に入れる', () => {
    const facts: Parameters<typeof sessionActions>[0] = { run: null, live: 'busy', lock: null, remoteOnly: false, hasTranscript: true, canResume: false, canFork: false, canResumeHere: false, outsideOpen: 'attach', canPromote: false, gone: null, summaryPending: false, summaryError: null, fromScratch: false };
    const a = sessionActions(facts);
    expect(a.primary.id).toBe('openEditor');
    expect(ids(a)).toEqual(['attach', 'fork', 'regenerate']);
    expect(ids(sessionActions({ ...facts, outsideOpen: 'adopt' }))[0]).toBe('adopt');
  });
  it('昇格はメニューに入れ、要約の作成中と失敗は作り直すに 1 行添え、本文が消えた会話では作り直しを出さない', () => {
    const facts: Parameters<typeof sessionActions>[0] = { run: null, live: null, lock: null, remoteOnly: false, hasTranscript: true, canResume: true, canFork: true, canResumeHere: false, outsideOpen: null, canPromote: true, gone: null, summaryPending: true, summaryError: null, fromScratch: true };
    const a = sessionActions(facts);
    expect(ids(a)).toEqual(['fork', 'openEditor', 'regenerate', 'promote']);
    expect(a.menu[2]!.note).toBe('作成しています');
    // スクラッチで始めたセッションの再開は、作業ディレクトリがスクラッチのままであることを添える。
    expect(a.primary.note).toBe('再開しても作業ディレクトリはスクラッチのままです');
    expect(sessionActions({ ...facts, summaryPending: false, summaryError: 'x' }).menu[2]!.note).toBe('前回は作成できませんでした');
    expect(ids(sessionActions({ ...facts, gone: { note: '', canExtend: false, extendTo: 365 } }))).not.toContain('regenerate');
  });
});

describe('presentSession（冒頭の 1 枚の変更したファイル）', () => {
  const call = (seq: number, name: string, input: Record<string, unknown>): TranscriptEvent => ({ kind: 'tool_call', seq, toolId: `t${seq}`, name, input, summary: name });
  const result = (seq: number, text: string): TranscriptEvent => ({ kind: 'tool_result', seq, toolId: `t${seq - 1}`, text, isError: false });
  it('サーバの一覧が届く前は、読み込んだ本文から、最初に触った順に、足した行と消した行の数と、新しいファイルかを添えて並べる', () => {
    let store = storeWith();
    store.sessions.s2 = { ...store.sessions.s2!, live: null, stats: { ...store.sessions.s2!.stats, filesChanged: 4 } };
    const events: TranscriptEvent[] = [
      { kind: 'user', seq: 0, text: 'go' },
      call(1, 'Edit', { file_path: '/w/alpha/src/a.ts', old_string: 'x', new_string: 'y\nz' }),
      call(2, 'Write', { file_path: '/w/alpha/src/new.ts', content: 'a\nb\nc' }), result(3, 'File created successfully at: /w/alpha/src/new.ts'),
      call(4, 'Read', { file_path: '/w/alpha/src/b.ts' }),
      call(5, 'Edit', { file_path: '/w/alpha/src/a.ts', old_string: 'q', new_string: '' }),
      call(6, 'MultiEdit', { file_path: '/elsewhere/c.md', edits: [{ old_string: 'a', new_string: 'b' }] }),
    ];
    store = applyEventsPage(store, eventsKey('s2', null), { sessionId: 's2', events, total: events.length, nextSeq: null }, false);
    const files = presentSession(initialState(), store, NOW, 's2').lead!.files;
    expect(files.rows.map((r) => ({ path: r.path, dir: r.dir, base: r.base, added: r.added, removed: r.removed, created: r.created }))).toEqual([
      { path: '/w/alpha/src/a.ts', dir: 'src/', base: 'a.ts', added: 2, removed: 2, created: false },
      { path: '/w/alpha/src/new.ts', dir: 'src/', base: 'new.ts', added: 3, removed: 0, created: true },
      { path: '/elsewhere/c.md', dir: '/elsewhere/', base: 'c.md', added: 1, removed: 1, created: false },
    ]);
    // 統計にはもう 1 つある（サブエージェントの編集も数に入る）。件数は統計の数を使う。
    expect(files.count).toBe(4);
  });
  it('サブエージェントを見ていて主線をまだ読んでいなければ、読み込んだ本文からは出さない', () => {
    const store = storeWith();
    store.sessions.s2 = { ...store.sessions.s2!, live: null, stats: { ...store.sessions.s2!.stats, filesChanged: 3 } };
    const agent = { ...initialState(), sessionView: { s2: { ...defaultSessionView(), agentId: 'ag1' } } };
    const q = presentSession(agent, store, NOW, 's2').lead!.files;
    expect(q.rows).toEqual([]);
    expect(q.count).toBe(3);
  });
});

describe('presentSession（transcript を表示中の帯、F1）', () => {
  it('目次から生きている run の Claude を transcript に入れたと確かめられた間だけ、そのターンの時刻を出す', () => {
    let store = storeWith();
    store.runs = { r1: runDto('r1', 's1') };
    store.tabs = { r1: tabDto('r1', 'r1', 'agent') };
    const events: TranscriptEvent[] = [{ kind: 'user', seq: 0, text: 'a', ts: Date.parse('2026-09-02T03:09:41Z') }, { kind: 'user', seq: 1, text: 'b' }];
    store = applyEventsPage(store, eventsKey('s1', null), { sessionId: 's1', events, total: 2, nextSeq: null }, false);
    const at = (turnJump: State['sessionView'][string]['turnJump'], openTurn: number | null = 0) => presentSession({ ...initialState(), sessionView: { s1: { ...defaultSessionView(), openTurn, turnJump } } }, store, NOW, 's1').transcriptBand;
    expect(at(null)).toBeNull();
    expect(at({ seq: 0, status: 'found', runId: 'r1' })).toEqual({ when: absoluteTime(Date.parse('2026-09-02T03:09:41Z')).slice(11, 16) });
    // 着けなかったときも、サーバは transcript を開いたままにする。
    expect(at({ seq: 0, status: 'notFound', runId: 'r1' })).not.toBeNull();
    // 答えを待つ間は、まだ transcript に入ったか分からない。
    expect(at({ seq: 0, status: 'pending', runId: 'r1' })).toBeNull();
    // transcript に入れなかったときと、跳ぶ API が失敗したときは、帯を出さない（目次の側で言う）。
    expect(at({ seq: 0, status: 'mode', runId: 'r1' })).toBeNull();
    expect(at({ seq: 0, status: 'failed', runId: 'r1' })).toBeNull();
    // 前の run を跳ばしたまま、その run が終わったとき。
    expect(at({ seq: 0, status: 'found', runId: 'r0' })).toBeNull();
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
    expect(newSessionTarget(at({ name: 'home' }), store)).toEqual({});
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

describe('presentSession（現在の帯の状態）', () => {
  // 最新の側から読んだ窓（seq 700 から）。今のターンの頭は窓より新しい 705 で、会話全体は 900 件ある。
  const user = (seq: number): TranscriptEvent => ({ kind: 'user', seq, text: `指示 ${seq}` });
  const callAt = (seq: number): TranscriptEvent => ({ kind: 'tool_call', seq, toolId: `t${seq}`, name: 'Read', input: { file_path: '/w/a.ts' }, summary: 'Read' });
  const window = [user(700), ...[701, 702, 703, 704, 705, 706, 707, 708, 709, 710].map(callAt)];
  const live = (total: number, turns: number, turnStartSeq: number | null): Store => {
    let store = storeWith();
    store.runs = { r1: runDto('r1', 's1') };
    store.sessions.s1 = { ...store.sessions.s1!, stats: { ...store.sessions.s1!.stats, turns } };
    store = applyEventsPage(store, eventsKey('s1', null), { sessionId: 's1', events: window, total, nextSeq: null }, false);
    store.liveDigests = { s1: { sessionId: 's1', turnStartSeq, intent: null, agents: [] } };
    return store;
  };
  it('全部を読み込んでいなければ、ターンの番号は統計から、頭は digest の turnStartSeq から取る', () => {
    const p = presentSession(initialState(), live(900, 7, 705), NOW, 's1');
    expect(p.turnsComplete).toBe(false);
    // 窓の最初の指示（700）からではなく 705 から数えるので 6 手、ターンは窓の 1 ではなく統計の 7。
    expect(p.strip).toMatchObject({ tone: 'busy', state: '作業中', sub: 'ターン 7、ツール呼び出し 6 回目' });
  });
  it('全部を読み込んでいれば、ターンの番号は目次の数', () => {
    const p = presentSession(initialState(), live(11, 7, 705), NOW, 's1');
    expect(p.turnsComplete).toBe(true);
    expect(p.strip!.sub).toBe('ターン 1、ツール呼び出し 6 回目');
  });
  it('統計も無く全部も読めていなければ、ターンの番号は出さず手の数だけ', () => {
    const p = presentSession(initialState(), live(900, 0, 705), NOW, 's1');
    expect(p.strip).toMatchObject({ tone: 'busy', state: '作業中', sub: 'ツール呼び出し 6 回目' });
  });
  it('digest がまだ無ければ、窓の最後のターンの頭から数える', () => {
    const store = live(900, 7, 705);
    store.liveDigests = {};
    expect(presentSession(initialState(), store, NOW, 's1').strip!.sub).toBe('ターン 7、ツール呼び出し 10 回目');
  });
});

/** path をパスに持つ解決済みのプロジェクトを 1 つだけ入れた store。 */
function storeWithProjectAt(path: string): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { p1: { ...project('p1'), path } };
  return s;
}
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
  it('書きかけの下書きと、プロジェクトごとの前回値を渡す', () => {
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false }, newSessionDraft: { name: 'n', prompt: '', attachments: [] }, launchPrefs: { alpha: { model: 'opus' } } };
    expect(presentNewSession(state, storeWith(), NOW)).toMatchObject({ draft: { name: 'n', prompt: '' }, prefs: { alpha: { model: 'opus' } } });
  });
  it('未登録のフォルダから、store にあるプロジェクトのパスを除く', () => {
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false } };
    const store = { ...storeWithProjectAt('/w/alpha'), workspaceDirs: [{ name: 'alpha', path: '/w/alpha' }, { name: 'fresh', path: '/w/fresh' }], pickedFolder: { path: '/w/fresh', n: 2 } };
    const props = presentNewSession(state, store, NOW)!;
    expect(props.dirs).toEqual([{ name: 'fresh', path: '/w/fresh' }]);
    expect(props.picked).toEqual({ path: '/w/fresh', n: 2 });
    // 一覧をまだ取っていない間は空で、選んだフォルダも無い。
    expect(presentNewSession(state, storeWithProjectAt('/w/alpha'), NOW)).toMatchObject({ dirs: [], picked: null });
  });
  it('作れない名前として、アーカイブも含む store のプロジェクトのフォルダ名を小文字で渡す', () => {
    const store = storeWithProjectAt('/w/Old-Kadai');
    store.projects.p1 = { ...store.projects.p1!, status: 'archived' };
    store.projects.p2 = { ...project('p2'), path: null, resolved: false };
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false } };
    expect(presentNewSession(state, store, NOW)!.takenNames).toEqual(['old-kadai']);
  });
  it('作れた後に起動だけ失敗したら、作ったプロジェクトを渡す', () => {
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false }, launch: { kind: 'failed' as const, message: 'x', createdProjectId: 'p9' } };
    expect(presentNewSession(state, storeWithProjectAt('/w/alpha'), NOW)!.createdProjectId).toBe('p9');
  });
  describe('アカウントの札', () => {
    const open = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false } };
    it('アカウントが 0 件でも 1 件でも null にする（段を出さない）', () => {
      expect(presentNewSession(open, storeWith(), NOW)!.accounts).toBeNull();
      const one = { ...accountsFixture, accounts: [accountsFixture.accounts[0]!] };
      expect(presentNewSession(open, { ...storeWith(), accounts: one }, NOW)!.accounts).toBeNull();
    });
    it('2 件以上なら、一覧といまのアカウントの id を渡す', () => {
      const p = presentNewSession(open, { ...storeWith(), accounts: accountsFixture }, NOW)!;
      expect(p.accounts!.currentId).toBe('primary');
      expect(p.accounts!.list.map((a) => [a.id, a.name, a.current])).toEqual([['primary', '会社', true], ['a1', '大学', false]]);
      expect(presentNewSession(open, { ...storeWith(), accounts: { ...accountsFixture, currentId: 'a1' } }, NOW)!.accounts!.currentId).toBe('a1');
    });
    it('currentId が一覧に無ければ、最初のアカウントがいまのアカウントになる', () => {
      expect(presentNewSession(open, { ...storeWith(), accounts: { ...accountsFixture, currentId: 'gone' } }, NOW)!.accounts!.currentId).toBe('primary');
    });
  });
});

describe('presentSettings（フェーズ 2）', () => {
  it('ツールのパスと MCP のコマンド', () => {
    const store = storeWith();
    store.settings = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'iterm', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null };
    // コマンドは hangar の呼び方にそろえる。準備の確かめが届く前は hangar と書く。
    expect(presentSettings(initialState(), store)).toMatchObject({ tmuxPath: '/opt/homebrew/bin/tmux', terminalApp: 'iterm', codePath: null, commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install' } });
    store.settings = null;
    expect(presentSettings(initialState(), store)).toMatchObject({ tmuxPath: null, terminalApp: 'terminal', codePath: null });
  });
});

describe('presentSettings の検証と保存の知らせ（設定の B1 と C1）', () => {
  const READY: ReadinessDto = {
    tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: null, ok: false, problem: 'unset', version: null }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
    workspace: { path: '/w', exists: true, projectCount: 12 }, mcp: { registered: true, file: '/h/.claude.json' }, statusline: { command: null, scriptPath: null, installed: false },
    commands: { mcp: '/A/hangar mcp install', statusline: '/A/hangar statusline install', shell: '/A/hangar shell install' },
    compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
  };
  it('準備の確かめが届く前は、欄の下を空にしておく', () => {
    const p = presentSettings(initialState(), initialStore());
    expect(p.verify).toEqual({ workspace: null, tmux: null, claude: null, code: null, node: null });
    expect(p.mcpRegistered).toBeNull();
    expect(p.todo).toEqual({ must: 0, link: 0 });
  });
  it('届いたら、欄ごとの検証と、MCP の登録と、コマンドの呼び方を渡す', () => {
    const p = presentSettings(initialState(), { ...initialStore(), readiness: READY });
    expect(p.verify.tmux).toMatchObject({ ok: true, text: '/opt/homebrew/bin/tmux', note: '3.4' });
    expect(p.verify.workspace).toMatchObject({ ok: true, note: 'プロジェクト 12 件' });
    expect(p.verify.claude).toMatchObject({ ok: false });
    expect(p.mcpRegistered).toBe(true);
    expect(p.commands).toEqual({ mcp: '/A/hangar mcp install', statusline: '/A/hangar statusline install' });
    // 直すものの数は、無くても動くもの（code）を数えない。連携は MCP と statusline を数える。
    expect(p.todo).toEqual({ must: 1, link: 1 });
  });
  it('Claude Code との互換は、準備の確かめの要約とずれの中身から作り、ずれは直すものに数えない', () => {
    const r: ReadinessDto = { ...READY, compat: { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 1 } };
    const full = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'registry' as const, value: 'status=compacting', version: '2.1.300', count: 1, firstSeenAt: 1, lastSeenAt: 2 }] };
    const p = presentSettings(initialState(), { ...initialStore(), version: '0.3.0', readiness: r, compat: full });
    expect(p.compat).toMatchObject({ state: 'drift', badge: 'ずれ 1 件', localVersion: '2.1.300', verifiedVersion: '2.1.292', stops: ['休んでいるセッションを自動で止めるのを控えています'] });
    expect(p.compat!.report!.split('\n')[0]).toBe('Claude Code との互換のずれ（hangar 0.3.0）');
    // 直すもの（目次の点と群の見出しの札）は、ずれの無いときと同じ数のまま。
    expect(p.todo).toEqual(presentSettings(initialState(), { ...initialStore(), readiness: READY }).todo);
    expect(p.todo).toEqual({ must: 1, link: 1 });
  });
  it('準備の確かめが届く前と、compat の無い古いサーバの答えでは、互換の節を null にする', () => {
    expect(presentSettings(initialState(), initialStore()).compat).toBeNull();
    const { compat: _drop, ...older } = READY;
    expect(presentSettings(initialState(), { ...initialStore(), readiness: older as ReadinessDto }).compat).toBeNull();
    expect(presentSettings(initialState(), { ...initialStore(), readiness: READY }).compat).toMatchObject({ state: 'ok', badge: '問題なし' });
  });
  it('欄ごとの保存の知らせをそのまま渡す', () => {
    const p = presentSettings({ ...initialState(), settingsSave: { tmuxPath: { kind: 'saved', n: 2 } } }, initialStore());
    expect(p.save).toEqual({ tmuxPath: { kind: 'saved', n: 2 } });
  });
  it('参加トークンが消える時刻を渡す', () => {
    const p = presentSettings(initialState(), { ...initialStore(), joinToken: 'tok', joinTokenExpiresAt: NOW + 30_000 }, NOW);
    expect(p.cloud).toMatchObject({ joinToken: 'tok', joinTokenExpiresAt: NOW + 30_000 });
  });
  describe('アカウントの節', () => {
    it('アカウントが 1 件でもその一覧を渡し、選べる 5 色を添える', () => {
      const one = { ...accountsFixture, accounts: accountsFixture.accounts.slice(0, 1) };
      const p = presentSettings(initialState(), { ...initialStore(), accounts: one }, NOW);
      expect(p.accounts.list.map((a) => [a.id, a.name, a.current, a.primary])).toEqual([['primary', '会社', true, true]]);
      expect(p.accounts.colors).toEqual(['#2a57b8', '#7a4a9e', '#2b7048', '#c77a1a', '#a2452f']);
    });
    it('2 件なら 2 件とも、いまのアカウントに印を付けて渡す', () => {
      const p = presentSettings(initialState(), { ...initialStore(), accounts: accountsFixture }, NOW);
      expect(p.accounts.list.map((a) => [a.id, a.current])).toEqual([['primary', true], ['a1', false]]);
    });
    it('まだ届いていなければ一覧は空', () => {
      expect(presentSettings(initialState(), initialStore(), NOW).accounts.list).toEqual([]);
    });
    it('アカウントの位置へ移る印は、設定の画面が at=accounts で開かれたときだけ accounts になる', () => {
      const at = (screen: State['screen']) => presentSettings({ ...initialState(), screen }, initialStore(), NOW).focus;
      expect(at({ name: 'settings', at: 'accounts' })).toBe('accounts');
      // ヘッダーの同期の語から来たときは、クラウド同期の節が開く（位置の印は立たない）。
      expect(at({ name: 'settings', at: 'sync' })).toBeNull();
      expect(at({ name: 'settings' })).toBeNull();
      expect(at({ name: 'home' })).toBeNull();
    });
  });
});

describe('homePath', () => {
  it('ホームの下を ~ で始まる形に縮める（macOS と Linux）', () => {
    expect(homePath('/Users/taro/.claude-univ')).toBe('~/.claude-univ');
    expect(homePath('/home/taro/.claude')).toBe('~/.claude');
    expect(homePath('/Users/taro/work/a b')).toBe('~/work/a b');
  });
  it('ホームそのものは ~ にする', () => {
    expect(homePath('/Users/taro')).toBe('~');
    expect(homePath('/Users/taro/')).toBe('~');
  });
  it('ホームの下でなければそのまま返す', () => {
    expect(homePath('/h/.claude')).toBe('/h/.claude');
    expect(homePath('/Users')).toBe('/Users');
    expect(homePath('/srv/Users/taro/x')).toBe('/srv/Users/taro/x');
    expect(homePath('/homework/x')).toBe('/homework/x');
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
    expect(presentShell(s, initialStore(), NOW).conn).toEqual({ visible: false, staleLabel: '', retryLabel: '', hard: false, desktop: false });
  });
  it('切れている間は、止まった時刻と次に試すまでの秒を出す', () => {
    const s = { ...initialState(), connection: 'disconnected' as const, staleSince: NOW - 120_000, nextRetryAt: NOW + 7_500 };
    expect(presentShell(s, initialStore(), NOW).conn).toEqual({ visible: true, staleLabel: '画面は 2 分前のまま止まっています', retryLabel: '8 秒後に再接続します', hard: false, desktop: false });
  });
  it('切れた直後は、時刻を言わずに止まったとだけ言う', () => {
    const s = { ...initialState(), connection: 'disconnected' as const, staleSince: NOW - 30_000, nextRetryAt: NOW + 2_000 };
    expect(presentShell(s, initialStore(), NOW).conn.staleLabel).toBe('画面の更新が止まっています');
  });
  it('再接続が 3 回続けて失敗したら、同じ帯を強い形に切り替える（初回と障害の B1）', () => {
    // 最初の切断で 1、再接続の失敗ごとに 1 ずつ増える。3 回の失敗は 4 である。
    const at = (reconnectAttempt: number) => ({ ...initialState(), connection: 'disconnected' as const, staleSince: NOW, nextRetryAt: NOW + 1000, reconnectAttempt });
    expect(presentShell(at(3), initialStore(), NOW).conn.hard).toBe(false);
    expect(presentShell(at(4), initialStore(), NOW).conn.hard).toBe(true);
    // 殻の中なら、ログを開くと再起動を殻に頼める。
    expect(presentShell(at(4), { ...initialStore(), desktop: true }, NOW).conn.desktop).toBe(true);
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
  const solo = (usage: UsageDto): Store => ({ ...initialStore(), accounts: { currentId: 'primary', accounts: [{ ...accountsFixture.accounts[0]!, usage }], sessions: {} } });
  it('値が無ければ null、あれば最初のアカウントの百分率と最終更新', () => {
    const empty = presentShell(initialState(), initialStore(), NOW);
    expect(empty.usage).toEqual({ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null });
    const p = presentShell(initialState(), solo({ fiveHour: { usedPercent: 47, resetsAt: null }, sevenDay: { usedPercent: 7, resetsAt: null }, updatedAt: NOW - 600_000 }), NOW);
    expect(p.usage).toEqual({ fiveHour: 47, sevenDay: 7, fiveHourResets: null, sevenDayResets: null, updatedLabel: '10 分前' });
  });
});

describe('presentShell のアカウント', () => {
  const two = (): Store => ({ ...storeWith(), accounts: accountsFixture });
  const at = (screen: State['screen']): State => ({ ...initialState(), screen });
  it('アカウントが 1 件なら account は null で、計器はそのアカウントの値から作る。store.accounts が null なら計器も空', () => {
    const u = { fiveHour: { usedPercent: 47, resetsAt: null }, sevenDay: { usedPercent: 7, resetsAt: null }, updatedAt: NOW - 600_000 };
    const solo = presentShell(initialState(), { ...storeWith(), accounts: { ...accountsFixture, accounts: [{ ...accountsFixture.accounts[0]!, usage: u }] } }, NOW);
    expect(solo.account).toBeNull();
    expect(solo.usage).toEqual({ fiveHour: 47, sevenDay: 7, fiveHourResets: null, sevenDayResets: null, updatedLabel: '10 分前' });
    const none = presentShell(initialState(), storeWith(), NOW);
    expect(none.account).toBeNull();
    expect(none.usage).toEqual({ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null });
    const empty = presentShell(at({ name: 'session', id: 's1' }), { ...storeWith(), accounts: { currentId: '', accounts: [], sessions: {} } }, NOW);
    expect(empty.account).toBeNull();
    expect(empty.usage).toEqual(none.usage);
  });
  it('2 件・ホームでは、いまのアカウントを出し、計器もその値で作る（sessionId は null）', () => {
    const p = presentShell(initialState(), two(), NOW);
    expect(p.account?.shown.id).toBe('primary');
    expect(p.account?.shown.name).toBe('会社');
    expect(p.account?.sessionId).toBeNull();
    expect(p.account?.working).toBe(false);
    expect(p.account?.list.map((a) => a.id)).toEqual(['primary', 'a1']);
    expect(p.account?.list.map((a) => a.current)).toEqual([true, false]);
    expect(p.usage).toEqual({ fiveHour: 82, sevenDay: 41, fiveHourResets: resetsLabel(FIVE_RESETS, NOW), sevenDayResets: resetsLabel(SEVEN_RESETS, NOW), updatedLabel: relativeTime(500, NOW) });
  });
  it('いまのアカウントが大学なら、ホームでも大学を出す', () => {
    const p = presentShell(initialState(), { ...two(), accounts: { ...accountsFixture, currentId: 'a1' } }, NOW);
    expect(p.account?.shown.id).toBe('a1');
    expect(p.usage.fiveHour).toBe(12);
  });
  it('2 件・セッション画面では、そのセッションのアカウントを出し、計器もその値で作る', () => {
    const store = two();
    store.sessions = { ...store.sessions, s9: session('s9', { live: 'busy' }) };
    const p = presentShell(at({ name: 'session', id: 's9' }), store, NOW);
    expect(p.account?.shown.id).toBe('a1');
    expect(p.account?.shown.name).toBe('大学');
    expect(p.account?.sessionId).toBe('s9');
    expect(p.usage).toMatchObject({ fiveHour: 12, sevenDay: 9 });
    // 並びと current は、画面に関わらず、いまのアカウント（会社）のまま。
    expect(p.account?.list.map((a) => [a.id, a.current])).toEqual([['primary', true], ['a1', false]]);
  });
  it('2 件・セッション画面で対応に無いセッションは、最初のアカウントを出す', () => {
    const p = presentShell(at({ name: 'session', id: 's1' }), { ...two(), accounts: { ...accountsFixture, currentId: 'a1' } }, NOW);
    expect(p.account?.shown.id).toBe('primary');
    expect(p.account?.sessionId).toBe('s1');
    expect(p.usage.fiveHour).toBe(82);
  });
  it('working は、そのセッションが作業中（busy か waiting）のときだけ真になる', () => {
    const store = two();
    const w = (live: SessionDto['live'] | 'missing', state: State = at({ name: 'session', id: 's9' })) => {
      const sessions = live === 'missing' ? { ...store.sessions } : { ...store.sessions, s9: session('s9', { live }) };
      return presentShell(state, { ...store, sessions }, NOW).account?.working;
    };
    expect(w('busy')).toBe(true);
    expect(w('waiting')).toBe(true);
    expect(w('idle')).toBe(false);
    expect(w(null)).toBe(false);
    expect(w('missing')).toBe(false);
    // ホームでは、動いているセッションがあっても関係しない。
    expect(w('busy', at({ name: 'home' }))).toBe(false);
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

describe('presentHome（スクラッチ）', () => {
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
      summaryFailed: { s1: 'LM Studio に繋がりません' },
    };
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.lead!.cost).toBe('$0.50');
    expect(p.lead!.artifacts.items.map((a) => a.id)).toEqual(['a1']);
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
    expect(p).toMatchObject({ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5, summarizerModels: ['gemma', 'qwen'] });
    expect(p.commands.statusline).toBe('hangar statusline install');
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
    expect(presentSessionList(initialState(), store, NOW).rows[0]).toMatchObject({ id: 's1', cost: '$3.00', runId: 'r1' });
    expect(presentProject(initialState(), store, NOW, 'alpha').list.rows[0]).toMatchObject({ id: 's1', cost: '$3.00', runId: 'r1' });
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
    expect(p.lead!.cost).toBeNull();
    // 別のセッションのアーティファクトは出さない。
    expect(p.lead!.artifacts.items.map((a) => a.id)).toEqual(['a1']);
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
const syncStatus = (over: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', url: 'https://h', lastPushAt: NOW - 1000, lastPullAt: NOW - 60_000, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false }, limitedUntil: null, paused: false, skipped: [], sweepPending: null, oncePass: false, ...over });
const lockDto = (over: Partial<SessionLockDto> = {}): SessionLockDto => ({ deviceId: 'dev-b', deviceName: 'mini', runId: 'r1', heartbeatAt: NOW - 60_000, stale: false, ...over });

describe('ヘッダーの無料枠で停止', () => {
  const at = (iso: string) => Date.parse(iso);
  const RESET = at('2026-10-03T00:00:00Z');
  // 実際のエンジンは、上限で退いている間は一時停止の印を立てない（limitedUntil は一時停止していないときだけ出る）。
  const paused = (o: Partial<SyncStatusBody>): SyncStatusBody => syncStatus({ state: 'paused', paused: o.limitedUntil == null, ...o });
  // ヘッダーの同期の一行は、Store の sync だけから決まる。
  const shellSync = (sync: SyncStatusBody, now: number, tz?: string) => presentShell(initialState(), { ...initialStore(), sync }, now, tz).sync;

  it('上限で退いている間は、戻る時刻を端末の時刻で言い、利用者が止めたことにはしない', () => {
    const p = shellSync(paused({ limitedUntil: RESET }), at('2026-10-02T06:48:00Z'), 'Asia/Tokyo');
    expect(p).toMatchObject({ label: '無料枠で停止 · 9:00 にリセット', reason: 'quota', state: 'paused' });
    expect(p).not.toHaveProperty('quotaBack');
  });
  it('時差に依らない（ニューヨークでも同じ境目）', () => {
    expect(shellSync(paused({ limitedUntil: RESET }), at('2026-10-02T23:59:00Z'), 'America/New_York').label).toBe('無料枠で停止 · 20:00 にリセット');
  });
  it('一時停止のまま 1 回だけ同期している最中は、そのことを言う', () => {
    expect(shellSync(paused({ oncePass: true }), at('2026-10-02T06:48:00Z'))).toMatchObject({ label: '1 回だけ同期中…', once: true });
    // 終われば元の文に戻る。
    expect(shellSync(paused({ oncePass: false }), at('2026-10-02T06:48:00Z'))).toMatchObject({ label: '同期を一時停止中', once: false });
    // 設定の「状態」も同じ語で言う。
    const settings = presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync: paused({ oncePass: true }) }).cloud;
    expect(settings).toMatchObject({ stateLabel: '1 回だけ同期中…', once: true, paused: true });
  });
  it('手で止めたときは今までどおり', () => {
    expect(shellSync(paused({}), at('2026-10-02T06:48:00Z'), 'Asia/Tokyo')).toMatchObject({ label: '同期を一時停止中', reason: 'user' });
  });
  it('止まっていなければ理由は null で、文も変わらない', () => {
    expect(shellSync(syncStatus({}), NOW, 'Asia/Tokyo')).toMatchObject({ reason: null, label: '同期 1 分前' });
  });
  it('エラーのときも理由は null', () => {
    expect(shellSync(syncStatus({ state: 'error', error: '切れました' }), NOW, 'Asia/Tokyo')).toMatchObject({ reason: null, label: '同期エラー: 切れました' });
  });
  it('設定の状態も同じ語で言い、利用者が止めたことにはせず、上限で退いていることを渡す', () => {
    const settings = presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync: paused({ limitedUntil: RESET }) }, at('2026-10-02T06:48:00Z')).cloud;
    expect(settings.paused).toBe(false);
    expect(settings.limited).toBe(true);
    expect(settings.stateLabel).toMatch(/^無料枠で停止 · \d{1,2}:\d{2} にリセット$/);
    // 手で止めたときは limited ではない。
    expect(presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync: paused({}) }).cloud).toMatchObject({ paused: true, limited: false });
  });
});

describe('一時停止中に版で止まったとき', () => {
  const REASON = 'この PC の hangar が古いので、クラウドが同期を拒否しました（この PC の互換の版は 1、クラウドが求めるのは 2 以上）。この PC の hangar を更新してください';
  const shellSync = (sync: SyncStatusBody) => presentShell(initialState(), { ...initialStore(), sync }, NOW).sync;
  it('状態は error のまま、文の頭に「一時停止中 · 」を添え、一時停止の印を渡す', () => {
    const sync = syncStatus({ state: 'error', error: REASON, paused: true });
    expect(shellSync(sync)).toMatchObject({ state: 'error', reason: null, label: `同期を一時停止中 · 同期エラー: ${REASON}` });
    // 設定の「状態」の語にも同じ頭を添える。
    expect(presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync }).cloud).toMatchObject({ state: 'error', paused: true, limited: false, stateLabel: '同期を一時停止中 · 同期エラー' });
  });
  it('Worker が古くて止まったときも、向きを言う error の文をそのまま出す（案内は向きに依らず、文は presenter で作り直さない）', () => {
    const WORKER_REASON = 'クラウドの Worker が古いので、同期を止めました（Worker の互換の版は 1、この PC が求めるのは 2 以上）。setup した PC で hangar setup cloud をもう一度実行して Worker を入れ替えてから、「今すぐ同期」を押してください';
    const sync = syncStatus({ state: 'error', error: WORKER_REASON, paused: true });
    expect(shellSync(sync)).toMatchObject({ state: 'error', reason: null, label: `同期を一時停止中 · 同期エラー: ${WORKER_REASON}` });
  });
  it('一時停止していない版のエラーは、今までどおり', () => {
    const sync = syncStatus({ state: 'error', error: REASON, paused: false });
    expect(shellSync(sync)).toMatchObject({ state: 'error', label: `同期エラー: ${REASON}` });
    expect(presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync }).cloud).toMatchObject({ paused: false, stateLabel: '同期エラー' });
  });
  it('上限で退いている間の振る舞いは変えない（一時停止の印があっても、退いていれば利用者が止めたことにしない）', () => {
    const sync = syncStatus({ state: 'paused', paused: false, limitedUntil: Date.parse('2026-10-03T00:00:00Z') });
    expect(shellSync(sync)).toMatchObject({ reason: 'quota' });
    expect(presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync }).cloud).toMatchObject({ paused: false, limited: true });
  });
});

describe('同期の Presenter（フェーズ 4）', () => {
  // ヘッダーの同期の一行は、Store の sync だけから決まる。State は同期の状態を持たない。
  const shellSync = (sync: SyncStatusBody | null) => presentShell(initialState(), { ...initialStore(), sync }, NOW).sync;
  it('ヘッダーの同期状態は種別ごとに文言が変わる', () => {
    expect(shellSync(syncStatus({ pending: 2 }))).toEqual({ visible: true, state: 'idle', label: '同期 1 分前', pending: '未送信の変更 2', sweepPending: null, skipped: null, reason: null, once: false, title: '同期 1 分前、未送信の変更 2（押すと同期の設定を開く）' });
    // 同期を使っていないと届いたときは、同期オフと言う。
    expect(shellSync(syncStatus({ state: 'off', url: null }))).toMatchObject({ visible: true, state: 'off', label: '同期オフ' });
    expect(shellSync(syncStatus({ state: 'pushing' }))).toMatchObject({ visible: true, state: 'pushing', label: '送信中' });
    expect(shellSync(syncStatus({ state: 'pulling' }))).toMatchObject({ state: 'pulling', label: '受信中' });
    expect(shellSync(syncStatus({ state: 'paused', paused: true }))).toMatchObject({ state: 'paused', label: '同期を一時停止中' });
    expect(shellSync(syncStatus({ state: 'error', error: '切れました', pending: 3 }))).toMatchObject({ state: 'error', label: '同期エラー: 切れました', pending: '未送信の変更 3' });
    // まだ一度も往復していない間は、時刻の代わりに準備中と出す。
    expect(shellSync(syncStatus({ lastPullAt: null, lastPushAt: null }))).toMatchObject({ state: 'idle', label: '同期の準備中' });
  });
  it('同期の状態がまだ届いていない間（Store の sync が null）は、「同期オフ」と言い間違えないよう何も出さない', () => {
    expect(shellSync(null)).toEqual({ visible: false, state: 'off', label: '', pending: null, sweepPending: null, skipped: null, reason: null, once: false, title: '' });
  });
  it('idle の最終時刻は pull を優先し、pull が無ければ push を採る', () => {
    expect(shellSync(syncStatus({ lastPullAt: NOW - 3 * 60_000, lastPushAt: NOW - 60_000 })).label).toBe('同期 3 分前');
    expect(shellSync(syncStatus({ lastPullAt: null, lastPushAt: NOW - 2 * 60_000 })).label).toBe('同期 2 分前');
  });
  it('error の本文が無いときは既定の文言にする', () => {
    expect(shellSync(syncStatus({ state: 'error', error: null })).label).toBe('同期エラー: 同期に失敗しました');
  });
  it('ヘッダーに取り残しの件数と送れなかった本文の件数が出る', () => {
    // 本文は 60 秒に 20 件ずつしか流れないので、残りが見えないと進んでいるか分からない。
    expect(shellSync(syncStatus({ pending: 2, sweepPending: 1500, skipped: [{ key: 'k1', attempts: 3, message: 'x' }, { key: 'k2', attempts: 1, message: 'y' }] }))).toMatchObject({ pending: '未送信の変更 2', sweepPending: '未送信のトランスクリプト 1500', skipped: '送信に失敗したトランスクリプト 2' });
    // 0 件は文を作らない（null）。ヘッダーは 0 件を描かないので、数えられない端末と無い端末を分けなくてよい。
    expect(shellSync(syncStatus())).toMatchObject({ pending: null, sweepPending: null, skipped: null });
    expect(shellSync(null)).toMatchObject({ sweepPending: null, skipped: null });
  });
  it('件数は title にも並べる。畳んでも読めるようにするため', () => {
    expect(shellSync(syncStatus({ pending: 2, sweepPending: 1500, skipped: [{ key: 'k1', attempts: 3, message: 'x' }] })).title).toBe('同期 1 分前、未送信の変更 2、未送信のトランスクリプト 1500、送信に失敗したトランスクリプト 1（押すと同期の設定を開く）');
  });
  it('語は設定の言語で言う（English）', () => {
    const en = (sync: SyncStatusBody | null) => presentShell(initialState(), { ...initialStore(), settings: fullSettings({ language: 'en' }), sync }, NOW, 'UTC').sync;
    expect(en(syncStatus({ state: 'off', url: null }))).toMatchObject({ visible: true, label: 'Sync off' });
    expect(en(syncStatus({ state: 'paused', paused: true }))).toMatchObject({ label: 'Sync paused' });
    expect(en(syncStatus({ state: 'error', error: 'x', pending: 1 }))).toMatchObject({ label: 'Sync error: x', pending: 'Unsent changes 1', title: 'Sync error: x, Unsent changes 1 (opens sync settings)' });
    expect(en(syncStatus({ state: 'paused', paused: false, limitedUntil: Date.parse('2026-10-03T00:00:00Z') }))).toMatchObject({ label: expect.stringMatching(/^Paused at free tier limit · resets at \d{2}:\d{2}$/) });
  });
  it('操作は持たない。今すぐ同期と一時停止は設定の同期の群にある', () => {
    expect(Object.keys(shellSync(syncStatus({ state: 'paused', paused: true })))).not.toContain('paused');
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
    const store: Store = { ...storeWith(), accounts: { currentId: 'primary', accounts: [{ ...accountsFixture.accounts[0]!, usage: { fiveHour: { usedPercent: 40, resetsAt: null }, sevenDay: null, updatedAt: NOW - 60_000 } }], sessions: {} } };
    const p = presentShell(initialState(), { ...store, sync: syncStatus() }, NOW);
    expect(p.usage).toEqual({ fiveHour: 40, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: '1 分前' });
    expect(p.sync.visible).toBe(true);
  });
  it('Settings のクラウドの節', () => {
    const store: Store = { ...initialStore(), sync: syncStatus({ pending: 3 }), devices: [{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: NOW - 120_000, self: true, shell: null }], joinToken: 'tok', settings: fullSettings({ syncClaudeConfig: true }) };
    const p = presentSettings(initialState(), store, NOW).cloud;
    expect(p).toMatchObject({ configured: true, url: 'https://h', state: 'idle', stateLabel: '同期済み', paused: false, pending: 3, lastPullAt: '1 分前', joinToken: 'tok', syncClaudeConfig: true, configConfirmed: false });
    expect(p.devices).toEqual([{ id: 'd', name: 'mac', platform: 'darwin', lastSeen: '2 分前', self: true }]);
    const paused = presentSettings(initialState(), { ...store, sync: syncStatus({ state: 'paused', claudeConfig: { enabled: true, confirmed: true } }) }, NOW).cloud;
    expect(paused).toMatchObject({ configured: true, state: 'paused', stateLabel: '同期を一時停止中', paused: true, configConfirmed: true });
    // ヘッダーと同じ語を使う。
    // エラーの理由はヘッダーにだけ出す。
    expect(presentSettings(initialState(), { ...store, sync: syncStatus({ state: 'pushing' }) }, NOW).cloud.stateLabel).toBe('送信中');
    expect(presentSettings(initialState(), { ...store, sync: syncStatus({ state: 'pulling' }) }, NOW).cloud.stateLabel).toBe('受信中');
    expect(presentSettings(initialState(), { ...store, sync: syncStatus({ state: 'error' }) }, NOW).cloud.stateLabel).toBe('同期エラー');
  });
  it('Settings のシェル連携の節。自端末は測り直した値を使い、古い版の端末は分からないと書く', () => {
    const devices = [
      { id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: NOW, self: true, shell: 'off' as const },
      { id: 'd2', name: 'mini', platform: 'darwin', lastSeenAt: NOW, self: false, shell: 'unsupported' as const },
      { id: 'd3', name: 'old', platform: 'darwin', lastSeenAt: NOW, self: false, shell: null },
    ];
    const store: Store = { ...initialStore(), devices, shellHook: { state: 'on', zshrc: '/Users/me/.zshrc', line: 'x', command: '/A/bin/hangar shell install' } };
    expect(presentSettings(initialState(), store, NOW).shell).toEqual({
      state: 'on', zshrc: '/Users/me/.zshrc', line: 'x', command: '/A/bin/hangar shell install', uninstallCommand: '/A/bin/hangar shell uninstall',
      devices: [{ id: 'd', name: 'mac', self: true, state: 'on', label: 'インストール済み' }, { id: 'd2', name: 'mini', self: false, state: 'unsupported', label: 'tmux が無いので使えません' }, { id: 'd3', name: 'old', self: false, state: null, label: '分かりません（hangar が古い版です）' }],
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
    expect(p).toMatchObject({ workspaceRoot: '/w', claudeDir: '/c', tmuxPath: '/t', terminalApp: 'terminal', summaryHourlyCap: 20 });
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

describe('presentShell のベル', () => {
  // 保持期間の帯はヘッダーの下から無くなり、ベルの一覧の行になった（PR 29）。行の組み方は notices.test.ts が試す。
  it('ベルの props を渡し、保持期間の帯の props は持たない', () => {
    const p = presentShell(initialState(), { ...initialStore(), bootstrapped: true }, NOW);
    expect(p.notices).toMatchObject({ rows: [], unread: 0, label: '通知' });
    expect('retention' in p).toBe(false);
  });
  it('既読の鍵は State から読み、未読の数をベルの名前に添える', () => {
    const store: Store = { ...initialStore(), bootstrapped: true, sync: { state: 'paused', paused: true, url: 'https://w', lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 1, claudeConfig: { enabled: false, confirmed: false }, limitedUntil: null, skipped: [], sweepPending: 0, oncePass: false } };
    expect(presentShell(initialState(), store, NOW).notices.unread).toBe(1);
    expect(presentShell({ ...initialState(), noticesRead: ['sync|paused|user'] }, store, NOW).notices.unread).toBe(0);
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
    expect(p).toMatchObject({ title: 'トランスクリプトの保持期間を 1 年にします', lead: 'Claude Code の設定ファイルに、次の 1 行を追加します。', path: P.path, backupDir: P.backupDir + '/', otherPcs: false, shrinkNote: null, showOther: true });
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
    expect(p.title).toBe('トランスクリプトの保持期間を 30 日に縮めます');
    expect(p.shrinkNote).toBe('次に Claude Code を使い始めたとき、セッションのトランスクリプト 1 件が削除されます。');
  });
  it('言語が英語なら、題と使用量の文も英語で作る', () => {
    const p = presentRetentionDialog(open(), st({ settings: { ...fullSettings(), language: 'en' } }), NOW)!;
    expect(p.title).toBe('Set the transcript retention period to 1 year');
    expect(p.lead).toBe('The following line will be added to the Claude Code settings file.');
    expect(p.bar).toMatchObject({ nowLabel: 'Now 1.5 GB', projLabel: 'About 18 GB after 1 year', freeLabel: '400 GB free' });
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

describe('presentSessionRow の要約の見立て（B1）', () => {
  const judged = (state: SessionSummaryDto['state'], source: SessionSummaryDto['source'] = 'in_session') => session('a', { summary: { ...session('a').summary!, state, source } });
  it('詰まっているとやめただけに色の調子を付け、ほかは調子なしで語だけを出す', () => {
    const store = initialStore();
    expect(presentSessionRow(judged('blocked'), store, NOW).summaryState).toEqual({ label: '詰まっている', tone: 'blocked' });
    expect(presentSessionRow(judged('abandoned', 'post_hoc'), store, NOW).summaryState).toEqual({ label: 'やめた', tone: 'abandoned' });
    expect(presentSessionRow(judged('in_progress'), store, NOW).summaryState).toEqual({ label: 'やりかけ', tone: null });
    expect(presentSessionRow(judged('done'), store, NOW).summaryState).toEqual({ label: '済んだ', tone: null });
  });
  it('土台の要約の状態は生きているかどうかの写しで見立てではないので出さず、要約が無ければ出さない', () => {
    const store = initialStore();
    expect(presentSessionRow(judged('done', 'baseline'), store, NOW).summaryState).toBeNull();
    expect(presentSessionRow(session('a', { summary: null }), store, NOW).summaryState).toBeNull();
  });
});

describe('presentSession の本文が消えた会話', () => {
  const DAY = 86_400_000;
  const gone = session('g', { hasTranscript: false, transcriptMtime: null, lastActivityAt: NOW - 40 * DAY });
  const R = { days: 30, source: 'default' as const, userValue: null, writable: true, unwritableReason: null, usage: null };
  it('注記を出し、既定のままなら延ばす手を添える', () => {
    const p = presentSession(initialState(), { ...initialStore(), retention: R, sessions: { g: gone } }, NOW, 'g');
    expect(p.gone).toEqual({ note: '本文は、Claude Code の保持期間（30 日）を過ぎたため削除されたとみられます。残っているのは要約だけです。', canExtend: true, extendTo: 365 });
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

describe('presentToasts（入力待ちのカード）', () => {
  const waitingStore = (ids: string[]) => {
    const s = storeWith();
    for (const id of ids) s.sessions[id] = session(id, { live: 'waiting', lastActivityAt: NOW - 120_000 });
    return s;
  };
  it('名前、待っている時間、問いを出す。問いが取れなければ null', () => {
    const store = waitingStore(['w1']);
    store.sessions.w1 = { ...store.sessions.w1!, activity: { tool: 'AskUserQuestion', summary: 'AskUserQuestion', question: '向きはどちらにしますか' } };
    const state = { ...initialState(), waitingToasts: ['w1'] };
    expect(presentToasts(state, store, NOW).waiting).toEqual([{ sessionId: 'w1', name: 'name-w1', waited: '2 分', question: '向きはどちらにしますか' }]);
    store.sessions.w1 = { ...store.sessions.w1!, activity: null };
    expect(presentToasts(state, store, NOW).waiting[0]?.question).toBeNull();
  });
  it('ホームを見ている間は出さない（要対応の札が言っている）', () => {
    const state = { ...initialState(), screen: { name: 'home' as const }, waitingToasts: ['w1', 'w2'] };
    const p = presentToasts(state, waitingStore(['w1', 'w2']), NOW);
    expect(p.waiting).toEqual([]);
    expect(p.more).toBe(0);
  });
  it('そのセッション自身の画面を見ている間は、その件だけ出さない', () => {
    const state = { ...initialState(), screen: { name: 'session' as const, id: 'w1' }, waitingToasts: ['w1', 'w2'] };
    expect(presentToasts(state, waitingStore(['w1', 'w2']), NOW).waiting.map((c) => c.sessionId)).toEqual(['w2']);
  });
  it('ほかの画面では今までどおり出す', () => {
    const state = { ...initialState(), screen: { name: 'projects' as const }, waitingToasts: ['w1'] };
    expect(presentToasts(state, waitingStore(['w1']), NOW).waiting.map((c) => c.sessionId)).toEqual(['w1']);
  });
  it('3 件までを新しいものが下に来る順で並べ、残りは数だけ返す', () => {
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const p = presentToasts({ ...initialState(), waitingToasts: ids }, waitingStore(ids), NOW);
    expect(p.waiting.map((c) => c.sessionId)).toEqual(['w3', 'w4', 'w5']);
    expect(p.more).toBe(2);
  });
  it('ストアに無いセッションのカードは出さない', () => {
    const p = presentToasts({ ...initialState(), waitingToasts: ['gone'] }, storeWith(), NOW);
    expect(p.waiting).toEqual([]);
    expect(p.more).toBe(0);
  });
  // 確認や入力のあるダイアログが開いている間は、カードを押しても画面を移さない（Mediator も止める）。押せないように見せる。
  it('確認や入力のあるダイアログが開いている間は、カードを押せないものとして渡す', () => {
    const base = { ...initialState(), waitingToasts: ['w1'] };
    const store = waitingStore(['w1']);
    expect(presentToasts(base, store, NOW).blocked).toBe(false);
    expect(presentToasts({ ...base, overlay: { kind: 'palette' } }, store, NOW).blocked).toBe(false);
    expect(presentToasts({ ...base, overlay: { kind: 'confirm', confirm: { kind: 'adoptSession', sessionId: 's1' } } }, store, NOW).blocked).toBe(true);
    expect(presentToasts({ ...base, overlay: { kind: 'newSession', projectId: null, scratch: true } }, store, NOW).blocked).toBe(true);
  });
  it('info と error のトーストはそのまま渡す', () => {
    const toasts = [{ id: '1', level: 'error' as const, message: 'oops' }];
    expect(presentToasts({ ...initialState(), toasts }, storeWith(), NOW).toasts).toEqual(toasts);
  });
  // 右下に積むのは入力待ちだけで、戻る時刻の札と通知の誘いはベルの一覧へ移った（PR 29）。
  it('入力待ちとトースト以外は渡さない（戻る時刻の札、通知の誘い）', () => {
    const store = { ...waitingStore(['w1']), notify: { available: true, on: false, blocked: false } };
    const p = presentToasts({ ...initialState(), waitingToasts: ['w1'] }, store, NOW);
    expect(Object.keys(p).sort()).toEqual(['blocked', 'more', 'toasts', 'waiting']);
  });
});

describe('presentShell のサイドバーの項目', () => {
  const labels = (n: { label: string }[]) => n.map((x) => x.label);
  it('項目は「ホーム」「プロジェクト」の 2 つで、設定は下端の別の組に置く。セッションの一覧の項目は無い', () => {
    const p = presentShell(initialState(), storeWith(), NOW);
    expect(labels(p.nav)).toEqual(['ホーム', 'プロジェクト']);
    expect(labels(p.foot)).toEqual(['設定']);
    expect(p.nav.some((n) => (n.route.name as string) === 'sessions')).toBe(false);
  });
  it('いまの画面の項目に印を付ける。設定は下端の組で付き、セッションの画面ではどの項目にも付かない', () => {
    const current = (screen: State['screen']) => { const p = presentShell({ ...initialState(), screen }, storeWith(), NOW); return [...p.nav, ...p.foot].filter((n) => n.current).map((n) => n.label); };
    expect(current({ name: 'home' })).toEqual(['ホーム']);
    expect(current({ name: 'project', id: 'alpha' })).toEqual(['プロジェクト']);
    expect(current({ name: 'settings' })).toEqual(['設定']);
    expect(current({ name: 'session', id: 's1' })).toEqual([]);
  });
});

describe('presentShell の入力待ちの数', () => {
  it('ホームの項目に入力待ちの数を添え、ほかの項目には添えない', () => {
    const store = storeWith();
    store.sessions.w1 = session('w1', { live: 'waiting' });
    store.sessions.w2 = session('w2', { live: 'waiting' });
    const nav = presentShell(initialState(), store, NOW).nav;
    expect(nav.find((n) => n.route.name === 'home')?.count).toBe(2);
    expect(nav.filter((n) => n.route.name !== 'home').every((n) => n.count === 0)).toBe(true);
    expect(presentShell(initialState(), storeWith(), NOW).nav.find((n) => n.route.name === 'home')?.count).toBe(0);
  });
});

describe('presentSettings の通知', () => {
  it('通知を出せるかと、受け取るかをそのまま渡す', () => {
    const store = { ...initialStore(), notify: { available: true, on: true, blocked: false } };
    expect(presentSettings(initialState(), store, NOW).notify).toEqual({ available: true, on: true, blocked: false });
    expect(presentSettings(initialState(), { ...store, notify: { available: true, on: false, blocked: true } }, NOW).notify).toEqual({ available: true, on: false, blocked: true });
    // Runtime がまだ何も知らせていない間は、出せない環境と同じに出す。
    expect(presentSettings(initialState(), initialStore(), NOW).notify).toEqual({ available: false, on: false, blocked: false });
  });
});

describe('presentSession の、区切りを付けたので止めた知らせ（冒頭の 1 枚）', () => {
  const stopped = (status: 'paused' | 'done' | 'archived', over: Partial<SessionDto> = {}) => {
    const store = storeWith();
    store.sessions.s2 = session('s2', { stoppedByStatus: true, state: { status, note: null, returnOn: status === 'paused' ? '2026-10-03' : null, returnTime: null, setBy: 'conversation', setAt: NOW - 60_000, candidate: null }, ...over });
    return presentSession(initialState(), store, NOW, 's2').lead!.stopped;
  };
  it('止めた訳を状態の語で言い、再開で続けられると添える', () => {
    expect(stopped('paused')).toBe('Paused にしたので停止しました。再開で続けられます');
    expect(stopped('done')).toBe('Done にしたので停止しました。再開で続けられます');
    expect(stopped('archived')).toBe('Archived にしたので停止しました。再開で続けられます');
  });
  it('止めていないセッションでは出さない', () => {
    expect(stopped('paused', { stoppedByStatus: false })).toBeNull();
    const store = storeWith();
    expect(presentSession(initialState(), store, NOW, 's2').lead!.stopped).toBeNull();
  });
  it('また動いている間は出さない。バックグラウンドの本体が止まり切る前などに、動きの語と食い違わせない', () => {
    expect(stopped('paused', { live: 'idle' })).toBeNull();
  });
});

describe('presentSessionRow のセッションの状態', () => {
  const store = initialStore();
  const today = localDate(NOW);
  const withState = (state: SessionDto['state']) => session('s1', { state });
  const pick = (s: SessionDto) => { const r = presentSessionRow(s, store, NOW); return { state: r.state, returnOn: r.returnOn, overdueDays: r.overdueDays, candidate: r.candidate, setBy: r.setBy }; };
  it('state が null なら Active として読む', () => {
    const none = { state: null, returnOn: null, overdueDays: null, candidate: null, setBy: null };
    expect(pick(session('s1'))).toEqual(none);
    expect(pick(withState(null))).toEqual(none);
  });
  it('Paused は戻る日と過ぎた日数を持ち、Done と Archived は戻る日を持たない', () => {
    expect(pick(withState({ status: 'paused', note: '見る', returnOn: addDays(today, -2), returnTime: null, setBy: 'user', setAt: 1, candidate: null }))).toEqual({ state: 'paused', returnOn: addDays(today, -2), overdueDays: 2, candidate: null, setBy: 'user' });
    expect(pick(withState({ status: 'paused', note: null, returnOn: addDays(today, 3), returnTime: null, setBy: 'user', setAt: 1, candidate: null })).overdueDays).toBeNull();
    expect(pick(withState({ status: 'done', note: null, returnOn: '2026-10-02', returnTime: null, setBy: 'conversation', setAt: 1, candidate: null }))).toEqual({ state: 'done', returnOn: null, overdueDays: null, candidate: null, setBy: 'conversation' });
    expect(pick(withState({ status: 'archived', note: null, returnOn: null, returnTime: null, setBy: 'import', setAt: 1, candidate: null })).state).toBe('archived');
  });
  // 同期や古い端末から、戻る日が欠けた・暦に無い・形の違う Paused が届く（Ruling 2A）。undefined や壊れた文字列を行に流さず null にする。
  it('Paused の戻る日が欠けた・暦に無い・形が違うときは、returnOn を null にして Paused のまま読む', () => {
    for (const bad of [null, '2026-02-30', 'いつか', '']) {
      expect(pick(withState({ status: 'paused', note: null, returnOn: bad, returnTime: null, setBy: 'user', setAt: 1, candidate: null })), String(bad)).toEqual({ state: 'paused', returnOn: null, overdueDays: null, candidate: null, setBy: 'user' });
    }
    expect(pick(withState({ status: 'paused', note: null, returnOn: undefined as unknown as null, returnTime: null, setBy: 'user', setAt: 1, candidate: null })).returnOn).toBeNull();
  });
  it('提案は経過時間を添える', () => {
    const r = pick(withState({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: { status: 'done', note: '直した', returnOn: null, returnTime: null, source: 'post_hoc', at: NOW - 12 * 60_000 } }));
    expect(r).toEqual({ state: null, returnOn: null, overdueDays: null, setBy: null, candidate: { status: 'done', note: '直した', returnOn: null, returnTime: null, source: 'post_hoc', ago: '12 分前' } });
  });
});

describe('戻る日と提案の札の文言', () => {
  it('今日は「今日」、過ぎたものは「N 日過ぎ」、先のものは月日と曜日', () => {
    expect(returnOnLabel('2026-10-01', 0)).toBe('今日');
    expect(returnOnLabel('2026-09-28', 3)).toBe('3 日過ぎ');
    expect(returnOnLabel('2026-10-02', null)).toBe('10/2（金）');
    expect(returnOnLabel('2026-12-31', null)).toBe('12/31（木）');
  });
  it('戻る日が無いか壊れているときは、NaN や undefined を返さず「日付なし」', () => {
    expect(returnOnLabel(null, null)).toBe('日付なし');
    expect(returnOnLabel('2026-02-30', null)).toBe('日付なし');
    expect(returnOnLabel('いつか', null)).toBe('日付なし');
    expect(returnOnLabel('', 0)).toBe('日付なし');
  });
  it('提案の札は「Done にする？」か「Paused · 日？」', () => {
    expect(candidateLabel({ status: 'done', returnOn: null })).toBe('Done にする？');
    expect(candidateLabel({ status: 'paused', returnOn: '2026-10-05' })).toBe('Paused · 10/5（月）？');
  });
});
