import Database from 'better-sqlite3';
import { backupDb, defaultDbBackupDir } from './backup.ts';
import { MIGRATIONS } from './migrations.ts';

export type Db = Database.Database;
/** backupDir は控えの置き場（既定は DB と同じ置き場の backups/db）、now は控えの名前に使う時刻。どちらも試験が差し替える。 */
export type OpenDbOptions = { backupDir?: string; now?: () => Date };

/**
 * データベースを開き、WAL と外部キーを有効にして、未適用のマイグレーションを順に当てる。
 * すでに 1 本以上当てた DB に未適用のものがあれば、当てる前に VACUUM INTO で控えを取る（db/backup.ts）。
 * 新しい DB と :memory: では取らない。控えが取れなければ、何も当てずに DbBackupError を投げる。
 */
export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  const applied = new Set((db.prepare('select version from schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length > 0 && applied.size > 0 && file !== ':memory:') {
    try {
      backupDb(db, opts.backupDir ?? defaultDbBackupDir(file), Math.max(...applied), (opts.now ?? (() => new Date()))());
    } catch (e) {
      db.close();
      throw e;
    }
  }
  const apply = db.transaction((m: { version: number; sql: string }) => {
    db.exec(m.sql);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, Date.now());
  });
  for (const m of pending) apply(m);
  return db;
}
