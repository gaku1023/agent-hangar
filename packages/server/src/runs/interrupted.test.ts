import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { getRun } from './queries.ts';
import { interruptedGroup, noteLastLive, pruneLastLive, recordInterruption, setInterruptedDismissed } from './interrupted.ts';

let db: Db;
const session = (id: string) => upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `u-${id}`, cwd: '/w', home_device: 'd' }, 'd');
const run = (id: string, sessionId: string, o: { startedAt?: number; endedAt?: number | null; reason?: string | null; account?: string; device?: string } = {}) =>
  upsertShared(db, 'runs', {
    id, session_id: sessionId, device_id: o.device ?? 'd', kind: 'start', tmux_name: `hangar-${id}`, pid: null,
    launch_params: JSON.stringify(o.account ? { account: o.account } : {}), started_at: o.startedAt ?? 1,
    ended_at: o.endedAt === undefined ? 50 : o.endedAt, end_reason: o.reason === undefined ? 'lost' : o.reason, heartbeat_at: 1,
  }, 'd');

beforeEach(() => {
  db = openDb(':memory:');
});

describe('中断の群', () => {
  it('記録した束を、止まる前の状態とアカウントと一緒に返す', () => {
    session('s1'); session('s2');
    run('r1', 's1', { account: 'univ' }); run('r2', 's2');
    noteLastLive(db, 'r1', 'busy', 10);
    recordInterruption(db, [getRun(db, 'r1')!, getRun(db, 'r2')!], 'restart', 100);
    expect(interruptedGroup(db)).toEqual({
      at: 100, cause: 'restart',
      items: [
        { sessionId: 's1', runId: 'r1', lastLive: 'busy', endedAt: 50, account: 'univ' },
        { sessionId: 's2', runId: 'r2', lastLive: null, endedAt: 50, account: null },
      ],
    });
  });

  it('束が空なら前の群を残す。新しい束は前の群を置き換える', () => {
    session('s1'); session('s2');
    run('r1', 's1'); run('r2', 's2');
    recordInterruption(db, [getRun(db, 'r1')!], 'restart', 100);
    recordInterruption(db, [], 'restart', 200);
    expect(interruptedGroup(db)?.items.map((i) => i.runId)).toEqual(['r1']);
    recordInterruption(db, [getRun(db, 'r2')!], 'mux', 300);
    expect(interruptedGroup(db)).toMatchObject({ at: 300, cause: 'mux', items: [{ runId: 'r2' }] });
  });

  it('再開しないと決めた行は出さず、元に戻せば出る。全部が消えたら null', () => {
    session('s1'); session('s2');
    run('r1', 's1'); run('r2', 's2');
    recordInterruption(db, [getRun(db, 'r1')!, getRun(db, 'r2')!], 'restart', 100);
    setInterruptedDismissed(db, ['r1'], true, 150);
    expect(interruptedGroup(db)?.items.map((i) => i.runId)).toEqual(['r2']);
    setInterruptedDismissed(db, ['r1'], false, 160);
    expect(interruptedGroup(db)?.items.map((i) => i.runId)).toEqual(['r1', 'r2']);
    setInterruptedDismissed(db, ['r1', 'r2'], true, 170);
    expect(interruptedGroup(db)).toBeNull();
  });

  it('後から起こし直したセッションと、消したセッションは出さない', () => {
    session('s1'); session('s2'); session('s3');
    run('r1', 's1'); run('r2', 's2'); run('r3', 's3');
    recordInterruption(db, [getRun(db, 'r1')!, getRun(db, 'r2')!, getRun(db, 'r3')!], 'restart', 100);
    // s1 はあとで再開して、普通に終わった。
    run('r1b', 's1', { startedAt: 120, endedAt: 130, reason: 'exited' });
    upsertShared(db, 'sessions', { id: 's3', provider: 'claude-code', provider_session_id: 'u-s3', cwd: '/w', home_device: 'd', deleted_at: 140 }, 'd');
    expect(interruptedGroup(db)?.items.map((i) => i.runId)).toEqual(['r2']);
  });

  it('止まる前の状態は run ごとに最後の値だけを持ち、生きた run の外は捨てる', () => {
    session('s1');
    run('r1', 's1', { endedAt: null, reason: null });
    noteLastLive(db, 'r1', 'busy', 10);
    noteLastLive(db, 'r1', 'waiting', 20);
    noteLastLive(db, 'rx', 'idle', 20);
    pruneLastLive(db, ['r1']);
    expect(db.prepare('select run_id, status, at from run_last_live').all()).toEqual([{ run_id: 'r1', status: 'waiting', at: 20 }]);
  });
});
