import { describe, expect, it } from 'vitest';
import type { ProjectDto, ReadinessDto, SearchHitDto, SessionDto, SessionStateDto, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentHomeScreen } from './home.ts';

const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null, ...o });
const dto = (id: string, hoursAgo: number, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - (hoursAgo + 1) * H, lastActivityAt: NOW - hoursAgo * H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
function storeOf(list: SessionDto[]): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha') };
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  return s;
}
const hit = (id: string): SearchHitDto => ({ sessionId: id, matchCount: 1, snippets: [] });
const withSearch = (search: Omit<State['search'], 'page'>): State => ({ ...initialState(), screen: { name: 'home' }, search: { ...search, page: 1 } });
const candidate = { status: 'done' as const, note: '直した', returnOn: null, returnTime: null, source: 'in_session' as const, at: NOW - H };

/** 忙しい朝：入力待ち 1、実行中 1、確認待ち 1、終わったもの 2、Archived 1。 */
const busyMorning = () => storeOf([
  dto('w1', 1, { live: 'waiting', activity: { tool: 'AskUserQuestion', summary: '', question: '消してよいですか' } }),
  dto('r1', 0.1, { live: 'busy' }),
  dto('c1', 3, { state: st({ candidate }) }),
  dto('d1', 20, { state: st({ status: 'done', setBy: 'user', setAt: NOW - 20 * H }) }),
  dto('d2', 30, { state: st({ status: 'done', setBy: 'user', setAt: NOW - 30 * H }) }),
  dto('a1', 40, { state: st({ status: 'archived', setBy: 'user', setAt: NOW - 40 * H }) }),
]);

describe('presentHomeScreen の帯', () => {
  it('要対応、実行中、確認待ちの 3 つの群を、件数つきで並べる（4 つ目の錠剤は PR 33 で足す）', () => {
    const p = presentHomeScreen(initialState(), busyMorning(), NOW);
    expect(p.band.groups.map((g) => [g.id, g.label, g.count])).toEqual([['attention', '要対応', 1], ['running', '実行中', 1], ['pending', '確認待ち', 1]]);
  });

  it('朝は要対応の引き出しが開いている。要対応が無ければ実行中、それも無ければ確認待ち', () => {
    expect(presentHomeScreen(initialState(), busyMorning(), NOW).band.morning).toBe('attention');
    const noWaiting = busyMorning();
    delete noWaiting.sessions.w1;
    expect(presentHomeScreen(initialState(), noWaiting, NOW).band.morning).toBe('running');
    delete noWaiting.sessions.r1;
    expect(presentHomeScreen(initialState(), noWaiting, NOW).band.morning).toBe('pending');
    delete noWaiting.sessions.c1;
    expect(presentHomeScreen(initialState(), noWaiting, NOW).band.morning).toBeNull();
  });

  it('語は用語集のとおり、言語の設定で替わる', () => {
    const en = { ...busyMorning(), settings: { language: 'en' } as SettingsDto };
    expect(presentHomeScreen(initialState(), en, NOW).band.groups.map((g) => g.label)).toEqual(['Needs attention', 'Running', 'Pending review']);
  });
});

describe('presentHomeScreen の空の日（idle）', () => {
  it('要対応も実行中も確認待ちも 0 のときだけ真。帯の代わりに「実行中のセッションはありません」の 1 行を出す', () => {
    expect(presentHomeScreen(initialState(), busyMorning(), NOW).idle).toBe(false);
    const quiet = storeOf([dto('d1', 20, { state: st({ status: 'done', setBy: 'user', setAt: NOW - 20 * H }) })]);
    expect(presentHomeScreen(initialState(), quiet, NOW).idle).toBe(true);
  });
  it('確認待ちだけが残っているときは真にしない', () => {
    const onlyPending = storeOf([dto('c1', 3, { state: st({ candidate }) })]);
    expect(presentHomeScreen(initialState(), onlyPending, NOW).idle).toBe(false);
  });
});

