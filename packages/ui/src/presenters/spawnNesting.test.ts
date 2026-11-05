import { describe, expect, it } from 'vitest';
import type { SessionDto, StatusFilter } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSessionList } from './sessions.ts';
import { presentShell } from './shell.ts';
import { spawnFoldKey } from './spawnTree.ts';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: null, name: 'name-' + id, cwd: '/w', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 180_000, lastTurnAt: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, pinnedAt: null, unread: null, spawnedBy: null, spawnPeer: null, ...over });
const storeOf = (list: SessionDto[]): Store => {
  const s = initialStore();
  s.bootstrapped = true;
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  return s;
};

describe('起動元の状態', () => {
  const state = (status: 'done' | 'archived' | 'paused') => ({ state: { status, setBy: 'user', setAt: NOW, note: null, returnOn: null, candidate: null } as SessionDto['state'] });
  const liveRows = (store: Store) => presentShell(initialState(), store, NOW).live.groups[0]!.rows.map((r) => [r.id, r.depth ?? 0]);
  it.each(['done', 'archived'] as const)('起動元が %s なら、子は独立した行になり、起動元はサイドバーに出さない', (status) => {
    const store = storeOf([session('p', { live: null, ...state(status) }), session('c', { live: 'busy', spawnedBy: 'p' })]);
    expect(liveRows(store)).toEqual([['c', 0]]);
    expect(presentSessionList(initialState(), store, NOW).rows.find((r) => r.id === 'c')?.nest?.depth ?? 0).toBe(0);
  });
  it('起動元が Paused なら、入れ子のままにする', () => {
    const store = storeOf([session('p', { live: null, ...state('paused') }), session('c', { live: 'busy', spawnedBy: 'p' })]);
    expect(liveRows(store)).toEqual([['p', 0], ['c', 1]]);
  });
});

describe('別の PC の子（案 3A）', () => {
  const peerSpawn = (over: Partial<NonNullable<SessionDto['spawnPeer']>> = {}) => ({ spawnPeer: { parent: null, child: 'Mac', closed: false, ...over } });
  it('親の下に入れ子になり、行は子の PC の名前を持つ（テスト 21）', () => {
    const store = storeOf([session('p', { live: 'busy', startedAt: 1 }), session('c', { live: null, spawnedBy: 'p', startedAt: 2, ...peerSpawn() })]);
    store.runs = { r1: { id: 'r1', sessionId: 'c', endedAt: null } as never };
    const live = presentShell(initialState(), store, NOW).live;
    expect(live.groups[0]!.rows.map((r) => [r.id, r.depth ?? 0])).toEqual([['p', 0], ['c', 1]]);
    expect(live.rows.find((r) => r.id === 'c')!.peer).toEqual({ name: 'Mac', ended: false });
    expect(live.rows.find((r) => r.id === 'p')!.peer).toBeUndefined();
  });
  it('結び付きが終わった（closed）子は ended。同じ PC の子と、相手の PC から見た子（親が別の PC）は札を持たない', () => {
    const store = storeOf([
      session('p', { live: 'busy', startedAt: 1 }), session('c', { live: 'busy', spawnedBy: 'p', startedAt: 2, ...peerSpawn({ closed: true }) }),
      session('l', { live: 'busy', spawnedBy: 'p', startedAt: 3 }), session('r', { live: 'busy', startedAt: 4, spawnedBy: 'far', ...peerSpawn({ parent: 'Win', child: null }) }),
    ]);
    const rows = presentShell(initialState(), store, NOW).live.rows;
    expect(rows.find((r) => r.id === 'c')!.peer).toEqual({ name: 'Mac', ended: true });
    expect(rows.find((r) => r.id === 'l')!.peer).toBeUndefined();
    expect(rows.find((r) => r.id === 'r')!.peer).toBeUndefined();
  });
});

