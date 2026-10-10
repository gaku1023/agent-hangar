import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { SyncStateStore } from './state.ts';

describe('SyncStateStore', () => {
  it('文字列、数値、真偽、null を往復する', () => {
    const s = new SyncStateStore(openDb(':memory:'));
    expect(s.get('lastSeq')).toBeNull();
    expect(s.getNumber('lastSeq', 0)).toBe(0);
    s.set('lastSeq', 42);
    expect(s.getNumber('lastSeq', 0)).toBe(42);
    s.set('paused', true);
    expect(s.get('paused')).toBe('1');
    s.set('paused', false);
    expect(s.get('paused')).toBe('0');
    s.set('lastError', 'x');
    s.set('lastError', null);
    expect(s.get('lastError')).toBeNull();
  });
  it('譲ったセッションの記録', () => {
    const s = new SyncStateStore(openDb(':memory:'));
    expect(s.isYielded('u1')).toBe(false);
    s.setYielded('u1', true);
    expect(s.isYielded('u1')).toBe(true);
    s.setYielded('u1', false);
    expect(s.isYielded('u1')).toBe(false);
  });
  it('読めない値は既定へ落とし、同じ鍵は上書きになる', () => {
    const db = openDb(':memory:');
    const s = new SyncStateStore(db);
    db.prepare('insert into sync_state (key, value) values (?, ?)').run('filesSeq', 'abc');
    expect(s.getNumber('filesSeq', 7)).toBe(7);
    s.set('filesSeq', 1);
    s.set('filesSeq', 2);
    expect(s.getNumber('filesSeq', 0)).toBe(2);
    expect((db.prepare('select count(*) c from sync_state').get() as { c: number }).c).toBe(1);
  });
});