describe('presentHomeScreen の検索', () => {
  it('語か触ったファイルで探しているあいだ（サーバへ問い合わせるあいだ）は searching が真で、引き出しを閉じる', () => {
    const store = busyMorning();
    expect(presentHomeScreen(initialState(), store, NOW).searching).toBe(false);
    expect(presentHomeScreen(withSearch({ text: '動画', filter: {} }), store, NOW).searching).toBe(true);
    expect(presentHomeScreen(withSearch({ text: '', filter: { file: 'a.ts' } }), store, NOW).searching).toBe(true);
  });
  it('タブや期間だけの絞り込みは検索ではない。引き出しは開けたまま', () => {
    const store = busyMorning();
    expect(presentHomeScreen(withSearch({ text: '', filter: { status: 'done' } }), store, NOW).searching).toBe(false);
    expect(presentHomeScreen(withSearch({ text: '', filter: { days: 7, projectId: 'alpha' } }), store, NOW).searching).toBe(false);
  });
  it('検索の結果は「さらに読み込む」で足す。残りは全件から持っている行を引いた数', () => {
    const store = { ...busyMorning(), search: { params: { q: '動画' }, result: { hits: [hit('d1'), hit('d2')], total: 132 }, loading: false } };
    const p = presentHomeScreen(withSearch({ text: '動画', filter: {} }), store, NOW);
    expect(p.list.mode).toBe('search');
    expect(p.list.rows.map((r) => r.id)).toEqual(['d1', 'd2']);
    expect(p.list.pager).toBeNull();
    expect(p.loadMore).toEqual({ remaining: 130, step: 50, loading: false });
    expect(presentHomeScreen(withSearch({ text: '動画', filter: {} }), { ...store, search: { ...store.search, loading: true } }, NOW).loadMore).toMatchObject({ loading: true });
  });
  it('全部読み終えたら「さらに読み込む」は出さない', () => {
    const store = { ...busyMorning(), search: { params: { q: '動画' }, result: { hits: [hit('d1'), hit('d2')], total: 2 }, loading: false } };
    expect(presentHomeScreen(withSearch({ text: '動画', filter: {} }), store, NOW).loadMore).toBeNull();
  });
});

describe('presentHomeScreen の一覧', () => {
  it('条件の無い一覧は平らで、節に分けない。Archived 以外の全件が並び、ページ送りは件数に収まれば出さない', () => {
    const p = presentHomeScreen(initialState(), busyMorning(), NOW);
    expect(p.list).not.toHaveProperty('sections');
    expect(p.list.mode).toBe('all');
    expect(p.list.rows.map((r) => r.id).sort()).toEqual(['c1', 'd1', 'd2', 'r1', 'w1']);
    expect(p.loadMore).toBeNull();
    expect(p.list.pager).toBeNull();
  });
  it('件数が 1 ページを超えるとページ送りを出す（検索でないとき）', () => {
    const many = storeOf(Array.from({ length: 70 }, (_, i) => dto(`e${i}`, i + 1)));
    const p = presentHomeScreen(initialState(), many, NOW);
    expect(p.list.rows).toHaveLength(50);
    expect(p.list.pager).toMatchObject({ page: 1 });
    expect(p.loadMore).toBeNull();
  });
  it('状態のタブは「確認待ち」の語で出す', () => {
    const p = presentHomeScreen(initialState(), busyMorning(), NOW);
    expect(p.list.tabs.map((t) => t.label)).toEqual(['すべて', '確認待ち', 'Active', 'Paused', 'Done', 'Archived']);
  });
  it('見出しの件数は、条件に関わらず手元の全件（Archived を除く）', () => {
    expect(presentHomeScreen(initialState(), busyMorning(), NOW).allCount).toBe(5);
    expect(presentHomeScreen(withSearch({ text: '', filter: { status: 'done' } }), busyMorning(), NOW).allCount).toBe(5);
  });
});

