import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { aliveRunForSession, getRun, getTab, listActiveRuns, listAliveRuns, listTabs } from './queries.ts';

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd' }, 'd');
  upsertShared(db, 'runs', { id: 'r1', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-r1', pid: null, launch_params: '{}', started_at: 100, ended_at: null, end_reason: null, heartbeat_at: 100 }, 'd');
  upsertShared(db, 'runs', { id: 'r0', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-r0', pid: 5, launch_params: '{}', started_at: 50, ended_at: 60, end_reason: 'exited', heartbeat_at: 55 }, 'd');
  upsertShared(db, 'run_tabs', { id: 't1', run_id: 'r1', tmux_name: 'hangar-r1-t1', title: 'シェル 1', created_at: 101, closed_at: null }, 'd');
  upsertShared(db, 'run_tabs', { id: 't2', run_id: 'r1', tmux_name: 'hangar-r1-t2', title: 'シェル 2', created_at: 102, closed_at: 103 }, 'd');
  upsertShared(db, 'runs', { id: 'r2', session_id: 's1', device_id: 'd', kind: 'start', tmux_name: 'hangar-r2', pid: null, launch_params: '{}', started_at: 70, ended_at: 80, end_reason: 'exited', heartbeat_at: 75 }, 'd');
  upsertShared(db, 'run_tabs', { id: 't3', run_id: 'r2', tmux_name: 'hangar-r2-t1', title: 'シェル 1', created_at: 71, closed_at: null }, 'd');
  return db;
}

describe('runs/queries', () => {
  it('getRun と listAliveRuns と aliveRunForSession', () => {
    const db = seed();
    expect(getRun(db, 'r1')).toEqual({ id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 100, endedAt: null, endReason: null, heartbeatAt: 100 });
    expect(getRun(db, 'nope')).toBeNull();
    expect(listAliveRuns(db, 'd').map((r) => r.id)).toEqual(['r1']);
    expect(listAliveRuns(db, 'other')).toEqual([]);
    expect(listActiveRuns(db, 'd').map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(aliveRunForSession(db, 's1')?.id).toBe('r1');
    expect(aliveRunForSession(db, 's9')).toBeNull();
  });

  it('listTabs は agent タブを先頭に、閉じていないタブだけを返す', () => {
    const db = seed();
    expect(listTabs(db, 'r1')).toEqual([
      { id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 100, closedAt: null },
      { id: 't1', runId: 'r1', sessionId: 's1', kind: 'shell', title: 'シェル 1', tmuxName: 'hangar-r1-t1', createdAt: 101, closedAt: null },
    ]);
    expect(listTabs(db, 'nope')).toEqual([]);
  });

  it('getTab は run の id と run_tabs の id の両方を引き、閉じたタブは null', () => {
    const db = seed();
    expect(getTab(db, 'r1')?.kind).toBe('agent');
    expect(getTab(db, 't1')?.tmuxName).toBe('hangar-r1-t1');
    expect(getTab(db, 't2')).toBeNull();
    expect(getTab(db, 'nope')).toBeNull();
  });
});
