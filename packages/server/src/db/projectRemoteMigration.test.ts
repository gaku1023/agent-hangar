import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';
import { upsertShared } from './shared.ts';

/**
 * 版 24 は、projects に git の remote（git_remote）の列を足す。
 * 既存の行は null のままで、索引の起動のときに、この PC に場所のあるものから埋める（projects/link.ts の fillProjectRemotes）。
 * 同期は行を JSON の payload のまま運ぶので、クラウドにマイグレーションは要らない。
 */
const BEFORE = 23;
const AFTER = 24;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-project-remote-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 24：プロジェクトの git の remote', () => {
  it('版 23 の DB を開くと版 24 へ上がり、既存のプロジェクトは remote が null のまま残る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      db.prepare("insert into projects (id, name, status, is_scratch, updated_at, origin_device) values ('p1', 'a', 'active', 0, 1, 'd')").run();
    });
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(AFTER);
    const cols = (db.prepare('pragma table_info(projects)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('git_remote');
    expect(db.prepare("select name, git_remote from projects where id = 'p1'").get()).toEqual({ name: 'a', git_remote: null });
    db.close();
  });
  it('書いた remote は変更ログの payload に載る（同期で運ばれる）', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'a', status: 'active', is_scratch: 0, git_remote: 'github.com/me/a' }, 'd');
    const c = db.prepare("select payload from changes where table_name = 'projects' and row_id = 'p1'").get() as { payload: string };
    expect(JSON.parse(c.payload)).toMatchObject({ id: 'p1', git_remote: 'github.com/me/a' });
    db.close();
  });
});
