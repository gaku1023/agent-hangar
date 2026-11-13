import { describe, expect, it } from 'vitest';
import type { SessionDto, SessionLockDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { aliveAnywhere, initialStore, runningSessionIds, type Store } from '../store/store.ts';
import { presentHome } from './home.ts';
import { liveCountsOf } from './projects.ts';
import { presentSessionList } from './sessions.ts';
import { presentShell } from './shell.ts';

// ほかの PC で動いている会話（lock を持つもの）を、この PC の実行中と同じに数え、PC の札つきで出す。

const NOW = Date.parse('2026-10-07T12:00:00Z');
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: 'name-' + id, cwd: '/w', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 180_000, lastTurnAt: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, pinnedAt: null, unread: null, spawnedBy: null, spawnPeer: null, ...over });
const lock = (over: Partial<SessionLockDto> = {}): SessionLockDto => ({ deviceId: 'd2', deviceName: 'Office', runId: 'r9', heartbeatAt: NOW - 1000, stale: false, ...over });
const storeOf = (list: SessionDto[]): Store => {
  const s = initialStore();
  s.bootstrapped = true;
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  return s;
};
const rowsOf = (store: Store) => presentShell(initialState(), store, NOW).live.groups.flatMap((g) => g.rows);

describe('aliveAnywhere', () => {
  it('この PC の生きた run と、ほかの PC のロックのある会話を数える。runningSessionIds は変えない', () => {
    const store = storeOf([session('a'), session('b', { lock: lock() }), session('c')]);
    store.runs = { r1: { id: 'r1', sessionId: 'a', endedAt: null } as never, r2: { id: 'r2', sessionId: 'c', endedAt: 5 } as never };
    expect([...aliveAnywhere(store)].sort()).toEqual(['a', 'b']);
    expect([...runningSessionIds(store)]).toEqual(['a']);
  });
});

describe('サイドバーの実行中に、ほかの PC の会話が混ざる', () => {
  it('同じプロジェクトの群に、始めた順で混ざり、PC の札と灰の点（idle）を持つ', () => {
    const store = storeOf([session('a', { live: 'busy', startedAt: 1 }), session('b', { lock: lock(), startedAt: 2 }), session('c', { live: 'busy', startedAt: 3 })]);
    const live = presentShell(initialState(), store, NOW).live;
    expect(live.groups).toHaveLength(1);
    expect(live.groups[0]!.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(live.count).toBe(3);
    const b = live.rows.find((r) => r.id === 'b')!;
    expect(b.peer).toEqual({ name: 'Office', ended: false });
    expect(b.live).toBe('idle');
    expect(b.waited).toBeNull();
    expect(b.stale).toBeUndefined();
    expect(live.rows.find((r) => r.id === 'a')!.peer).toBeUndefined();
  });
  it('黙った PC の行は残り、stale と ended の印を持つ。title は既存の文言', () => {
    const b = rowsOf(storeOf([session('b', { lock: lock({ stale: true }) })]))[0]!;
    expect(b.peer).toEqual({ name: 'Office', ended: true });
    expect(b.stale).toBe(true);
    expect(b.lockTitle).toBe('Office から応答がありません');
    expect(rowsOf(storeOf([session('b', { lock: lock() })]))[0]!.lockTitle).toBe('Office で実行中');
  });
  it('ロックが消えれば行も消える', () => {
    expect(rowsOf(storeOf([session('b', { lock: null })]))).toEqual([]);
  });
  it('この PC の run が生きていれば、札は付けない', () => {
    const store = storeOf([session('b', { lock: lock(), live: 'busy' })]);
    store.runs = { r1: { id: 'r1', sessionId: 'b', endedAt: null } as never };
    const b = rowsOf(store)[0]!;
    expect(b.peer).toBeUndefined();
    expect(b.live).toBe('busy');
  });
  it('ロックを持つ別の PC の子は、親の下に 1 回だけ出る', () => {
    const store = storeOf([session('p', { live: 'busy', startedAt: 1 }), session('c', { lock: lock(), spawnedBy: 'p', startedAt: 2, spawnPeer: { parent: null, child: 'Mac', closed: false } })]);
    const rows = presentShell(initialState(), store, NOW).live.groups[0]!.rows;
    expect(rows.map((r) => [r.id, r.depth ?? 0])).toEqual([['p', 0], ['c', 1]]);
    expect(rows[1]!.peer).toEqual({ name: 'Office', ended: false });
  });
});

describe('設定 sidebarOtherPcs', () => {
  const withSetting = (v: boolean | undefined) => {
    const store = storeOf([session('a', { live: 'busy', startedAt: 1 }), session('b', { lock: lock(), startedAt: 2 }), session('p', { live: 'busy', startedAt: 3 }), session('c', { live: null, spawnedBy: 'p', startedAt: 4, spawnPeer: { parent: null, child: 'Mac', closed: false } })]);
    return v === undefined ? store : { ...store, settings: { sidebarOtherPcs: v } as never };
  };
  it('切なら、ロックで足した行は出さない。親の下の別の PC の子は出す', () => {
    expect(rowsOf(withSetting(false)).map((r) => r.id)).toEqual(['a', 'p', 'c']);
  });
  it('入りでも、未設定でも、出る', () => {
    expect(rowsOf(withSetting(true)).map((r) => r.id)).toEqual(['a', 'b', 'p', 'c']);
    expect(rowsOf(withSetting(undefined)).map((r) => r.id)).toEqual(['a', 'b', 'p', 'c']);
  });
  it('切でも、Home とプロジェクトの数には数える', () => {
    const store = withSetting(false);
    expect(liveCountsOf(store, 'alpha').running).toBeGreaterThanOrEqual(1);
    expect(presentHome(initialState(), store, NOW).running.map((c) => c.id)).toContain('b');
  });
});

describe('数をそろえる', () => {
  it('プロジェクトの実行中と、一覧の live の絞り込みと、Home の実行中に数える', () => {
    const store = storeOf([session('b', { lock: lock() }), session('x')]);
    expect(liveCountsOf(store, 'alpha')).toEqual({ running: 1, waiting: 0 });
    const state = initialState();
    const list = presentSessionList({ ...state, search: { ...state.search, filter: { live: 'running' } } }, store, NOW);
    expect(list.rows.map((r) => r.id)).toEqual(['b']);
    const home = presentHome(state, store, NOW);
    expect(home.running.map((c) => c.id)).toEqual(['b']);
    expect(home.running[0]!.idleFor).toBeNull();
    expect(home.running[0]!.note).toBeNull();
  });
});
