import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-peer-approvals-drop-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 71：別の PC への起動の承認待ちの表を外す', () => {
  it('版 70 の DB に残っていた peer_approvals を、行ごと外す', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 70, (db) => {
      db.prepare("insert into peer_approvals (id, caller_session_id, to_device, to_name, request, created_at) values ('r1', 's1', 'd2', 'laptop', '{}', 1)").run();
    });
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(71);
    expect(db.prepare("select count(*) c from sqlite_master where name = 'peer_approvals'").get()).toEqual({ c: 0 });
    db.close();
  });
});
