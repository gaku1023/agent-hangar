import Database from 'better-sqlite3';
import { BASELINE_VERSION, MIGRATIONS, type Migration } from '../src/db/migrations.ts';
import type { Db } from '../src/db/open.ts';
import { LEGACY_MIGRATIONS } from './legacyMigrations.ts';

/** いちばん新しいマイグレーションの版。 */
export const LATEST_DB_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
/** 起点の版。これより古い版の DB を、openDb は開かずに断る。 */
export const BASELINE_DB_VERSION = BASELINE_VERSION;

/**
 * 版 1 から順に当てていく一覧。
 * 起点までは畳む前のマイグレーション（legacyMigrations.ts）、その先は製品の一覧の起点より後ろである。
 * 利用者の手元の DB は起点を当てたのではなく、この順で上がってきた。
 */
function history(): Migration[] {
  return [...LEGACY_MIGRATIONS, ...MIGRATIONS.filter((m) => m.version > BASELINE_VERSION)];
}

/**
 * version 以下のマイグレーションだけを、版 1 から順に当てた実物のファイルの DB を作る。
 * 既存の DB を開くときの振る舞いを試すためである。
 * 起点より古い版も作れる（openDb が断ることを試すため）。
 * openDb を通さないので、段 0 の控えも取らない。
 * seed を渡すと、閉じる前にその DB で中身を仕込む。
 */
export function seedDbAt(file: string, version: number, seed?: (db: Db) => void): void {
  const db = new Database(file);
  try {
    db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
    for (const m of history().filter((m) => m.version <= version)) {
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

/** 試験用の仮の次の版。いちばん新しい版の 1 つ先で、表を 1 つ作るだけである。 */
export function nextMigration(): Migration {
  return { version: MIGRATIONS[MIGRATIONS.length - 1]!.version + 1, sql: 'create table next_probe (id integer primary key, note text not null)' };
}

/**
 * 仮の次の版を製品の一覧の末尾に足した状態で fn を走らせ、終わったら外す。
 * 「当てていないマイグレーションがある既存の DB」を、openDb に一覧を渡せない呼び手（startServer や CLI の関数）で試すためである。
 * 同じプロセスの中でしか効かない。子プロセスには届かない。
 */
export async function withPendingMigration<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = nextMigration();
  MIGRATIONS.push(next);
  try {
    return await fn();
  } finally {
    const i = MIGRATIONS.indexOf(next);
    if (i >= 0) MIGRATIONS.splice(i, 1);
  }
}
