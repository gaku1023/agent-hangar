import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectMode, posixIt } from '../../test/platform.ts';
import { backupStamp, DbBackupError, pruneDbBackups } from './backup.ts';
import { MIGRATIONS } from './migrations.ts';
import { openDb } from './open.ts';

const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;
const AT = new Date(Date.UTC(2026, 9, 7, 6, 30, 0, 123));
const STAMP = '20261007T063000123Z';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-dbbak-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** version 以下のマイグレーションだけを当てた実物のファイルを作る。既存の DB からの移行を試すため。 */
function seedAt(file: string, version: number): void {
  const db = new Database(file);
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
    db.exec(m.sql);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, 1);
  }
  db.close();
}

/** そのファイルが当てた最後の版。 */
function versionOf(file: string): number {
  const db = new Database(file, { readonly: true });
  try { return (db.prepare('select max(version) v from schema_migrations').get() as { v: number }).v; } finally { db.close(); }
}

describe('openDb の控え', () => {
  it('当てていないマイグレーションがあれば、当てる前の DB を backups/db に控える', () => {
    const file = path.join(tmp, 'hangar.db');
    seedAt(file, LATEST - 1);
    openDb(file, { now: () => AT }).close();
    const dir = path.join(tmp, 'backups', 'db');
    const name = `hangar-v${LATEST - 1}-${STAMP}.db`;
    expect(fs.readdirSync(dir)).toEqual([name]);
    expect(versionOf(path.join(dir, name))).toBe(LATEST - 1);
    expect(versionOf(file)).toBe(LATEST);
    expectMode(path.join(dir, name), 0o600);
  });
  it('新しい DB、当てるものが無い DB、:memory: では控えない', () => {
    const file = path.join(tmp, 'hangar.db');
    openDb(file).close();
    openDb(file).close();
    openDb(':memory:').close();
    expect(fs.existsSync(path.join(tmp, 'backups'))).toBe(false);
  });
  it('控えが取れなければ、マイグレーションを当てずに理由を投げる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedAt(file, LATEST - 1);
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x');
    expect(() => openDb(file, { backupDir: path.join(tmp, 'blocker', 'db') })).toThrow(DbBackupError);
    expect(versionOf(file)).toBe(LATEST - 1);
  });
  it('控えは新しいものから 5 つ残し、控えの形でないファイルには触れない', () => {
    const dir = path.join(tmp, 'backups', 'db');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dir, `hangar-v3-2026010${i}T000000000Z.db`), '');
    fs.writeFileSync(path.join(dir, 'mine.db'), 'keep');
    const file = path.join(tmp, 'hangar.db');
    seedAt(file, LATEST - 1);
    openDb(file, { now: () => AT }).close();
    expect(fs.readdirSync(dir).sort()).toEqual([
      `hangar-v${LATEST - 1}-${STAMP}.db`,
      'hangar-v3-20260103T000000000Z.db', 'hangar-v3-20260104T000000000Z.db', 'hangar-v3-20260105T000000000Z.db', 'hangar-v3-20260106T000000000Z.db',
      'mine.db',
    ].sort());
  });
  it('写しの置き換えに失敗したら、控えの形のファイルも一時ファイルも残さず、マイグレーションを当てない', () => {
    const file = path.join(tmp, 'hangar.db');
    seedAt(file, LATEST - 1);
    const dir = path.join(tmp, 'backups', 'db');
    const name = `hangar-v${LATEST - 1}-${STAMP}.db`;
    // 控えの名前の場所にディレクトリがあると、一時ファイルからの改名が失敗する。
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    expect(() => openDb(file, { now: () => AT })).toThrow(DbBackupError);
    expect(versionOf(file)).toBe(LATEST - 1);
    expect(fs.readdirSync(dir)).toEqual([name]);
    expect(fs.statSync(path.join(dir, name)).isDirectory()).toBe(true);
  });
  it('時計が戻って新しい時刻の控えが 5 つ以上あっても、いま取った控えは刈らない', () => {
    const dir = path.join(tmp, 'backups', 'db');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(dir, `hangar-v3-209901${String(i).padStart(2, '0')}T000000000Z.db`), '');
    const file = path.join(tmp, 'hangar.db');
    seedAt(file, LATEST - 1);
    openDb(file, { now: () => AT }).close();
    expect(fs.readdirSync(dir).sort()).toEqual([
      `hangar-v${LATEST - 1}-${STAMP}.db`,
      'hangar-v3-20990102T000000000Z.db', 'hangar-v3-20990103T000000000Z.db', 'hangar-v3-20990104T000000000Z.db', 'hangar-v3-20990105T000000000Z.db',
    ].sort());
  });
  // シンボリックリンクは Unix でしか作れない（Windows では権限が要る）ので飛ばす。
  posixIt('backups/db がシンボリックリンクなら、リンクの先に何も書かず、マイグレーションを当てない', () => {
    const file = path.join(tmp, 'hangar.db');
    seedAt(file, LATEST - 1);
    const target = path.join(tmp, 'elsewhere');
    fs.mkdirSync(target);
    fs.mkdirSync(path.join(tmp, 'backups'));
    fs.symlinkSync(target, path.join(tmp, 'backups', 'db'));
    expect(() => openDb(file, { now: () => AT })).toThrow(DbBackupError);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(versionOf(file)).toBe(LATEST - 1);
  });
  // シンボリックリンクは Unix でしか作れないので飛ばす。
  posixIt('刈り込みは、控えの名前をしたシンボリックリンクを消さない', () => {
    const dir = path.join(tmp, 'backups', 'db');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 2; i <= 4; i++) fs.writeFileSync(path.join(dir, `hangar-v3-2026010${i}T000000000Z.db`), '');
    const outside = path.join(tmp, 'outside.db');
    fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, path.join(dir, 'hangar-v3-20260101T000000000Z.db'));
    pruneDbBackups(dir, 1);
    expect(fs.readdirSync(dir).sort()).toEqual(['hangar-v3-20260101T000000000Z.db', 'hangar-v3-20260104T000000000Z.db']);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
  });
});

describe('backupStamp', () => {
  it('UTC のミリ秒までを詰めた形で、辞書順がそのまま時刻順になる', () => {
    expect(backupStamp(AT)).toBe(STAMP);
    expect(backupStamp(new Date(Date.UTC(2026, 9, 7, 6, 30, 0, 124))) > STAMP).toBe(true);
  });
});
