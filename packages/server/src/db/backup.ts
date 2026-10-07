import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

/** 控えを残す数。新しいものから数える。 */
export const DB_BACKUP_GENERATIONS = 5;
/** 控えの名前。当てた最後の版と、UTC の時刻（ミリ秒まで）を持つ。刈るときはこの形のものだけを見る。 */
const NAME = /^hangar-v(\d+)-(\d{8}T\d{9}Z)\.db$/;

/** 控えが取れなかった。マイグレーションは当てていない。 */
export class DbBackupError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(`DB の控えを ${file} に取れなかったので、マイグレーションを当てずに止めました（${cause instanceof Error ? cause.message : String(cause)}）。置き場に書けるか、空きがあるかを確かめてください`);
    this.name = 'DbBackupError';
  }
}

/** 20261007T063000123Z の形。辞書順がそのまま時刻順になる。 */
export function backupStamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

/** 控えの置き場の既定。hangar.db と同じ置き場の backups/db（~/.agent-hangar/backups/db）である。 */
export function defaultDbBackupDir(dbFile: string): string {
  return path.join(path.dirname(dbFile), 'backups', 'db');
}

/**
 * VACUUM INTO で DB の写しを取り、新しいものから keep 個を残して古いものを消す。
 * VACUUM はトランザクションの中では動かないので、マイグレーションを当てる前に、トランザクションの外で呼ぶ。
 * 写しが取れなければ DbBackupError を投げる。刈り込みの失敗は投げない（控えはもう取れている）。
 */
export function backupDb(db: Database.Database, dir: string, lastVersion: number, now: Date, keep: number = DB_BACKUP_GENERATIONS): string {
  const file = path.join(dir, `hangar-v${lastVersion}-${backupStamp(now)}.db`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    db.prepare('vacuum into ?').run(file);
    // 写しは会話の索引をそのまま持つので、トークンと同じ 0600 にする。
    fs.chmodSync(file, 0o600);
  } catch (e) {
    throw new DbBackupError(file, e);
  }
  try {
    pruneDbBackups(dir, keep);
  } catch (e) {
    console.error('[db] 古い控えを刈れませんでした', e instanceof Error ? e.message : e);
  }
  return file;
}

/**
 * 控えの形の名前のファイルだけを、時刻の新しい順に keep 個残して消す。
 * 置き場に利用者が置いたファイルとリンクには触れない。消せなかったものは次の機会に回す。
 */
export function pruneDbBackups(dir: string, keep: number = DB_BACKUP_GENERATIONS): number {
  const limit = Math.max(1, keep);
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && NAME.test(e.name))
    .map((e) => ({ name: e.name, stamp: NAME.exec(e.name)![2]! }))
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : a.name < b.name ? 1 : -1));
  let removed = 0;
  for (const f of files.slice(limit)) {
    try { fs.rmSync(path.join(dir, f.name)); removed++; } catch { /* 次の機会に消える */ }
  }
  return removed;
}
