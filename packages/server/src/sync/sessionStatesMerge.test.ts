import type { ChangeOut } from '@agent-hangar/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { getSessionState, proposeSessionState, setSessionPinned, setSessionPlacement, setSessionState } from '../sessions/states.ts';
import { applyRemoteBatch } from './apply.ts';

/**
 * session_states の 1 行には、独立した事実（状態、提案、移した先、ピン、削除の印）が入っている。
 * 同期が届く前に 2 台が別の事実を書いても、どちらの事実も残ることを確かめる（事実ごとの後勝ち）。
 */

type Db = ReturnType<typeof openDb>;

function seed(): Db {
  const db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'a' }, 'a');
  db.prepare('update changes set pushed_at = 1').run();
  return db;
}

/** この PC が積んだ、まだ上げていない session_states の変更を、届く形にして上げた印を付ける。 */
function push(from: Db): ChangeOut[] {
  const rows = from.prepare("select seq, table_name, row_id, op, payload, updated_at, device_id from changes where table_name = 'session_states' and pushed_at is null order by seq").all() as { seq: number; table_name: string; row_id: string; op: 'upsert' | 'delete'; payload: string; updated_at: number; device_id: string }[];
  from.prepare('update changes set pushed_at = 1 where pushed_at is null').run();
  return rows.map((r) => ({ seq: r.seq, tableName: r.table_name as ChangeOut['tableName'], op: r.op, deviceId: r.device_id, rowId: r.row_id, updatedAt: r.updated_at, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

/** クラウドの代わり。行ごとの後勝ちで 1 行だけ持つ（packages/cloud/src/changes.ts と同じ決め方）。同じ時刻なら先に着いた方を残す。 */
class Cloud {
  row: ChangeOut | null = null;
  up(changes: ChangeOut[]): void {
    for (const c of changes) if (!this.row || c.updatedAt > this.row.updatedAt) this.row = c;
  }
}

/** 2 台が上げ下げを繰り返し、どちらも何も上げなくなる（往復が止まる）ことまで確かめる。 */
function settle(cloud: Cloud, pcs: { db: Db; id: string }[]): void {
  for (let i = 0; i < 6; i++) {
    let moved = false;
    for (const pc of pcs) {
      const out = push(pc.db);
      if (out.length > 0) moved = true;
      cloud.up(out);
      if (cloud.row && cloud.row.deviceId !== pc.id) applyRemoteBatch(pc.db, [cloud.row], { ownDeviceId: pc.id, skipOwn: true });
    }
    const pending = pcs.some((pc) => (pc.db.prepare("select count(*) n from changes where table_name = 'session_states' and pushed_at is null").get() as { n: number }).n > 0);
    if (!moved && !pending) return;
  }
  throw new Error('収束しない');
}

const pinnedAt = (db: Db) => (db.prepare("select pinned_at from session_states where session_id = 's1'").get() as { pinned_at: number | null }).pinned_at;
const projectOf = (db: Db) => (db.prepare("select project_id from session_states where session_id = 's1'").get() as { project_id: string | null }).project_id;

afterEach(() => { vi.useRealTimers(); });

describe('session_states は事実ごとに新しい方を採る', () => {
  it('A がピンを留め、同期が届く前に B が Done にしても、両方が残る（A が先に上げた場合）', () => {
    vi.useFakeTimers();
    const a = seed(), b = seed();
    const cloud = new Cloud();
    vi.setSystemTime(1_000);
    setSessionPinned(a, 'a', 's1', true, 1_000);
    cloud.up(push(a));
    vi.setSystemTime(2_000);
    setSessionState(b, 'b', 's1', { status: 'done', setBy: 'user', now: 2_000 });
    // B は自分の行を上げる前に、A の古い行を受け取る。
    applyRemoteBatch(b, [cloud.row!], { ownDeviceId: 'b', skipOwn: true });
    vi.setSystemTime(3_000);
    settle(cloud, [{ db: a, id: 'a' }, { db: b, id: 'b' }]);
    for (const db of [a, b]) {
      expect(getSessionState(db, 's1')?.status).toBe('done');
      expect(pinnedAt(db)).toBe(1_000);
    }
  });

  it('B が先に上げ、A が後から新しい行を受け取っても、A のピンは消えない', () => {
    vi.useFakeTimers();
    const a = seed(), b = seed();
    const cloud = new Cloud();
    vi.setSystemTime(1_000);
    setSessionPinned(a, 'a', 's1', true, 1_000);
    vi.setSystemTime(2_000);
    setSessionState(b, 'b', 's1', { status: 'done', setBy: 'user', now: 2_000 });
    cloud.up(push(b));
    // A は自分の行を上げる前に、B の新しい行を受け取る。
    applyRemoteBatch(a, [cloud.row!], { ownDeviceId: 'a', skipOwn: true });
    expect(pinnedAt(a)).toBe(1_000);
    expect(getSessionState(a, 's1')?.status).toBe('done');
    vi.setSystemTime(3_000);
    settle(cloud, [{ db: a, id: 'a' }, { db: b, id: 'b' }]);
    for (const db of [a, b]) {
      expect(getSessionState(db, 's1')?.status).toBe('done');
      expect(pinnedAt(db)).toBe(1_000);
    }
  });

  it('移した先と提案のように、別の事実の組でも両方が残る', () => {
    vi.useFakeTimers();
    const a = seed(), b = seed();
    a.prepare("insert into projects (id, name, status, is_scratch, updated_at, origin_device) values ('p1', 'p', 'active', 0, 1, 'a')").run();
    const cloud = new Cloud();
    vi.setSystemTime(1_000);
    proposeSessionState(b, 'b', 's1', { status: 'done', note: '終わった', returnOn: null, source: 'in_session', now: 1_000 });
    vi.setSystemTime(2_000);
    setSessionPlacement(a, 'a', 's1', 'p1');
    cloud.up(push(a));
    cloud.up(push(b));
    vi.setSystemTime(3_000);
    settle(cloud, [{ db: a, id: 'a' }, { db: b, id: 'b' }]);
    for (const db of [a, b]) {
      expect(projectOf(db)).toBe('p1');
      expect(getSessionState(db, 's1')?.candidate).toMatchObject({ status: 'done', note: '終わった' });
    }
  });

  it('同じ事実は、後から書いた方が勝つ', () => {
    vi.useFakeTimers();
    const a = seed(), b = seed();
    const cloud = new Cloud();
    vi.setSystemTime(1_000);
    setSessionState(a, 'a', 's1', { status: 'paused', setBy: 'user', now: 1_000 });
    setSessionPinned(a, 'a', 's1', true, 1_000);
    cloud.up(push(a));
    vi.setSystemTime(2_000);
    setSessionState(b, 'b', 's1', { status: 'done', setBy: 'user', now: 2_000 });
    applyRemoteBatch(b, [cloud.row!], { ownDeviceId: 'b', skipOwn: true });
    vi.setSystemTime(3_000);
    settle(cloud, [{ db: a, id: 'a' }, { db: b, id: 'b' }]);
    for (const db of [a, b]) {
      expect(getSessionState(db, 's1')?.status).toBe('done');
      expect(pinnedAt(db)).toBe(1_000);
    }
  });

  it('事実の時刻を持たない古い版の PC の行は、これまでどおり行ごとの後勝ちで当てる', () => {
    const b = seed();
    setSessionPinned(b, 'b', 's1', true, 1_000);
    const old: ChangeOut = {
      seq: 1, tableName: 'session_states', rowId: 's1', op: 'upsert', deviceId: 'old', updatedAt: Date.now() + 60_000,
      payload: { session_id: 's1', status: 'done', set_by: 'user', set_at: 5, pinned_at: null, deleted_at: null, origin_device: 'old' },
    };
    applyRemoteBatch(b, [old], { ownDeviceId: 'b', skipOwn: true });
    expect(getSessionState(b, 's1')?.status).toBe('done');
    expect(pinnedAt(b)).toBeNull();
    // 古い行より古い事実の時刻を残さない。当てた行の時刻を、どの事実の時刻にもする。
    const r = b.prepare("select pinned_changed_at, status_changed_at from session_states where session_id = 's1'").get();
    expect(r).toEqual({ pinned_changed_at: old.updatedAt, status_changed_at: old.updatedAt });
  });
});