describe('サイドバーの実行中の入れ子', () => {
  it('子は起動元の下に並び、深さと開閉の印を持つ', () => {
    const store = storeOf([session('p', { live: 'busy', startedAt: 1 }), session('c', { live: 'busy', spawnedBy: 'p', startedAt: 2 }), session('g', { live: 'waiting', spawnedBy: 'c', startedAt: 3 }), session('x', { live: 'busy', startedAt: 4 })]);
    const live = presentShell(initialState(), store, NOW).live;
    expect(live.groups[0]!.rows.map((r) => [r.id, r.depth ?? 0])).toEqual([['p', 0], ['c', 1], ['g', 2], ['x', 0]]);
    const p = live.rows.find((r) => r.id === 'p')!;
    expect(p.nest).toMatchObject({ open: true });
    expect(p.nest!.dots.map((d) => d.live)).toEqual(['busy', 'waiting']);
    expect(live.rows.find((r) => r.id === 'x')!.nest).toBeUndefined();
    expect(live.count).toBe(4);
  });
  it('起動元が止まっていて子が動いていれば、起動元を薄く出す。数には入れない', () => {
    const store = storeOf([session('p', { live: null }), session('c', { live: 'busy', spawnedBy: 'p' })]);
    const live = presentShell(initialState(), store, NOW).live;
    expect(live.rows.map((r) => [r.id, r.dim === true, r.depth ?? 0])).toEqual([['p', true, 0], ['c', false, 1]]);
    expect(live.count).toBe(1);
    expect(live.ids).toEqual(['c']);
  });
  it('起動元も子も動いていなければ起動元は出さない。起動元が見つからない子は平らに並べる', () => {
    const store = storeOf([session('p', { live: null }), session('c', { live: null, spawnedBy: 'p' }), session('o', { live: 'busy', spawnedBy: 'gone' })]);
    const live = presentShell(initialState(), store, NOW).live;
    expect(live.rows.map((r) => [r.id, r.depth ?? 0])).toEqual([['o', 0]]);
  });
  it('畳んだ向きは起動元ごとに sidebarFolded から読む', () => {
    const store = storeOf([session('p', { live: 'busy' }), session('c', { live: 'busy', spawnedBy: 'p' })]);
    const live = presentShell({ ...initialState(), sidebarFolded: [spawnFoldKey('p')] }, store, NOW).live;
    expect(live.rows.find((r) => r.id === 'p')!.nest).toMatchObject({ open: false });
  });
  it('子は起動元のグループに入る（子のプロジェクトが違っても）', () => {
    const store = storeOf([session('p', { live: 'busy', projectId: 'A' }), session('c', { live: 'busy', projectId: 'B', spawnedBy: 'p' })]);
    const live = presentShell(initialState(), store, NOW).live;
    expect(live.groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([['A', ['p', 'c']]]);
  });
  it('輪になった起動元でも落ちない', () => {
    const store = storeOf([session('a', { live: 'busy', spawnedBy: 'b' }), session('b', { live: 'busy', spawnedBy: 'a' })]);
    expect(presentShell(initialState(), store, NOW).live.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

describe('一覧の入れ子', () => {
  const rowsOf = (store: Store, status?: StatusFilter, folded: string[] = []) => presentSessionList({ ...initialState(), sidebarFolded: folded, search: { ...initialState().search, filter: status ? { status } : {} } }, store, NOW).rows;
  const done = { status: 'done', setBy: 'user', note: null, at: 1, returnOn: null, returnTime: null, candidate: null } as unknown as SessionDto['state'];
  it('すべてのタブでは子が起動元の下に並び、平らには出ない', () => {
    const store = storeOf([session('p', { lastActivityAt: NOW - 10 }), session('c', { spawnedBy: 'p', lastActivityAt: NOW - 20 }), session('x', { lastActivityAt: NOW - 30 })]);
    const rows = rowsOf(store);
    expect(rows.map((r) => [r.id, r.nest?.depth ?? 0])).toEqual([['p', 0], ['c', 1], ['x', 0]]);
    expect(rows[0]!.nest!.toggle).toMatchObject({ open: true });
    expect(rows[2]!.nest?.toggle ?? null).toBeNull();
  });
  it('畳んだ起動元の子は行から外し、丸だけを持たせる', () => {
    const store = storeOf([session('p'), session('c', { spawnedBy: 'p', live: 'busy' })]);
    const rows = rowsOf(store, undefined, [spawnFoldKey('p')]);
    expect(rows.map((r) => r.id)).toEqual(['p']);
    expect(rows[0]!.nest!.toggle).toMatchObject({ open: false, dots: [{ live: 'busy' }] });
  });
  it('子の状態が起動元と違えば、起動元の下にも自分の区分にも出る', () => {
    const store = storeOf([session('p'), session('c', { spawnedBy: 'p', state: done })]);
    expect(rowsOf(store, 'active').map((r) => [r.id, r.nest?.depth ?? 0])).toEqual([['p', 0], ['c', 1]]);
    expect(rowsOf(store, 'done').map((r) => [r.id, r.nest?.depth ?? 0])).toEqual([['c', 0]]);
  });
  it('起動元が一覧に無い子は平らに出る', () => {
    const store = storeOf([session('c', { spawnedBy: 'gone' })]);
    expect(rowsOf(store).map((r) => [r.id, r.nest?.depth ?? 0])).toEqual([['c', 0]]);
  });
});

describe('別の PC の子のサイドバーと一覧（実物の確かめの直し）', () => {
  const peerSpawn = (over: Partial<NonNullable<SessionDto['spawnPeer']>> = {}) => ({ spawnPeer: { parent: null, child: 'Mac', closed: false, ...over } });
  const done = { state: { status: 'done', setBy: 'user', setAt: NOW, note: null, returnOn: null, candidate: null } as SessionDto['state'] };
  const remote = (id: string, over: Partial<SessionDto> = {}) => session(id, { live: null, remoteOnly: true, spawnedBy: 'p', startedAt: 2, ...peerSpawn(), ...over });
  const rowsOf = (store: Store) => presentShell(initialState(), store, NOW).live.groups.flatMap((g) => g.rows);
  it('この PC で動く親の下に、別の PC の子を札つきで入れ子にする（run も live も無くてよい）', () => {
    const rows = rowsOf(storeOf([session('p', { live: 'busy', startedAt: 1 }), remote('c')]));
    expect(rows.map((r) => [r.id, r.depth ?? 0])).toEqual([['p', 0], ['c', 1]]);
    expect(rows[1]!.peer).toEqual({ name: 'Mac', ended: false });
    expect(rows[0]!.nest?.dots).toHaveLength(1);
  });
  it('結び付きが終わった子も、切り離していなければ出す（ended）', () => {
    const rows = rowsOf(storeOf([session('p', { live: 'busy', startedAt: 1 }), remote('c', peerSpawn({ closed: true }))]));
    expect(rows[1]!.peer).toEqual({ name: 'Mac', ended: true });
  });
  it('子が Done なら出さない。親が止まっているときは、別の PC の子で親を引き出さない', () => {
    expect(rowsOf(storeOf([session('p', { live: 'busy', startedAt: 1 }), remote('c', done)])).map((r) => r.id)).toEqual(['p']);
    expect(rowsOf(storeOf([session('p', { live: null }), remote('c')])).map((r) => r.id)).toEqual([]);
  });
  it('別の PC の子でない止まった子（同じ PC）は出さない', () => {
    expect(rowsOf(storeOf([session('p', { live: 'busy', startedAt: 1 }), session('c', { live: null, spawnedBy: 'p' })])).map((r) => r.id)).toEqual(['p']);
  });
  it('一覧の行は子の PC の名前を持つ（他の PC の会話一般は持たない）', () => {
    const rows = presentSessionList(initialState(), storeOf([session('p', { live: 'busy' }), remote('c'), session('o', { remoteOnly: true })]), NOW).rows;
    expect(rows.find((r) => r.id === 'c')!.peer).toEqual({ name: 'Mac', ended: false });
    expect(rows.find((r) => r.id === 'o')!.peer).toBeUndefined();
  });
});
