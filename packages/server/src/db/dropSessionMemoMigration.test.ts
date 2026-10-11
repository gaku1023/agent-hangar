import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb, type Db } from './open.ts';

/**
 * 版 21 は、セッションのノート（session_notes.memo）を落とす。
 * 名前（session_notes.name）は残す。
 * 中身は、当てる前に取る DB の控え（backups/db）に残る。
 */
const BEFORE = 20;
const AFTER = 21;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-drop-session-memo-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const columns = (db: Db, table: string): string[] => (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('版 21：セッションのノートを落とす', () => {
  it('新しい DB の session_notes に memo の列が無い', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'session_notes')).toEqual(['session_id', 'name', 'updated_at', 'deleted_at', 'origin_device']);
    db.close();
  });

  it('版 20 の DB を開くと memo の列だけが落ち、名前と時刻と書き手はそのまま残る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      const s = db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values (?, 'claude-code', ?, '/w', 'dev-a', 1, 'dev-a')");
      for (const id of ['s1', 's2', 's3']) s.run(id, `u-${id}`);
      const n = db.prepare('insert into session_notes (session_id, name, memo, updated_at, deleted_at, origin_device) values (?,?,?,?,?,?)');
      n.run('s1', '名前', 'ノート', 100, null, 'dev-a');
      n.run('s2', null, 'ノートだけ', 200, null, 'dev-b');
      n.run('s3', '消した', null, 300, 300, 'dev-a');
    });
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(AFTER);
    expect(columns(db, 'session_notes')).not.toContain('memo');
    expect(db.prepare('select * from session_notes order by session_id').all()).toEqual([
      { session_id: 's1', name: '名前', updated_at: 100, deleted_at: null, origin_device: 'dev-a' },
      { session_id: 's2', name: null, updated_at: 200, deleted_at: null, origin_device: 'dev-b' },
      { session_id: 's3', name: '消した', updated_at: 300, deleted_at: 300, origin_device: 'dev-a' },
    ]);
    // まだ送っていない差分は作らない。落とすのはこの PC の表の形だけで、他の PC の行には触らない。
    expect(db.prepare("select count(*) n from changes where table_name = 'session_notes'").get()).toEqual({ n: 0 });
    db.close();
  });

  it('当てる前の DB の控えに、ノートの中身が残る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u-s1', '/w', 'dev-a', 1, 'dev-a')").run();
      db.prepare("insert into session_notes (session_id, name, memo, updated_at, deleted_at, origin_device) values ('s1', null, '残したいノート', 1, null, 'dev-a')").run();
    });
    openDb(file, { backupDir: path.join(tmp, 'backups', 'db') }).close();
    const files = fs.readdirSync(path.join(tmp, 'backups', 'db'));
    expect(files).toHaveLength(1);
    const backup = new Database(path.join(tmp, 'backups', 'db', files[0]!), { readonly: true });
    try {
      expect(backup.prepare("select memo from session_notes where session_id = 's1'").get()).toEqual({ memo: '残したいノート' });
    } finally {
      backup.close();
    }
  });
});
