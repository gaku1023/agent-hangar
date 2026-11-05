import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import { applyRemoteChange } from '../sync/apply.ts';
import { seedDbAt } from '../../test/oldDb.ts';
import {
  acceptsResultFrom, backfillSpawnDevices, closeSpawn, forgetSpawn, forgetSpawnsOf, getSpawn,
  isSpawnedBy, isSpawnedFromOtherDevice, recordSpawn, relayTarget,
} from './spawns.ts';

const A = 'pc-a';
const B = 'pc-b';

const pending = (db: Db): { table_name: string; row_id: string; op: string }[] =>
  db.prepare('select table_name, row_id, op from changes where table_name = ? and pushed_at is null order by seq').all('session_spawns') as never;

describe('session_spawns の移行（版 47）', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawns-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('既存の行は残り、起動時に親も子も手元の device_id で埋まって同期に積まれる', () => {
    const file = path.join(dir, 'h.db');
    seedDbAt(file, 45, (d) => { d.prepare('insert into session_spawns (session_id, parent_id, created_at) values (?, ?, ?)').run('child', 'parent', 100); });
    const db = openDb(file);
    try {
      const before = db.prepare('select * from session_spawns').get() as Record<string, unknown>;
      expect(before).toMatchObject({ session_id: 'child', parent_id: 'parent', created_at: 100, parent_device_id: null, child_device_id: null, relay: 'on', deleted_at: null });
      expect(pending(db)).toEqual([]);
      backfillSpawnDevices(db, A);
      expect(db.prepare('select parent_device_id p, child_device_id c, origin_device o from session_spawns').get()).toEqual({ p: A, c: A, o: A });
      expect(pending(db)).toEqual([{ table_name: 'session_spawns', row_id: 'child', op: 'upsert' }]);
      backfillSpawnDevices(db, A);
      expect(pending(db)).toHaveLength(1);
      expect(getSpawn(db, A, 'child')).toMatchObject({ parentId: 'parent', parentDeviceId: A, childDeviceId: A, relay: 'on' });
    } finally { db.close(); }
  });
});

