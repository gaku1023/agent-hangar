import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { dbVersionOf, LATEST_DB_VERSION, seedDbAt } from './oldDb.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-olddb-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('古い版の DB を作る補助', () => {
  it('最新の版はマイグレーションの一覧の最後の版である', () => {
    expect(LATEST_DB_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
  });

  it('指定した版までだけを当て、閉じる前に仕込みを流す', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 9, (db) => {
      db.prepare("insert into projects (id, name, status, is_scratch, updated_at, origin_device) values ('p1', 'a', 'active', 0, 1, 'd')").run();
    });
    expect(dbVersionOf(file)).toBe(9);
    const db = new Database(file, { readonly: true });
    try {
      // 版 10 で足す列は、まだ無い。
      const cols = (db.prepare('pragma table_info(todos)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).not.toContain('candidate_at');
      expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 1 });
    } finally {
      db.close();
    }
  });
});
