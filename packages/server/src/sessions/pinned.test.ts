import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { applyRemoteChange } from '../sync/apply.ts';
import { getSessionState, setSessionPinned, setSessionState } from './states.ts';

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'd' }, 'd');
  return db;
}
type Db = ReturnType<typeof seed>;
const pinned = (db: Db) => (db.prepare('select pinned_at from session_states where session_id = ?').get('s1') as { pinned_at: number | null } | undefined)?.pinned_at;
const lastSeq = (db: Db) => (db.prepare("select max(seq) s from changes where table_name = 'session_states'").get() as { s: number | null }).s;

describe('ピン留め（setSessionPinned）', () => {
  it('留めると時刻を書き、外すと null にする。状態の列には触らない', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 50 });
    setSessionPinned(db, 'd', 's1', true, 100);
    expect(pinned(db)).toBe(100);
    expect(getSessionState(db, 's1')?.status).toBe('done');
    setSessionPinned(db, 'd', 's1', false, 200);
    expect(pinned(db)).toBeNull();
    expect(getSessionState(db, 's1')?.status).toBe('done');
  });
  it('状態を変えても、ピンは残る', () => {
    const db = seed();
    setSessionPinned(db, 'd', 's1', true, 100);
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 150 });
    setSessionState(db, 'd', 's1', { status: null, setBy: 'user', now: 160 });
    expect(pinned(db)).toBe(100);
  });
  it('同じ向きに押し直しても書かない（留めた順が変わらない）', () => {
    const db = seed();
    setSessionPinned(db, 'd', 's1', true, 100);
    const seq = lastSeq(db);
    setSessionPinned(db, 'd', 's1', true, 200);
    expect(pinned(db)).toBe(100);
    expect(lastSeq(db)).toBe(seq);
  });
  it('行の無い会話を外しても、行を作らない', () => {
    const db = seed();
    setSessionPinned(db, 'd', 's1', false, 300);
    expect(pinned(db)).toBeUndefined();
  });
  it('同期の変更に載り、相手の PC で読める', () => {
    const a = seed();
    const b = seed();
    setSessionPinned(a, 'a', 's1', true, Date.now() + 1000);
    const sent = a.prepare("select payload, updated_at from changes where table_name = 'session_states' order by seq desc").get() as { payload: string; updated_at: number };
    expect(applyRemoteChange(b, { seq: 1, tableName: 'session_states', rowId: 's1', op: 'upsert', deviceId: 'a', updatedAt: sent.updated_at, payload: JSON.parse(sent.payload) }, { ownDeviceId: 'b', skipOwn: true })).toBe('applied');
    expect(pinned(b)).not.toBeNull();
    expect(pinned(b)).toBe(pinned(a));
  });
});
