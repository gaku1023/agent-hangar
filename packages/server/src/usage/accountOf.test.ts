import { PRIMARY_ACCOUNT_ID } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { accountOfProviderSession } from './accountOf.ts';

describe('statusline の payload のアカウント', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  let db: Db;
  let s1: string;
  beforeEach(() => {
    db = openDb(':memory:');
    s1 = ensureSession(db, UUID, '/w', 'd');
  });
  afterEach(() => { db.close(); });
  const run = (id: string, startedAt: number, account: string) =>
    upsertShared(db, 'runs', { id, session_id: s1, device_id: 'd', kind: 'start', tmux_name: `t-${id}`, pid: null, launch_params: JSON.stringify({ account }), started_at: startedAt, ended_at: startedAt + 1, end_reason: 'exited', heartbeat_at: startedAt }, 'd');
  const of = (uuid: string | null, known: string[] = ['a1']) => accountOfProviderSession({ db, hasAccount: (id) => known.includes(id) }, uuid);

  it('セッションの最後の run のアカウントを返す', () => {
    run('r1', 10, 'a1');
    expect(of(UUID)).toBe('a1');
  });

  it('hangar の外で起こしたセッションと、セッションの分からない payload は、最初のアカウントとして数える', () => {
    expect(of(UUID)).toBe(PRIMARY_ACCOUNT_ID);
    expect(of(null)).toBe(PRIMARY_ACCOUNT_ID);
    expect(of('99999999-9999-4999-8999-999999999999')).toBe(PRIMARY_ACCOUNT_ID);
  });

  it('消したアカウントの run は、最初のアカウントとして数える', () => {
    run('r1', 10, 'gone');
    expect(of(UUID)).toBe(PRIMARY_ACCOUNT_ID);
  });

  it('消したセッションは引かない', () => {
    run('r1', 10, 'a1');
    softDeleteShared(db, 'sessions', s1, 'd');
    expect(of(UUID)).toBe(PRIMARY_ACCOUNT_ID);
  });
});
