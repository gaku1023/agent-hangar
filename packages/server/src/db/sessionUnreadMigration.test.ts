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
    expect(db.prepare('select count(*) c from session_unread').get()).toEqual({ c: 0 });
    expect(db.prepare('select id from sessions').all()).toEqual([{ id: 's1' }]);
    db.prepare("insert into session_unread (session_id, count, latest_text, latest_at) values ('s1', 2, 'x', 5)").run();
    expect(db.prepare('select count, latest_text from session_unread').get()).toEqual({ count: 2, latest_text: 'x' });
    db.close();
  });
});
