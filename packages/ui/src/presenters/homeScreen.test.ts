import { describe, expect, it } from 'vitest';
import type { ProjectDto, SearchHitDto, SessionDto, SessionStateDto, SettingsDto } from '@agent-hangar/shared';
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

describe('presentHomeScreen の始める前の確認', () => {
  it('セッションもプロジェクトも無いあいだは、確認リストを出す（確認の要約と引き出しは PR 32 で作るので、それまで今のリストを残す）', () => {
    const empty = initialStore();
    empty.bootstrapped = true;
    expect(presentHomeScreen(initialState(), empty, NOW).onboarding).toEqual({ checks: null });
    expect(presentHomeScreen(initialState(), busyMorning(), NOW).onboarding).toBeNull();
  });
});
