import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { Db } from '../src/db/open.ts';

/** いちばん新しいマイグレーションの版。 */
export const LATEST_DB_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * version 以下のマイグレーションだけを当てた実物のファイルの DB を作る。既存の DB からの移行を試すため。
 * openDb を通さないので、段 0 の控えも取らない。
 * seed を渡すと、閉じる前にその DB で中身を仕込む。
 */
export function seedDbAt(file: string, version: number, seed?: (db: Db) => void): void {
  const db = new Database(file);
  try {
    db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
    for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
      db.exec(m.sql);
      db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, 1);
    }
    seed?.(db);
  } finally {
    db.close();
  }
}

/** そのファイルが当てた最後の版。 */
export function dbVersionOf(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare('select max(version) v from schema_migrations').get() as { v: number }).v;
  } finally {
    db.close();
  }
}
