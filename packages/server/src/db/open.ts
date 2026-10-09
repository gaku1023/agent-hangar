import Database from 'better-sqlite3';
import { backupDb, defaultDbBackupDir } from './backup.ts';
import { BASELINE_VERSION, MIGRATIONS, type Migration } from './migrations.ts';

export type Db = Database.Database;
/**
 * backupDir は控えの置き場（既定は DB と同じ置き場の backups/db）、now は控えの名前に使う時刻、
 * migrations は当てるマイグレーションの一覧（既定は製品の一覧）。どれも試験が差し替える。
 */
export type OpenDbOptions = { backupDir?: string; now?: () => Date; migrations?: Migration[] };

/** 起点より古い版の DB だった。開いておらず、何も書いていない。 */
export class DbTooOldError extends Error {
  constructor(readonly file: string, readonly found: number, readonly baseline: number) {
    super(`DB（${file}）は版 ${found} で、このアプリが開けるのは版 ${baseline} 以降です。古い版から上げる道はもう無いので、DB には何も書かず、マイグレーションも当てずに止めました。版 ${baseline} まで上げられる以前の版の Hangar で一度起動して DB を上げてから、このアプリをもう一度起動してください`);
    this.name = 'DbTooOldError';
  }
}

/**
 * データベースを開き、WAL と外部キーを有効にして、未適用のマイグレーションを順に当てる。
 * 起点（BASELINE_VERSION）より古い版の DB は、何も書く前に閉じて DbTooOldError を投げる。控えも取らない（何も変えないので要らない）。
 * すでに 1 本以上当てた DB に未適用のものがあれば、当てる前に VACUUM INTO で控えを取る（db/backup.ts）。
 * 新しい DB と :memory: では取らない。控えが取れなければ、何も当てずに DbBackupError を投げる。
 */
export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  const migrations = opts.migrations ?? MIGRATIONS;
  const db = new Database(file);
  let applied: Set<number>;
  try {
    // 版は、WAL への切り替えや表の作成より先に、読むだけで確かめる。断る DB には 1 バイトも書かない。
    const hasTable = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'schema_migrations'").get() !== undefined;
    applied = new Set(hasTable ? (db.prepare('select version from schema_migrations').all() as { version: number }[]).map((r) => r.version) : []);
    if (applied.size > 0 && Math.max(...applied) < BASELINE_VERSION) throw new DbTooOldError(file, Math.max(...applied), BASELINE_VERSION);
  } catch (e) {
    db.close();
    throw e;
  }
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length > 0 && applied.size > 0 && file !== ':memory:') {
    try {
      backupDb(db, opts.backupDir ?? defaultDbBackupDir(file), Math.max(...applied), (opts.now ?? (() => new Date()))());
    } catch (e) {
      db.close();
      throw e;
    }
  }
  const apply = db.transaction((m: Migration) => {
    db.exec(m.sql);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, Date.now());
  });
  for (const m of pending) apply(m);
  return db;
}
