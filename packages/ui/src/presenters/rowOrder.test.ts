import { describe, expect, it } from 'vitest';
import type { SessionDto, SessionStateDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { dueOn, matchesStatus, presentSessionRow, returnKey, sortForList, type SessionRowProps } from './row.ts';

/** 2026-10-02（金）の朝 9 時。 */
const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const DAY = 24 * H;
const IMPORT_AT = new Date(2026, 9, 1, 8, 0).getTime();

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: id, oneLiner: '', projectName: 'agent-hangar', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '', whenAbs: '', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const paused = (id: string, returnOn: string | null, over: Partial<SessionRowProps> = {}) => row(id, { state: 'paused', returnOn, setBy: 'user', ...over });
const cand = (status: 'paused' | 'done') => ({ status, note: '直した', returnOn: status === 'paused' ? '2026-10-03' : null, returnTime: null, source: 'in_session' as const, ago: '1 時間前' });

describe('区切りを付けて休みのまま残っているもの（parked）の行', () => {
  const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null, ...o });
  const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 2 * H, lastActivityAt: NOW - H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
  const withRun = (sessionId: string): Store => ({ ...initialStore(), runs: { r1: { id: 'r1', sessionId, deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: NOW - 2 * H, endedAt: null, endReason: null, heartbeatAt: NOW } } });

  it('行は終わったものと同じに作る。灯を出さず、Active ではなく状態のタブに入る', () => {
    const s = dto('p', { live: 'idle', parked: true, state: st({ status: 'paused', note: '明日見る', returnOn: '2026-10-05', setBy: 'conversation', setAt: NOW - H }) });
    const r = presentSessionRow(s, withRun('p'), NOW);
    expect([r.live, r.runId, r.state]).toEqual([null, null, 'paused']);
    expect(matchesStatus(r, 'active')).toBe(false);
    expect(matchesStatus(r, 'paused')).toBe(true);
  });
  it('印が付いていても、作業中の行は灯と実行の印を残す', () => {
    const s = dto('p', { live: 'busy', state: st({ status: 'paused', note: '明日見る', returnOn: '2026-10-05', setBy: 'conversation', setAt: NOW - H }) });
    const r = presentSessionRow(s, withRun('p'), NOW);
    expect([r.live, r.runId]).toEqual(['busy', 'r1']);
    // Active は状態の無いものなので、印の付いた行は動いていても Paused に入る。
    expect(matchesStatus(r, 'active')).toBe(false);
    expect(matchesStatus(r, 'paused')).toBe(true);
  });
  it('並びでも、動いているものより後ろに置く。Done は Done にした時刻の新しい順に並ぶ', () => {
    const done = (id: string, setAt: number, over: Partial<SessionDto> = {}) => dto(id, { state: st({ status: 'done', setBy: 'user', setAt }), ...over });
    const list = [done('old', NOW - 3 * H), done('parked', NOW - 2.5 * H, { live: 'idle', parked: true, lastActivityAt: NOW - 60_000 }), dto('idle', { live: 'idle' }), done('mid', NOW - 2 * H)];
    expect(sortForList(list).map((x) => x.id)).toEqual(['idle', 'mid', 'parked', 'old']);
  });
});

describe('戻る日が壊れた Paused', () => {
  it('dueOn は、欠けた日と暦に無い日と形の違う日を、戻る日が来たものに数える', () => {
    expect(dueOn('2026-10-02', '2026-10-02')).toBe(true);
    expect(dueOn('2026-10-03', '2026-10-02')).toBe(false);
    for (const bad of [null, '2026-02-30', 'いつか']) expect(dueOn(bad, '2026-10-02')).toBe(true);
  });
  it('returnKey は正しい戻る日に時刻（無ければその日の最後）を添え、欠けた日と壊れた日を空にする（Home が使い回す）', () => {
    expect(returnKey(paused('a', '2026-10-05'))).toBe('2026-10-05 24:00');
    expect(returnKey(paused('b', null))).toBe('');
    expect(returnKey(paused('c', 'いつか'))).toBe('');
    expect(returnKey(paused('d', '2026-02-30'))).toBe('');
  });
});

describe('matchesStatus（タブの絞り込み）', () => {
  it('行の持ち物だけで決める。Active は状態が無いもので、動きも提案も問わない', () => {
    const liveDone = row('l', { live: 'idle', state: 'done' });
    expect(matchesStatus(liveDone, 'active')).toBe(false);
    expect(matchesStatus(liveDone, 'done')).toBe(true);
    expect(matchesStatus(row('b', { runId: 'r1' }), 'active')).toBe(true);
    expect(matchesStatus(row('n'), 'active')).toBe(true);
    expect(matchesStatus(row('c', { candidate: cand('done') }), 'proposed')).toBe(true);
    expect(matchesStatus(row('c', { candidate: cand('done') }), 'active')).toBe(true);
    expect(matchesStatus(paused('p', '2026-10-09'), 'paused')).toBe(true);
    expect(matchesStatus(paused('p', '2026-10-09'), 'active')).toBe(false);
    expect(matchesStatus(row('z', { state: 'archived' }), 'archived')).toBe(true);
  });
});

describe('sortForList', () => {
  const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null, ...o });
  const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: NOW - H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
  // 確定した行や手で Done にした行は、最後に動いた時刻が古くても Done の節の先頭に来る。畳んだ中に消えないように。
  it('Done の行は Done にした時刻の新しい順、導入時の一括（同じ時刻）の中は最後に動いた時刻の新しい順', () => {
    const list = [
      dto('imp-old', { lastActivityAt: NOW - 3 * DAY, state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
      dto('open', { lastActivityAt: NOW - 2 * H }),
      dto('confirmed', { lastActivityAt: NOW - 10 * DAY, state: st({ status: 'done', setBy: 'user', setAt: NOW - 60_000 }) }),
      dto('imp-new', { lastActivityAt: NOW - DAY, state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
      dto('live', { live: 'busy', lastActivityAt: NOW - 5 * DAY, state: st({ status: 'done', setBy: 'user', setAt: NOW }) }),
      dto('older', { lastActivityAt: NOW - 4 * DAY }),
    ];
    const ids = sortForList(list).map((s) => s.id);
    expect(ids[0]).toBe('live');
    expect(ids.filter((id) => ['confirmed', 'imp-new', 'imp-old'].includes(id))).toEqual(['confirmed', 'imp-new', 'imp-old']);
    expect(ids.filter((id) => ['open', 'older'].includes(id))).toEqual(['open', 'older']);
  });
});

