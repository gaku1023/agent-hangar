import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { getSession } from '../db/queries.ts';
import { addUnread, guardMutedUnread, noteUnread, onUnread } from '../live/unread.ts';
import { applyRemoteChange } from '../sync/apply.ts';
import { isSessionMuted, setSessionMuted, setSessionPinned, setSessionState } from './states.ts';

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'd' }, 'd');
  return db;
}
type Db = ReturnType<typeof seed>;
const muted = (db: Db) => (db.prepare('select muted_at from session_states where session_id = ?').get('s1') as { muted_at: number | null } | undefined)?.muted_at;
const unread = (db: Db) => (db.prepare('select count from session_unread where session_id = ?').get('s1') as { count: number } | undefined)?.count;
const lastSeq = (db: Db) => (db.prepare("select max(seq) s from changes where table_name = 'session_states'").get() as { s: number | null }).s;

describe('ミュート（setSessionMuted）', () => {
  it('ミュートすると時刻を書き、解除すると null にする。状態とピンの列には触らない', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 50 });
    setSessionPinned(db, 'd', 's1', true, 60);
    setSessionMuted(db, 'd', 's1', true, 100);
    expect(muted(db)).toBe(100);
    expect(isSessionMuted(db, 's1')).toBe(true);
    setSessionMuted(db, 'd', 's1', false, 200);
    expect(muted(db)).toBeNull();
    expect(isSessionMuted(db, 's1')).toBe(false);
    expect((db.prepare('select status, pinned_at from session_states where session_id = ?').get('s1') as { status: string; pinned_at: number }))
      .toEqual({ status: 'done', pinned_at: 60 });
  });
  it('同じ向きに押し直しても書かない', () => {
    const db = seed();
    setSessionMuted(db, 'd', 's1', true, 100);
    const seq = lastSeq(db);
    setSessionMuted(db, 'd', 's1', true, 200);
    expect(muted(db)).toBe(100);
    expect(lastSeq(db)).toBe(seq);
  });
  it('ミュートしたら、残っていた未読を消す', () => {
    const db = seed();
    addUnread(db, 's1', 'まえの知らせ', 10);
    setSessionMuted(db, 'd', 's1', true, 100);
    expect(unread(db)).toBeUndefined();
  });
  it('DTO の mutedAt に載る', () => {
    const db = seed();
    expect(getSession(db, [], 's1')?.mutedAt).toBeNull();
    setSessionMuted(db, 'd', 's1', true, 100);
    expect(getSession(db, [], 's1')?.mutedAt).toBe(100);
  });
  it('同期の変更に載り、相手の PC で読める', () => {
    const a = seed();
    const b = seed();
    setSessionMuted(a, 'a', 's1', true, Date.now() + 1000);
    const sent = a.prepare("select payload, updated_at from changes where table_name = 'session_states' order by seq desc").get() as { payload: string; updated_at: number };
    expect(applyRemoteChange(b, { seq: 1, tableName: 'session_states', rowId: 's1', op: 'upsert', deviceId: 'a', updatedAt: sent.updated_at, payload: JSON.parse(sent.payload) }, { ownDeviceId: 'b', skipOwn: true })).toBe('applied');
    expect(muted(b)).toBe(muted(a));
  });
  it('ミュートとピンを別の PC で同時に変えても、両方残る（事実ごとに合わせる）', () => {
    const a = seed();
    const b = seed();
    setSessionPinned(a, 'a', 's1', true, 1_000);
    const pa = a.prepare("select payload, updated_at from changes where table_name = 'session_states' order by seq desc").get() as { payload: string; updated_at: number };
    setSessionMuted(b, 'b', 's1', true, 900);
    applyRemoteChange(b, { seq: 1, tableName: 'session_states', rowId: 's1', op: 'upsert', deviceId: 'a', updatedAt: pa.updated_at, payload: JSON.parse(pa.payload) }, { ownDeviceId: 'b', skipOwn: true });
    expect(muted(b)).toBe(900);
    expect((b.prepare('select pinned_at from session_states where session_id = ?').get('s1') as { pinned_at: number }).pinned_at).toBe(1_000);
  });
});

describe('ミュートした会話の未読と知らせ（unread.ts の入口の守り）', () => {
  let off: (() => void)[] = [];
  afterEach(() => { for (const f of off) f(); off = []; });

  it('addUnread は積まず、今の数（0）を返す', () => {
    const db = seed();
    setSessionMuted(db, 'd', 's1', true, 100);
    expect(addUnread(db, 's1', '終わりました', 200)).toBe(0);
    expect(unread(db)).toBeUndefined();
  });
  it('noteUnread は購読へ渡さない。解除すると渡す', () => {
    const db = seed();
    off.push(guardMutedUnread((id) => isSessionMuted(db, id)));
    const got: string[] = [];
    off.push(onUnread((id) => { got.push(id); }));
    setSessionMuted(db, 'd', 's1', true, 100);
    noteUnread('s1', 'x', 0, ['os', 'phone']);
    expect(got).toEqual([]);
    setSessionMuted(db, 'd', 's1', false, 200);
    noteUnread('s1', 'x', 1, ['os', 'phone']);
    expect(got).toEqual(['s1']);
  });
});
