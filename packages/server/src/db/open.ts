import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.ts';

export type Db = Database.Database;

/** データベースを開き、WAL と外部キーを有効にして、未適用のマイグレーションを順に当てる。 */
export function openDb(file: string): Db {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  const applied = new Set((db.prepare('select version from schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const apply = db.transaction((m: { version: number; sql: string }) => {
    db.exec(m.sql);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, Date.now());
  });
  for (const m of MIGRATIONS) if (!applied.has(m.version)) apply(m);
  return db;
}
