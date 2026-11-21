import type { ChangeOut } from '@agent-hangar/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { upsertShared } from '../db/shared.ts';
import { applyRemoteBatch } from '../sync/apply.ts';
import { setSessionPinned } from '../sessions/states.ts';
import { addUnread, bindUnreadDevice, markSeen, markUnread, onUnreadArrived, readUnread } from './unread.ts';

/**
 * 未読の同期（2026-11-21、agent-hangar-notes の unread-sync の A）。
 * 未読の数と最後の一文は session_states の 1 つの事実として 2 台で同期する。どちらの PC で既読にしても両方で既読になる。
 */

type Db = ReturnType<typeof openDb>;

function pc(id: string): Db {
  const db = openDb(':memory:');
  bindUnreadDevice(db, id);
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'w' }, 'w');
  db.prepare('update changes set pushed_at = 1').run();
  return db;
}

function push(from: Db): ChangeOut[] {
  const rows = from.prepare("select seq, table_name, row_id, op, payload, updated_at, device_id from changes where table_name = 'session_states' and pushed_at is null order by seq").all() as { seq: number; table_name: string; row_id: string; op: 'upsert' | 'delete'; payload: string; updated_at: number; device_id: string }[];
  from.prepare('update changes set pushed_at = 1 where pushed_at is null').run();
  return rows.map((r) => ({ seq: r.seq, tableName: r.table_name as ChangeOut['tableName'], op: r.op, deviceId: r.device_id, rowId: r.row_id, updatedAt: r.updated_at, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

/** from が積んだ変更を to に当てる。 */
function carry(from: Db, to: Db, toId: string): void {
  const out = push(from);
  if (out.length > 0) applyRemoteBatch(to, out, { ownDeviceId: toId, skipOwn: true });
}

const offs: (() => void)[] = [];
afterEach(() => { for (const f of offs.splice(0)) f(); vi.useRealTimers(); });

describe('未読を同期する', () => {
  it('動かしている PC で積んだ未読が、もう 1 台に数と一文と場面ごと届く', () => {
    const w = pc('w'), m = pc('m');
    addUnread(w, 's1', '一つ目', 10, { kind: 'done' });
    expect(addUnread(w, 's1', '二つ目', 20, { kind: 'ask' })).toBe(2);
    carry(w, m, 'm');
    expect(readUnread(m, 's1')).toEqual({ count: 2, latest: '二つ目', at: 20, kind: 'ask', device: 'w' });
  });

  it('もう 1 台で既読にすると、動かしている PC でも既読になる', () => {
    const w = pc('w'), m = pc('m');
    addUnread(w, 's1', '一つ目', 10, { kind: 'done' });
    carry(w, m, 'm');
    expect(markSeen(m, 's1')).toBe(true);
    expect(readUnread(m, 's1')).toBeNull();
    carry(m, w, 'w');
    expect(readUnread(w, 's1')).toBeNull();
    // 既読の後に積んだ分は 1 から数え直す。
    expect(addUnread(w, 's1', '三つ目', Date.now() + 1000, { kind: 'done' })).toBe(1);
  });

  it('既読の後に積んだ未読は、既読より後なので残る（向こうの既読が遅れて届いても消えない）', () => {
    const w = pc('w'), m = pc('m');
    addUnread(w, 's1', '一つ目', 10, { kind: 'done' });
    carry(w, m, 'm');
    markSeen(m, 's1');
    // 既読が届く前に、W で次の未読を積む。
    const later = Date.now() + 60_000;
    addUnread(w, 's1', '次', later, { kind: 'done' });
    carry(m, w, 'w');
    expect(readUnread(w, 's1')?.latest).toBe('次');
    carry(w, m, 'm');
    expect(readUnread(m, 's1')?.latest).toBe('次');
  });

  it('未読とピンは別の事実で、同期が届く前に 2 台が書いても両方が残る', () => {
    const w = pc('w'), m = pc('m');
    addUnread(w, 's1', '一つ目', 10, { kind: 'done' });
    setSessionPinned(m, 'm', 's1', true);
    carry(w, m, 'm');
    carry(m, w, 'w');
    carry(w, m, 'm');
    for (const db of [w, m]) {
      expect(readUnread(db, 's1')?.latest).toBe('一つ目');
      expect((db.prepare("select pinned_at from session_states where session_id = 's1'").get() as { pinned_at: number | null }).pinned_at).not.toBeNull();
    }
  });

  it('未読を積む書き込みと既読の書き込みは急ぐ（呼び鈴で 2 秒以内に届ける）', () => {
    const w = pc('w');
    const urgent: boolean[] = [];
    offs.push(onRowChange((c) => { if (c.db === w && c.table === 'session_states') urgent.push(c.urgent === true); }));
    addUnread(w, 's1', '一つ目', 10, { kind: 'done' });
    markSeen(w, 's1');
    expect(urgent).toEqual([true, true]);
  });

  it('既読にする行が無ければ書かず false を返す', () => {
    const w = pc('w');
    expect(markSeen(w, 's1')).toBe(false);
    expect(markSeen(w, 'nope')).toBe(false);
    expect(push(w)).toEqual([]);
  });

  it('未読に戻すのは未読が無いときだけで、本文も場面も持たず、同期する', () => {
    const w = pc('w'), m = pc('m');
    markUnread(m, 's1', 50);
    carry(m, w, 'w');
    expect(readUnread(w, 's1')).toEqual({ count: 1, latest: null, at: 50, kind: null, device: 'm' });
    addUnread(w, 's1', 'x', 60, { kind: 'done' });
    markUnread(w, 's1', 70);
    expect(readUnread(w, 's1')?.count).toBe(2);
  });

  it('会話の行が無い id には積まない（0 を返す）', () => {
    const w = pc('w');
    expect(addUnread(w, 'nope', 'x', 10)).toBe(0);
  });
});

describe('ほかの PC から届いた未読を知らせる', () => {
  it('数が増えた行が届いたら onUnreadArrived を呼ぶ。既読や自分の書いた行では呼ばない', () => {
    const w = pc('w'), m = pc('m');
    const got: string[] = [];
    offs.push(onUnreadArrived((db, id) => { if (db === m) got.push(id); }));
    addUnread(w, 's1', '一つ目', 10, { kind: 'done' });
    carry(w, m, 'm');
    expect(got).toEqual(['s1']);
    markSeen(m, 's1');
    carry(m, w, 'w');
    carry(w, m, 'm');
    expect(got).toEqual(['s1']);
    // 未読に戻した（場面の無い）行は知らせない。
    markUnread(w, 's1', 20);
    carry(w, m, 'm');
    expect(got).toEqual(['s1']);
  });
});
