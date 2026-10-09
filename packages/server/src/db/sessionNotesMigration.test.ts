import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { MIGRATED_NOTE_AT } from './migrations.ts';
import { openDb, type Db } from './open.ts';

/** 版 17 は、セッションの名前とメモを sessions から session_notes へ移す。 */
const BEFORE = 16;
const AFTER = 17;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-notes-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

type Old = { id: string; name?: string | null; memo?: string | null; updatedAt: number; origin?: string; deletedAt?: number | null };

/** 版 16 の sessions に、名前とメモを持つ行を仕込む。 */
function seedOld(db: Db, rows: Old[]): void {
  const ins = db.prepare('insert into sessions (id, provider, provider_session_id, name, cwd, home_device, memo, updated_at, deleted_at, origin_device) values (?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(r.id, 'claude-code', `u-${r.id}`, r.name ?? null, '/w', 'dev-a', r.memo ?? null, r.updatedAt, r.deletedAt ?? null, r.origin ?? 'dev-a');
}

const columns = (db: Db, table: string): string[] => (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const notes = (db: Db) => db.prepare('select session_id, name, memo, updated_at, deleted_at, origin_device from session_notes order by session_id').all();

function migrate(rows: Old[]): Db {
  const file = path.join(tmp, 'hangar.db');
  seedDbAt(file, BEFORE, (db) => seedOld(db, rows));
  return openDb(file, { backupDir: path.join(tmp, 'backups') });
}

describe('版 17：名前とメモを session_notes へ移す', () => {
  it('新しい DB には session_notes があり、sessions に name と memo が無い', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'session_notes')).toEqual(['session_id', 'name', 'memo', 'updated_at', 'deleted_at', 'origin_device']);
    expect(columns(db, 'sessions')).not.toContain('name');
    expect(columns(db, 'sessions')).not.toContain('memo');
    // 索引が本文から拾う題名は、sessions の側の別の事実として持つ。
    expect(columns(db, 'sessions')).toContain('custom_title');
    db.close();
  });

  it('いまの名前とメモを、写しの定数の時刻と、sessions の行の書き手で写し、sessions の列を落とす', () => {
    const db = migrate([
      { id: 's1', name: '名前だけ', updatedAt: 100 },
      { id: 's2', memo: 'メモだけ', updatedAt: 200, origin: 'dev-b' },
      { id: 's3', name: '両方', memo: '両方のメモ', updatedAt: 300 },
    ]);
    expect(dbVersionOf(path.join(tmp, 'hangar.db'))).toBe(AFTER);
    expect(notes(db)).toEqual([
      { session_id: 's1', name: '名前だけ', memo: null, updated_at: MIGRATED_NOTE_AT, deleted_at: null, origin_device: 'dev-a' },
      { session_id: 's2', name: null, memo: 'メモだけ', updated_at: MIGRATED_NOTE_AT, deleted_at: null, origin_device: 'dev-b' },
      { session_id: 's3', name: '両方', memo: '両方のメモ', updated_at: MIGRATED_NOTE_AT, deleted_at: null, origin_device: 'dev-a' },
    ]);
    expect(columns(db, 'sessions')).not.toContain('name');
    expect(columns(db, 'sessions')).not.toContain('memo');
    // sessions のほかの列と行は、そのまま残る。
    expect(db.prepare('select id, provider_session_id, cwd, updated_at, custom_title from sessions order by id').all()).toEqual([
      { id: 's1', provider_session_id: 'u-s1', cwd: '/w', updated_at: 100, custom_title: null },
      { id: 's2', provider_session_id: 'u-s2', cwd: '/w', updated_at: 200, custom_title: null },
      { id: 's3', provider_session_id: 'u-s3', cwd: '/w', updated_at: 300, custom_title: null },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('名前もメモも無い行（null、空、空白だけ）には、空の行を作らない', () => {
    const db = migrate([
      { id: 's1', updatedAt: 100 },
      { id: 's2', name: '', memo: '', updatedAt: 200 },
      { id: 's3', name: '  ', memo: ' \n ', updatedAt: 300 },
      { id: 's4', name: '', memo: '残す', updatedAt: 400 },
    ]);
    expect(notes(db)).toEqual([{ session_id: 's4', name: null, memo: '残す', updated_at: MIGRATED_NOTE_AT, deleted_at: null, origin_device: 'dev-a' }]);
    db.close();
  });

  it('写した行を、まだ送っていない差分として changes に積む（クラウドへ上げるため）', () => {
    const db = migrate([
      { id: 's1', name: 'N', memo: 'M', updatedAt: 100, origin: 'dev-b' },
      { id: 's2', updatedAt: 200 },
    ]);
    const rows = db.prepare("select table_name, row_id, op, payload, updated_at, device_id, pushed_at from changes where table_name = 'session_notes'").all() as { payload: string }[];
    expect(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as unknown }))).toEqual([{
      table_name: 'session_notes', row_id: 's1', op: 'upsert', updated_at: MIGRATED_NOTE_AT, device_id: 'dev-b', pushed_at: null,
      payload: { session_id: 's1', name: 'N', memo: 'M', updated_at: MIGRATED_NOTE_AT, deleted_at: null, origin_device: 'dev-b' },
    }]);
    db.close();
  });

  it('消したセッションの名前とメモも写す（同期で生き返ることがある）', () => {
    const db = migrate([{ id: 's1', name: 'N', updatedAt: 100, deletedAt: 90 }]);
    expect(notes(db)).toHaveLength(1);
    db.close();
  });

  it('当てる前に、版 16 の DB の控えを取る。控えには名前とメモが sessions の列のまま残る', () => {
    const db = migrate([{ id: 's1', name: 'N', memo: 'M', updatedAt: 100 }]);
    db.close();
    const files = fs.readdirSync(path.join(tmp, 'backups'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(`v${BEFORE}`);
    const backup = openDb(path.join(tmp, 'backups', files[0]!), { migrations: [] });
    expect(backup.prepare('select name, memo from sessions where id = ?').get('s1')).toEqual({ name: 'N', memo: 'M' });
    expect(backup.prepare("select 1 from sqlite_master where name = 'session_notes'").get()).toBeUndefined();
    backup.close();
  });

  it('もう一度開いても、写しも差分も増えない', () => {
    const db = migrate([{ id: 's1', name: 'N', updatedAt: 100 }]);
    db.close();
    const again = openDb(path.join(tmp, 'hangar.db'), { backupDir: path.join(tmp, 'backups') });
    expect(notes(again)).toHaveLength(1);
    expect((again.prepare("select count(*) c from changes where table_name = 'session_notes'").get() as { c: number }).c).toBe(1);
    expect(fs.readdirSync(path.join(tmp, 'backups'))).toHaveLength(1);
    again.close();
  });
});
