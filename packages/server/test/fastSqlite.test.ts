import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relaxSqliteSync } from './fastSqlite.ts';

// Windows の CI では、ファイルの DB を開くたびの fsync が混んだディスクで数秒から数十秒かかり、
// 並んで走る別の試験（PowerShell の起動など）まで締め切りを越えた。試験の DB だけ、fsync を省く。
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-fastsqlite-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// Windows では setup-sqlite.ts が better-sqlite3 を差し替えるので、素の Database は importActual で取る。
const actual = async () => (await vi.importActual<{ default: typeof Database }>('better-sqlite3')).default;
const syncOf = (db: Database.Database) => db.pragma('synchronous', { simple: true });

describe('relaxSqliteSync', () => {
  it('ファイルの DB は synchronous = OFF（0）で開く。元の Database は FULL（2）のまま', async () => {
    const Plain = await actual();
    const Fast = relaxSqliteSync(Plain);
    const file = path.join(tmp, 'a.db');
    const plain = new Plain(file);
    try { expect(syncOf(plain)).toBe(2); } finally { plain.close(); }
    const db = new Fast(file);
    try { expect(syncOf(db)).toBe(0); } finally { db.close(); }
  });
  it('WAL にしても、読み書きと、閉じてからの開き直しは変わらない', async () => {
    const Fast = relaxSqliteSync(await actual());
    const file = path.join(tmp, 'b.db');
    const db = new Fast(file);
    db.pragma('journal_mode = WAL');
    db.exec('create table t (n integer)');
    db.prepare('insert into t values (?)').run(7);
    db.close();
    const again = new Fast(file, { readonly: true, fileMustExist: true });
    try { expect(again.prepare('select n from t').get()).toEqual({ n: 7 }); } finally { again.close(); }
  });
  it(':memory: と読み取り専用でも開け、Database の instanceof と静的な SqliteError を保つ', async () => {
    const Plain = await actual();
    const Fast = relaxSqliteSync(Plain);
    const mem = new Fast(':memory:');
    expect(mem).toBeInstanceOf(Plain);
    mem.close();
    expect(Fast.SqliteError).toBe(Plain.SqliteError);
    expect(() => new Fast(path.join(tmp, 'none.db'), { fileMustExist: true })).toThrow(/does not exist|unable to open/i);
  });
});