describe('presentHomeScreen の始める前の確認（2.11.4）', () => {
  const READY: ReadinessDto = {
    tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
    workspace: { path: '/Users/me/workspace', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: 'bash x', scriptPath: '/Users/me/.claude/statusline.sh', installed: false },
    commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
    compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
  };
  const OPTIONAL_ONLY: ReadinessDto = { ...READY, workspace: { ...READY.workspace, projectCount: 12 } };
  const empty = (readiness: ReadinessDto | null) => ({ ...initialStore(), bootstrapped: true, readiness });
  const busy = (readiness: ReadinessDto | null) => ({ ...busyMorning(), readiness });

  it('確かめが届くまでは、確認の群も帯の文も出さない。セッションが無ければ空の日のまま', () => {
    const p = presentHomeScreen(initialState(), empty(null), NOW);
    expect(p.note).toBeNull();
    expect(p.idle).toBe(true);
    expect(p.band.groups.map((g) => g.id)).toEqual(['attention', 'running', 'pending']);
  });
  it('起動のたびの確かめで直すものがあれば、ふだんの 3 つの後ろ（最後）に確認の群を足す。誰にでも出す', () => {
    const p = presentHomeScreen(initialState(), busy(READY), NOW);
    expect(p.band.groups.map((g) => g.id)).toEqual(['attention', 'running', 'pending', 'readiness']);
    expect(p.band.groups.at(-1)).toMatchObject({ countText: '6 つ中 3 つ', count: 3 });
    expect(p.note).toBe('もう始められます。設定の残りは 3 件です');
    expect(p.idle).toBe(false);
    // 朝は要対応が開いたまま。
    expect(p.band.morning).toBe('attention');
  });
  it('3 つの群がどれも 0 件のときは、薄い 3 つの錠剤を出さず、確認の群だけを開いて置く。「実行中のセッションはありません」の 1 行は出さない', () => {
    const p = presentHomeScreen(initialState(), empty(READY), NOW);
    expect(p.band.groups.map((g) => g.id)).toEqual(['readiness']);
    expect(p.band.morning).toBe('readiness');
    expect(p.idle).toBe(false);
  });
  it('必須が済んで任意の行だけが残ったら、帯ごと消す。空の日の 1 行が戻る', () => {
    const p = presentHomeScreen(initialState(), empty(OPTIONAL_ONLY), NOW);
    expect(p.band.groups.map((g) => g.id)).toEqual(['attention', 'running', 'pending']);
    expect(p.note).toBeNull();
    expect(p.idle).toBe(true);
  });
  it('全部そろったときも、確認の群は出ない', () => {
    const all: ReadinessDto = { ...OPTIONAL_ONLY, mcp: { ...READY.mcp, registered: true }, statusline: { ...READY.statusline, installed: true } };
    expect(presentHomeScreen(initialState(), busy(all), NOW).band.groups.map((g) => g.id)).toEqual(['attention', 'running', 'pending']);
  });
  it('言語の設定で文が替わる', () => {
    const en = { ...empty(READY), settings: { language: 'en' } as SettingsDto };
    const p = presentHomeScreen(initialState(), en, NOW);
    expect(p.band.groups[0]).toMatchObject({ label: 'Setup check', countText: '3 of 6' });
    expect(p.note).toBe('You can start now. 3 items left to set up');
  });
});

describe('presentHomeScreen の場所の不明なプロジェクト（2.11.5）', () => {
  const missing = (id: string): ProjectDto => ({ ...project(id), resolved: false, unresolved: { kind: 'missing', previousPath: `/w/${id}`, deviceName: null } });
  const arrived = (id: string): ProjectDto => ({ ...project(id), path: null, resolved: false, unresolved: { kind: 'elsewhere', previousPath: `/o/${id}`, deviceName: 'Mac mini' } });
  const withProjects = (store: Store, list: ProjectDto[]): Store => ({ ...store, projects: { ...store.projects, ...Object.fromEntries(list.map((p) => [p.id, p])) } });

  it('場所の消えたものがあれば、確認待ちの後ろに 4 つ目の錠剤を足す。帯の件数に入れるのはこの PC で消えたものだけ', () => {
    const p = presentHomeScreen(initialState(), withProjects(busyMorning(), [missing('lost'), arrived('x1'), arrived('x2'), arrived('x3')]), NOW);
    expect(p.band.groups.map((g) => [g.id, g.count])).toEqual([['attention', 1], ['running', 1], ['pending', 1], ['unresolved', 1]]);
    expect(p.band.morning).toBe('attention');
  });

  it('他の PC から届いただけなら、群を足さない。帯は消え、空の日の 1 行が出る', () => {
    const p = presentHomeScreen(initialState(), withProjects(storeOf([]), [arrived('x1'), arrived('x2'), arrived('x3')]), NOW);
    expect(p.band.groups.map((g) => g.id)).toEqual(['attention', 'running', 'pending']);
    expect(p.idle).toBe(true);
  });

  it('ほかの 3 つの群がどれも 0 件でも、場所の消えたものがあれば静かな日ではない。薄い 3 つの錠剤は出さず、その群だけを置く', () => {
    const p = presentHomeScreen(initialState(), withProjects(storeOf([]), [missing('lost')]), NOW);
    expect(p.idle).toBe(false);
    expect(p.band.groups.map((g) => g.id)).toEqual(['unresolved']);
    // 朝に開く群ではないので、引き出しは閉じたまま。
    expect(p.band.morning).toBeNull();
  });

  it('確認の群と並ぶときは、場所の不明なプロジェクトが先、確認が最後', () => {
    const READY: ReadinessDto = {
      tools: { tmux: { path: null, ok: false, problem: 'unset', version: null }, claude: { path: null, ok: false, problem: 'unset', version: null }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/n', ok: true, problem: null, version: 'v22', auto: true } },
      workspace: { path: '/w', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/c' }, statusline: { command: 'x', scriptPath: '/s', installed: false },
      commands: { mcp: 'a', statusline: 'b', shell: 'c' }, compat: { verifiedVersion: '1', localVersion: '1', driftCount: 0 },
    };
    const p = presentHomeScreen(initialState(), { ...withProjects(storeOf([]), [missing('lost')]), readiness: READY }, NOW);
    expect(p.band.groups.map((g) => g.id)).toEqual(['unresolved', 'readiness']);
  });
});
