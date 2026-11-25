import { SHARED_TABLES } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { closeRemoteTab, getRemoteHost, getRemoteTab, insertRemoteTab, listOpenRemoteTabs, listPendingKills, markKillDone, setKillPending, setRemoteHost } from './store.ts';

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

const tab = (id: string, extra: Partial<Parameters<typeof insertRemoteTab>[1]> = {}) => insertRemoteTab(db, { id, sessionId: 's1', deviceId: 'dev', remoteName: `hangar-ssh-${id}`, title: 'shell', createdAt: 10, ...extra });

describe('remote_tabs', () => {
  it('入れて読める。閉じるまでは closedAt が null', () => {
    tab('t1');
    expect(getRemoteTab(db, 't1')).toEqual({ id: 't1', sessionId: 's1', deviceId: 'dev', remoteName: 'hangar-ssh-t1', title: 'shell', createdAt: 10, closedAt: null, killPending: false });
    expect(getRemoteTab(db, 'nope')).toBeNull();
  });

  it('開いているタブは会話で絞れ、古い順に返る。閉じたものは含まない', () => {
    tab('t2', { createdAt: 20 }); tab('t1', { createdAt: 10 }); tab('t3', { sessionId: 's2', createdAt: 15 });
    expect(listOpenRemoteTabs(db).map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    expect(listOpenRemoteTabs(db, 's1').map((t) => t.id)).toEqual(['t1', 't2']);
    closeRemoteTab(db, 't1', 99);
    expect(listOpenRemoteTabs(db, 's1').map((t) => t.id)).toEqual(['t2']);
    expect(getRemoteTab(db, 't1')?.closedAt).toBe(99);
  });

  it('閉じるのは 1 回目の時刻を保つ', () => {
    tab('t1');
    closeRemoteTab(db, 't1', 50);
    closeRemoteTab(db, 't1', 60);
    expect(getRemoteTab(db, 't1')?.closedAt).toBe(50);
  });

  it('kill_pending は立てて、一覧で引け、済んだら下りる', () => {
    tab('t1'); tab('t2');
    closeRemoteTab(db, 't1', 5);
    setKillPending(db, 't1', true);
    expect(getRemoteTab(db, 't1')?.killPending).toBe(true);
    expect(listPendingKills(db, 'dev').map((t) => t.id)).toEqual(['t1']);
    expect(listPendingKills(db, 'other')).toEqual([]);
    markKillDone(db, 't1');
    expect(listPendingKills(db, 'dev')).toEqual([]);
  });
});

describe('remote_ssh_hosts', () => {
  it('上書きの Host 名を置いて読み、消せる', () => {
    expect(getRemoteHost(db, 'dev')).toBeNull();
    setRemoteHost(db, 'dev', 'win-box', 1);
    setRemoteHost(db, 'dev', 'win-box2', 2);
    expect(getRemoteHost(db, 'dev')).toBe('win-box2');
    setRemoteHost(db, 'dev', null, 3);
    expect(getRemoteHost(db, 'dev')).toBeNull();
  });
});

describe('同期に載らない', () => {
  it('SHARED_TABLES に無く、書いても changes に行が増えない', () => {
    expect(SHARED_TABLES).not.toContain('remote_tabs');
    expect(SHARED_TABLES).not.toContain('remote_ssh_hosts');
    const before = (db.prepare('select count(*) c from changes').get() as { c: number }).c;
    tab('t1'); setRemoteHost(db, 'dev', 'h', 1); closeRemoteTab(db, 't1', 2);
    expect((db.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(before);
  });
});
