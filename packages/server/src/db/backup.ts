import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { causeOf, msg, MessageError } from '../i18n/message.ts';

/** 控えを残す数。新しいものから数える。 */
export const DB_BACKUP_GENERATIONS = 5;
/** 控えの名前。当てた最後の版と、UTC の時刻（ミリ秒まで）を持つ。刈るときはこの形のものだけを見る。 */
const NAME = /^hangar-v(\d+)-(\d{8}T\d{9}Z)\.db$/;

/** 控えが取れなかった。マイグレーションは当てていない。 */
export class DbBackupError extends MessageError {
  constructor(readonly file: string, cause: unknown) {
    super(msg('db.backup.failed', { file, cause: causeOf(cause) }));
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
 * 写しは控えの形でない一時の名前に書き、0600 にして fsync してから改名する。途中で失敗したり落ちたりしても、控えに見えるものは残らない。
 * 置き場がシンボリックリンクなら取らない（刈る側の pruneBackupFiles と、書く側の resolveUnder にそろえる）。
 * 写しが取れなければ DbBackupError を投げる。刈り込みの失敗は投げない（控えはもう取れている）。
 */
export function backupDb(db: Database.Database, dir: string, lastVersion: number, now: Date, keep: number = DB_BACKUP_GENERATIONS): string {
  const file = path.join(dir, `hangar-v${lastVersion}-${backupStamp(now)}.db`);
  // NAME は .db で終わる形だけを控えと見るので、.tmp を付けた名前は刈り込みにも控えにも数えられない。
  const tmp = `${file}.tmp`;
  try {
    assertNotSymlink(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 前の失敗の残りが同じ名前であると VACUUM INTO が断るので、先に消す。
    fs.rmSync(tmp, { force: true });
    db.prepare('vacuum into ?').run(tmp);
    // 写しは会話の索引をそのまま持つので、トークンと同じ 0600 にする。
    fs.chmodSync(tmp, 0o600);
    // VACUUM INTO の出力は SQLite が fsync しない。続くマイグレーションは耐久的に確定するので、先に写しを固める。
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 残っても控えの形ではない */ }
    throw new DbBackupError(file, e);
  }
  try {
    pruneDbBackups(dir, keep, path.basename(file));
  } catch (e) {
    console.error('[db] 古い控えを刈れませんでした', e instanceof Error ? e.message : e);
  }
  return file;
}

/** 置き場そのものがリンクだと、書くのも刈るのもリンクの先に出てしまう。無いのは構わない（これから作る）。 */
function assertNotSymlink(dir: string): void {
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new MessageError(msg('db.backup.symlink'));
}

/**
 * 控えの形の名前のファイルだけを、時刻の新しい順に keep 個残して消す。
 * protect の名前（いま取った控え）は時刻に関わらず残し、数に入れる。時計が戻っても、いま取った控えを刈らないため。
 * 置き場に利用者が置いたファイルとリンクには触れない。消せなかったものは次の機会に回す。
 */
export function pruneDbBackups(dir: string, keep: number = DB_BACKUP_GENERATIONS, protect?: string): number {
  assertNotSymlink(dir);
  const limit = Math.max(1, keep);
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && NAME.test(e.name))
    .map((e) => ({ name: e.name, stamp: NAME.exec(e.name)![2]! }))
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : a.name < b.name ? 1 : -1));
  const protectedHere = protect !== undefined && files.some((f) => f.name === protect);
  // 守る控えが 1 つ入る分、ほかは keep - 1 個まで。
  const others = files.filter((f) => f.name !== protect);
  let removed = 0;
  for (const f of others.slice(protectedHere ? limit - 1 : limit)) {
    try { fs.rmSync(path.join(dir, f.name)); removed++; } catch { /* 次の機会に消える */ }
  }
  return removed;
}