describe('結び付き', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });

  it('同じ PC の入れ子は今までどおり spawnedBy に出る。同期の行にもなるが、結果は返さない', () => {
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s-child','claude-code','u1','/w','pc-a',1,'pc-a')").run();
    recordSpawn(db, A, 's-child', 's-parent', 5);
    expect(getSession(db, [], 's-child')?.spawnedBy).toBe('s-parent');
    expect(pending(db)).toEqual([{ table_name: 'session_spawns', row_id: 's-child', op: 'upsert' }]);
    expect(relayTarget(db, A, 's-child')).toBeNull();
    expect(isSpawnedFromOtherDevice(db, A, 's-child')).toBe(false);
    expect(isSpawnedBy(db, A, 's-parent', 's-child')).toBe(true);
    expect(isSpawnedBy(db, A, 's-other', 's-child')).toBe(false);
  });
  it('自分を起こし元にはできない', () => {
    recordSpawn(db, A, 's', 's', 1);
    expect(getSpawn(db, A, 's')).toBeNull();
  });

  it('別の PC の子：呼ぶ側は結果を受け、受ける側は返し続ける。深さの検査は子の側だけで真', () => {
    // 呼ぶ側（A）が、B に起こした子を残す。
    recordSpawn(db, A, 'c', 'p', 1, { childDeviceId: B });
    expect(acceptsResultFrom(db, A, 'c', B)).toBe(true);
    expect(acceptsResultFrom(db, A, 'c', 'pc-z')).toBe(false);
    expect(isSpawnedBy(db, A, 'p', 'c')).toBe(true);
    expect(relayTarget(db, A, 'c')).toBeNull();
    expect(isSpawnedFromOtherDevice(db, A, 'c')).toBe(false);
    // 受ける側（B）から見た同じ行。
    expect(relayTarget(db, B, 'c')).toMatchObject({ parentId: 'p', parentDeviceId: A, childDeviceId: B });
    expect(isSpawnedFromOtherDevice(db, B, 'c')).toBe(true);
    expect(isSpawnedBy(db, B, 'p', 'c')).toBe(false);
    expect(acceptsResultFrom(db, B, 'c', B)).toBe(false);
  });

  it('「終わった」を返したら返却だけが止まり、入れ子は残る。起こした相手のままで、起こし直せば返し続ける', () => {
    recordSpawn(db, A, 'c', 'p', 1, { childDeviceId: B });
    closeSpawn(db, B, 'c', 50);
    expect(getSpawn(db, A, 'c')).toMatchObject({ relay: 'off', closedAt: 50 });
    expect(relayTarget(db, B, 'c')).toBeNull();
    expect(acceptsResultFrom(db, A, 'c', B)).toBe(false);
    expect(isSpawnedBy(db, A, 'p', 'c')).toBe(true);
    recordSpawn(db, A, 'c', 'p', 60, { childDeviceId: B });
    expect(getSpawn(db, A, 'c')).toMatchObject({ relay: 'on', closedAt: null });
  });

  it('切り離すと行は消え（deleted_at）、入れ子も返却も起こした相手の扱いもなくなる。同期に delete が積まれる', () => {
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('c','claude-code','u1','/w','pc-a',1,'pc-a')").run();
    recordSpawn(db, A, 'c', 'p', 1, { childDeviceId: B });
    forgetSpawn(db, A, 'c');
    expect(getSpawn(db, A, 'c')).toBeNull();
    expect(getSession(db, [], 'c')?.spawnedBy).toBeNull();
    expect(acceptsResultFrom(db, A, 'c', B)).toBe(false);
    expect(isSpawnedBy(db, A, 'p', 'c')).toBe(false);
    expect(db.prepare('select deleted_at d from session_spawns where session_id = ?').get('c')).toEqual({ d: expect.any(Number) });
    expect(pending(db).map((c) => c.op)).toEqual(['delete']);
    // 無い行を切り離しても何も積まない。切った後の closeSpawn も何もしない。
    forgetSpawn(db, A, 'c');
    closeSpawn(db, B, 'c', 9);
    expect(pending(db)).toHaveLength(1);
  });

  it('会話を消すと、子の行と親の行を全部切る', () => {
    recordSpawn(db, A, 'c1', 'p', 1);
    recordSpawn(db, A, 'c2', 'p', 1);
    recordSpawn(db, A, 'g', 'c1', 1);
    forgetSpawnsOf(db, A, 'c1');
    expect(getSpawn(db, A, 'c1')).toBeNull();
    expect(getSpawn(db, A, 'g')).toBeNull();
    expect(getSpawn(db, A, 'c2')).not.toBeNull();
  });

  it('ほかの PC から届いた行を当てると、引く関数がそのまま使える。切り離しの delete も当たる', () => {
    const row = { session_id: 'c', parent_id: 'p', created_at: 1, parent_device_id: A, child_device_id: B, relay: 'on', closed_at: null, updated_at: 10, deleted_at: null, origin_device: A };
    const ch = (op: 'upsert' | 'delete', updatedAt: number, payload: Record<string, unknown>): ChangeOut => ({ seq: 1, tableName: 'session_spawns', rowId: 'c', op, deviceId: A, updatedAt, payload });
    expect(applyRemoteChange(db, ch('upsert', 10, row), { ownDeviceId: B, skipOwn: true })).toBe('applied');
    expect(relayTarget(db, B, 'c')).not.toBeNull();
    expect(pending(db)).toEqual([]);
    expect(applyRemoteChange(db, ch('upsert', 20, { ...row, relay: 'off', closed_at: 15, updated_at: 20 }), { ownDeviceId: B, skipOwn: true })).toBe('applied');
    expect(relayTarget(db, B, 'c')).toBeNull();
    expect(applyRemoteChange(db, ch('delete', 30, { ...row, deleted_at: 30, updated_at: 30 }), { ownDeviceId: B, skipOwn: true })).toBe('applied');
    expect(getSpawn(db, B, 'c')).toBeNull();
  });
});
