import fs from 'node:fs';
import Database from 'better-sqlite3';
import { backupDb, defaultDbBackupDir } from './backup.ts';
import { BASELINE_VERSION, MIGRATIONS, type Migration } from './migrations.ts';

export type Db = Database.Database;
/**
 * backupDir は控えの置き場（既定は DB と同じ置き場の backups/db）、now は控えの名前に使う時刻、
 * migrations は当てるマイグレーションの一覧（既定は製品の一覧）。どれも試験が差し替える。
 */
export type OpenDbOptions = { backupDir?: string; now?: () => Date; migrations?: Migration[] };

/** 起点より古い版の DB だった。書き込み用には開いておらず、DB の中身は変えていない。 */
export class DbTooOldError extends Error {
  constructor(readonly file: string, readonly found: number, readonly baseline: number) {
    super(`DB（${file}）は版 ${found} で、このアプリが開けるのは版 ${baseline} 以降です。古い版から上げる道はもう無いので、DB の中身は変えず、マイグレーションも当てずに止めました。版 ${baseline} まで上げられる以前の版の Hangar で一度起動して DB を上げてから、このアプリをもう一度起動してください`);
    this.name = 'DbTooOldError';
  }
}

/**
 * そのファイルが当てた最後の版を、読み取り専用の接続で読む。ファイルが無い、または 1 本も当てていなければ null。
 * 書き込み用の接続で読まないのは、WAL の DB では、読むだけでも最後の接続を閉じるときに -wal の頁が本体へ書き戻され、-wal と -shm が消えるからである（実測）。
 * 読み取り専用の接続は書き戻さず、本体と -wal の頁を 1 バイトも変えない。
 * ただし WAL の DB では、読み取り専用でも SQLite が -shm（-wal の索引で、DB の内容は持たない）を作るか書き直し、-wal が無ければ空の -wal も作る（実測）。
 * これを避ける手は無かった。排他のロック（locking_mode = EXCLUSIVE）は I/O の失敗になり、better-sqlite3 の SQLite は URI の名前を受けないので immutable も使えない。
 * WAL でない DB では、何もできず何も変わらない。
 */
function peekVersion(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const hasTable = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'schema_migrations'").get() !== undefined;
    if (!hasTable) return null;
    return (db.prepare('select max(version) v from schema_migrations').get() as { v: number | null }).v;
  } finally {
    db.close();
  }
}

/**
 * データベースを開き、WAL と外部キーを有効にして、未適用のマイグレーションを順に当てる。
 * 起点（BASELINE_VERSION）より古い版の DB は、書き込み用に開く前に DbTooOldError を投げる（版は peekVersion が読み取り専用で読む）。控えも取らない（DB の中身を変えないので要らない）。
 * すでに 1 本以上当てた DB に未適用のものがあれば、当てる前に VACUUM INTO で控えを取る（db/backup.ts）。
 * 新しい DB と :memory: では取らない。控えが取れなければ、何も当てずに DbBackupError を投げる。
 */
export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  const migrations = opts.migrations ?? MIGRATIONS;
  // 断るかどうかは、書き込み用に開く前に決める。
  const found = file === ':memory:' ? null : peekVersion(file);
  if (found !== null && found < BASELINE_VERSION) throw new DbTooOldError(file, found, BASELINE_VERSION);
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  const applied = new Set((db.prepare('select version from schema_migrations').all() as { version: number }[]).map((r) => r.version));
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
