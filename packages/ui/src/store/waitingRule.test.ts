import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto, SessionStateDto, SessionStatus } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { presentHome } from '../presenters/home.ts';
import { presentPalette } from '../presenters/palette.ts';
import { presentProjects } from '../presenters/projects.ts';
import { presentSessionRow } from '../presenters/row.ts';
import { presentShell } from '../presenters/shell.ts';
import { awaitsAnswer, initialStore, liveFilterOfSession, nextWaitingSession, shownLive, waitingSessionIds, type Store } from './store.ts';

/**
 * 入力待ちの数え方の規則。
 * 問いで待っている最中に Done や Archived にしたセッションは、Claude が止まらず live が waiting のまま残るが、利用者の注意を求める数や印には入れない。
 * 数や印は、どの画面でも同じ 1 つの規則（quietLive）を通す。
 */
const NOW = 1_800_000_000_000;
const stateOf = (status: SessionStatus | null): SessionStateDto | null => (status === null ? null : { status, note: null, returnOn: status === 'paused' ? '2027-01-01' : null, returnTime: null, setBy: 'user', setAt: NOW - 1000, candidate: null });
const session = (id: string, live: SessionDto['live'], status: SessionStatus | null = null, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: `u-${id}`, projectId: 'alpha', name: `name-${id}`, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, live, lastActivityAt: NOW - 60_000, lastTurnAt: null, startedAt: NOW - 600_000, hasTranscript: true, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: stateOf(status), parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, ...over });
const project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW - 3_600_000, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const storeWith = (list: SessionDto[]): Store => ({ ...initialStore(), bootstrapped: true, projects: { alpha: project('alpha') }, sessions: Object.fromEntries(list.map((s) => [s.id, s])) });

// 問いで待っている最中に区切りを付けた 2 つと、区切りの無い 1 つ、Paused の 1 つ。
const list = [session('d', 'waiting', 'done'), session('a', 'waiting', 'archived'), session('w', 'waiting'), session('p', 'waiting', 'paused')];
const store = storeWith(list);

describe('Done と Archived で live が waiting のセッションは、入力待ちの数や印に入らない', () => {
  it('awaitsAnswer と waitingSessionIds と次の入力待ち', () => {
    expect(list.map((s) => [s.id, awaitsAnswer(s)])).toEqual([['d', false], ['a', false], ['w', true], ['p', true]]);
    expect(waitingSessionIds(store).sort()).toEqual(['p', 'w']);
    expect(nextWaitingSession(storeWith([session('d', 'waiting', 'done')]), null)).toBeNull();
  });
  it('画面で数える状態（liveFilterOfSession）は、入力待ちでなく実行中（休み）に数える', () => {
    expect(list.map((s) => [s.id, liveFilterOfSession(store, s)])).toEqual([['d', 'running'], ['a', 'running'], ['w', 'waiting'], ['p', 'waiting']]);
  });
  it('一覧の行の動き（shownLive）は休みで、入力待ちの札を付けない', () => {
    expect(list.map((s) => [s.id, shownLive(s)])).toEqual([['d', 'idle'], ['a', 'idle'], ['w', 'waiting'], ['p', 'waiting']]);
    expect(presentSessionRow(list[0]!, store, NOW).live).toBe('idle');
    expect(presentSessionRow(list[2]!, store, NOW).live).toBe('waiting');
  });
  it('プロジェクト一覧の「いま」の入力待ちの数', () => {
    const now = presentProjects(initialState(), store, NOW, '', false).sections[0]!.rows[0]!.now;
    expect(now.find((n) => n.kind === 'waiting')).toMatchObject({ text: '入力待ち 2' });
    const quiet = storeWith([session('d', 'waiting', 'done'), session('a', 'waiting', 'archived')]);
    expect(presentProjects(initialState(), quiet, NOW, '', false).sections[0]!.rows[0]!.now.map((n) => n.kind)).not.toContain('waiting');
  });
  it('ホームの要対応と、実行中の札', () => {
    const home = presentHome(initialState(), store, NOW);
    expect(home.attention.map((c) => c.id).sort()).toEqual(['p', 'w']);
    // 動いてはいるので、実行中の札には休みとして入る。入力待ちの点は付けない。
    expect(home.running.map((c) => [c.id, c.live]).sort()).toEqual([['a', 'idle'], ['d', 'idle']]);
  });
  it('サイドバーの行は残すが、入力待ちの言葉も点も付けない', () => {
    const rows = presentShell(initialState(), store, NOW).live.rows;
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'd', 'p', 'w']);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.d).toMatchObject({ live: 'idle', waited: null });
    expect(by.a).toMatchObject({ live: 'idle', waited: null });
    expect(by.w).toMatchObject({ live: 'waiting', waited: '入力待ち 1 分' });
    expect(by.p).toMatchObject({ live: 'waiting' });
  });
  it('ヘッダーの入力待ちの数（Home の項目の錠剤）', () => {
    const nav = presentShell(initialState(), store, NOW).nav;
    expect(nav.find((n) => n.route.name === 'home')).toMatchObject({ count: 2 });
  });
  it('コマンドパレットは、入力待ちの群にも「入力待ち」の語にも入れない', () => {
    const p = presentPalette({ ...initialState(), overlay: { kind: 'palette' } }, store, 'name', NOW)!;
    const waitingGroup = p.sections.find((g) => g.title === '要対応')!;
    expect(waitingGroup.items.map((i) => i.id).sort()).toEqual(['session:p', 'session:w']);
    const rows = p.sections.flatMap((g) => g.items).filter((i) => i.kind === 'session');
    const meta = Object.fromEntries(rows.map((i) => [i.id, i.meta]));
    expect(meta['session:d']).not.toContain('入力待ち');
    expect(meta['session:a']).not.toContain('入力待ち');
    expect(meta['session:w']).toContain('入力待ち');
  });
});
