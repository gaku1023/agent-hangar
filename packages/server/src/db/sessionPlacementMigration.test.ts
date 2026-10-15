import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

/**
 * 版 25 は、session_states に利用者が移した先（project_id）と削除の印（trashed_at）の列を足す。
 * 既存の行はどちらも null のままで、cwd からの自動の振り分けに従い、生きている会話として残る。
 * 同期は行を JSON の payload のまま運ぶので、クラウドにマイグレーションは要らない。
 */
const BEFORE = 24;
const AFTER = 25;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-session-placement-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 25：セッションの所属と削除の印', () => {
  it('版 24 の DB を開くと版 25 へ上がり、既存の状態の行は所属も削除の印も null のまま残る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
      db.prepare("insert into session_states (session_id, status, updated_at, origin_device) values ('s1', 'done', 1, 'd')").run();
    });
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(AFTER);
    const cols = (db.prepare('pragma table_info(session_states)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['project_id', 'trashed_at']));
    expect(db.prepare("select status, project_id, trashed_at from session_states where session_id = 's1'").get()).toEqual({ status: 'done', project_id: null, trashed_at: null });
    db.close();
  });
});
