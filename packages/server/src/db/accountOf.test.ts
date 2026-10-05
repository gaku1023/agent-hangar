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
});
