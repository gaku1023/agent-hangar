import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

/**
 * 版 27 は、session_states に restored_at（明示の復元の時刻）を足す。
 * 削除の印は明示の復元でしか外れない。印の無い行が後勝ちで届いても、restored_at が印より新しくなければ印を保つ（sync/apply.ts）。
 * 列を足すだけで、既存の行は null（復元したことが無い）になる。
 */
const BEFORE = 26;
const AFTER = 27;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-session-restored-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 27：復元の時刻', () => {
  it('版 26 の DB を開くと版 27 へ上がり、既存の行の restored_at は null になる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
      db.prepare("insert into session_states (session_id, trashed_at, updated_at, origin_device) values ('s1', 5, 1, 'd')").run();
    });
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(AFTER);
    expect(db.prepare("select trashed_at, restored_at from session_states where session_id = 's1'").get()).toEqual({ trashed_at: 5, restored_at: null });
    db.close();
  });
});
