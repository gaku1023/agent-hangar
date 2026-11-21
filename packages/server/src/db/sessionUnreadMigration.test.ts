import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

/** 版 39 は、notify_user の未読の表（session_unread）を足す。手元だけの表で、既存の行には触れない。 */
const BEFORE = 38;
const AFTER = 39;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-session-unread-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 39：未読の表', () => {
  it('版 38 の DB を開くと版 39 へ上がり、空の session_unread ができる。既存のセッションは残る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
    });
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(AFTER);
    expect(db.prepare('select id from sessions').all()).toEqual([{ id: 's1' }]);
    db.close();
  });
});

/** 版 67 は、未読を同期する（session_states の列に移し、session_unread を消す）。 */
describe('版 67：未読を session_states へ移す', () => {
  it('session_unread の行を session_states の未読の列へ写し、表を消す。状態の行の無い会話には行を作る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 66, (db) => {
      for (const id of ['s1', 's2']) db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values (?, 'claude-code', ?, '/w', 'w', 1, 'w')").run(id, `u-${id}`);
      db.prepare("insert into session_states (session_id, status, updated_at, origin_device) values ('s1', 'paused', 3, 'm')").run();
      db.prepare("insert into session_unread (session_id, count, latest_text, latest_at) values ('s1', 2, 'x', 5), ('s2', 1, null, 7)").run();
    });
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(db.prepare("select count(*) c from sqlite_master where name = 'session_unread'").get()).toEqual({ c: 0 });
    const rows = db.prepare('select session_id, status, unread_count, unread_text, unread_at, unread_kind, unread_device, unread_changed_at, origin_device from session_states order by session_id').all();
    expect(rows).toEqual([
      { session_id: 's1', status: 'paused', unread_count: 2, unread_text: 'x', unread_at: 5, unread_kind: null, unread_device: null, unread_changed_at: 5, origin_device: 'm' },
      { session_id: 's2', status: null, unread_count: 1, unread_text: null, unread_at: 7, unread_kind: null, unread_device: null, unread_changed_at: 7, origin_device: 'w' },
    ]);
    db.close();
  });
});
