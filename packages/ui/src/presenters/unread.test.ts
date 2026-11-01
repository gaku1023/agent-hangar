import { describe, expect, it } from 'vitest';
import type { SessionDto, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentHomeScreen } from './home.ts';
import { presentShell } from './shell.ts';

const NOW = new Date(2026, 9, 29, 9, 0).getTime();
const unread = (count: number, at = NOW - 60_000) => ({ count, latest: '調査が終わりました', at });
const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: null, name: id, cwd: '/w', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 3_600_000, lastActivityAt: NOW - 60_000, lastTurnAt: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, pinnedAt: null, unread: null, spawnedBy: null, ...over });
function storeOf(list: SessionDto[], settings: Partial<SettingsDto> | null = null): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  s.settings = settings as SettingsDto | null;
  return s;
}
const stateWith = (store: Store) => ({ ...initialState(), sidebarOrder: Object.keys(store.sessions) });

describe('ホームの項目の丸とサイドバーの行', () => {
  const list = () => [dto('w', { live: 'waiting' }), dto('u', { live: 'busy', unread: unread(2) })];
  it('ホームの項目の丸は、入力待ち 1 と未読 2 で 3。内訳も持つ', () => {
    const store = storeOf(list());
    const home = presentShell(stateWith(store), store, NOW).nav.find((n) => n.route.name === 'home')!;
    expect(home).toMatchObject({ count: 3, waiting: 1, unread: 2 });
  });
  it('実行中の行は未読の数を持ち、無い行は 0', () => {
    const store = storeOf(list());
    const rows = presentShell(stateWith(store), store, NOW).live.rows;
    expect(rows.find((r) => r.id === 'u')!.unread).toBe(2);
    expect(rows.find((r) => r.id === 'w')!.unread).toBe(0);
  });
  it('unreadBadge が切なら、データがあっても出さない', () => {
    const store = storeOf(list(), { unreadBadge: false });
    const p = presentShell(stateWith(store), store, NOW);
    expect(p.nav.find((n) => n.route.name === 'home')).toMatchObject({ count: 1, unread: 0 });
    expect(p.live.rows.every((r) => r.unread === 0)).toBe(true);
  });
});

describe('ホームの帯の「未読」', () => {
  it('要対応と実行中の間に置き、数は未読の合計。引き出しは知らせの新しい会話が先で、最後の文と時刻と数を持つ', () => {
    const store = storeOf([dto('a', { live: 'busy', unread: unread(2, NOW - 120_000) }), dto('b', { live: null, unread: unread(1, NOW - 60_000) }), dto('c', { live: 'waiting' })]);
    const band = presentHomeScreen(stateWith(store), store, NOW).band;
    expect(band.groups.map((g) => g.id)).toEqual(['attention', 'unread', 'running', 'pending']);
    const g = band.groups[1]!;
    expect(g).toMatchObject({ label: '未読', count: 3, morning: false });
    expect(g.rows.map((r) => r.key)).toEqual(['unread:b', 'unread:a']);
    expect(g.rows[1]).toMatchObject({ name: 'a', text: '調査が終わりました', open: { type: 'session.open', id: 'a' }, lead: { kind: 'dot', live: 'busy' } });
    expect(g.rows[1]!.trail.map((x) => x.text)).toEqual(['2 分前', '2']);
    expect(g.rows[1]!.trail[1]!.tone).toBe('unread');
  });
  it('未読が無ければ 0 の札で行は無い。Done でも未読は残る', () => {
    const none = presentHomeScreen(stateWith(storeOf([dto('a', { live: 'busy' })])), storeOf([dto('a', { live: 'busy' })]), NOW).band.groups[1]!;
    expect(none).toMatchObject({ id: 'unread', count: 0, rows: [] });
    const done = storeOf([dto('d', { state: { status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'user', setAt: 1, candidate: null }, unread: unread(1) })]);
    expect(presentHomeScreen(stateWith(done), done, NOW).band.groups[1]!.rows.map((r) => r.key)).toEqual(['unread:d']);
  });
  it('unreadBadge が切なら、数も行も出さない', () => {
    const store = storeOf([dto('a', { live: 'busy', unread: unread(2) })], { unreadBadge: false });
    expect(presentHomeScreen(stateWith(store), store, NOW).band.groups.find((g) => g.id === 'unread')).toMatchObject({ count: 0, rows: [] });
  });
});
