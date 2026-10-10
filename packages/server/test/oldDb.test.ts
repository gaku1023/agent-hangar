import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { dbVersionOf, LATEST_DB_VERSION, nextMigration, seedDbAt, withPendingMigration } from './oldDb.ts';

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

  it('起点より先の版は、畳む前の分に製品の一覧の続きを重ねて作る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION);
    const db = new Database(file, { readonly: true });
    try {
      // 版 1 から 1 本ずつ当てた跡が残る。利用者の手元の DB と同じ形である。
      const versions = (db.prepare('select version from schema_migrations order by version').all() as { version: number }[]).map((r) => r.version);
      expect(versions).toEqual(Array.from({ length: LATEST_DB_VERSION }, (_, i) => i + 1));
    } finally {
      db.close();
    }
  });

  it('withPendingMigration は、走らせているあいだだけ仮の次の版を一覧に足す', async () => {
    const before = [...MIGRATIONS];
    const next = nextMigration();
    expect(next.version).toBe(LATEST_DB_VERSION + 1);
    await withPendingMigration(() => {
      expect(MIGRATIONS.map((m) => m.version)).toEqual([...before.map((m) => m.version), next.version]);
    });
    expect(MIGRATIONS).toEqual(before);
    // 中で投げても外す。
    await expect(withPendingMigration(() => { throw new Error('失敗'); })).rejects.toThrow('失敗');
    expect(MIGRATIONS).toEqual(before);
  });
});
