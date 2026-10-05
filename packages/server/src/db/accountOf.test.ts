import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './open.ts';
import { accountOfSession, sessionAccounts } from './queries.ts';
import { upsertShared } from './shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';

let db: Db;
let s1: string;
let s2: string;
const run = (id: string, sessionId: string, startedAt: number, params: unknown) =>
  upsertShared(db, 'runs', { id, session_id: sessionId, device_id: 'd', kind: 'start', tmux_name: `t-${id}`, pid: null, launch_params: typeof params === 'string' ? params : JSON.stringify(params), started_at: startedAt, ended_at: startedAt + 1, end_reason: 'exited', heartbeat_at: startedAt }, 'd');

beforeEach(() => {
  db = openDb(':memory:');
  s1 = ensureSession(db, '11111111-1111-4111-8111-111111111111', '/w', 'd');
  s2 = ensureSession(db, '22222222-2222-4222-8222-222222222222', '/w', 'd');
});

describe('accountOfSession', () => {
  it('run が無ければ null', () => expect(accountOfSession(db, s1)).toBeNull());
  it('最後の run のアカウントを返す。アカウントの無い run は null', () => {
    run('r1', s1, 10, { account: 'a1' });
    expect(accountOfSession(db, s1)).toBe('a1');
    run('r2', s1, 20, { projectId: 'p' });
    expect(accountOfSession(db, s1)).toBeNull();
    run('r3', s1, 30, { account: 'primary' });
    expect(accountOfSession(db, s1)).toBe('primary');
  });
  it('壊れた launch_params は null', () => {
    run('r1', s1, 10, '{ not json');
    expect(accountOfSession(db, s1)).toBeNull();
  });
});

describe('sessionAccounts', () => {
  it('最後の run が primary 以外のセッションだけを載せる', () => {
    run('r1', s1, 10, { account: 'a1' });
    run('r2', s2, 10, { account: 'a1' });
    run('r3', s2, 20, { account: 'primary' });
    expect(sessionAccounts(db)).toEqual({ [s1]: 'a1' });
  });
  it('最後の run にアカウントが無いセッションは載せない', () => {
    run('r1', s1, 10, { account: 'a1' });
    run('r2', s1, 20, { projectId: 'p' });
    expect(sessionAccounts(db)).toEqual({});
  });
  it('古い run にだけアカウントがあるセッションは載せない', () => {
    run('r1', s1, 10, { account: 'a1' });
    run('r2', s1, 20, '{ not json');
    run('r3', s2, 10, { account: 'a2' });
    expect(sessionAccounts(db)).toEqual({ [s2]: 'a2' });
  });
  it('同じ started_at の 2 run は id の大きい方を最後とする', () => {
    run('r1', s1, 10, { account: 'a1' });
    run('r2', s1, 10, { account: 'a2' });
    run('r4', s2, 10, { account: 'primary' });
    run('r3', s2, 10, { account: 'a1' });
    expect(sessionAccounts(db)).toEqual({ [s1]: 'a2' });
  });
  it('削除した run は最後に数えない', () => {
    run('r1', s1, 10, { account: 'a1' });
    run('r2', s1, 20, { account: 'a2' });
    db.prepare('update runs set deleted_at = 1 where id = ?').run('r2');
    expect(sessionAccounts(db)).toEqual({ [s1]: 'a1' });
  });
  it('run が 10,000 件あっても 200 ms を切る', () => {
    const ins = db.prepare(`insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, started_at, ended_at, end_reason, heartbeat_at, updated_at, origin_device)
      values (?, ?, 'd', 'start', ?, ?, ?, ?, 'exited', ?, 1, 'd')`);
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const sid = i % 2 === 0 ? s1 : s2;
        ins.run(`bulk-${i}`, sid, `t-${i}`, JSON.stringify({ account: i % 3 === 0 ? 'a1' : 'primary' }), 1000 + i, 1001 + i, 1000 + i);
      }
    })();
    const t0 = performance.now();
    const out = sessionAccounts(db);
    const ms = performance.now() - t0;
    expect(out).toEqual({ [s2]: 'a1' });
    expect(ms).toBeLessThan(200);
  });
});

describe('runs の索引', () => {
  it('accountOfSession は (session_id, started_at) の索引で引く', () => {
    const plan = db.prepare("explain query plan select launch_params from runs where session_id = ? and deleted_at is null order by started_at desc, id desc limit 1").all(s1) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('runs_session_started');
  });
});
