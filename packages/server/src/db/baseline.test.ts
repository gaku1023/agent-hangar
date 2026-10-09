import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_MIGRATIONS } from '../../test/legacyMigrations.ts';
import { BASELINE_DB_VERSION, dbVersionOf, LATEST_DB_VERSION, nextMigration, seedDbAt } from '../../test/oldDb.ts';
import { BASELINE_VERSION, MIGRATIONS } from './migrations.ts';
import { DbTooOldError, openDb } from './open.ts';

type Raw = Database.Database;
type Row = Record<string, unknown>;

/** 空白と引用符の違いだけを均す。語の並び、型、既定値、制約はそのまま残す。 */
function normalizeSql(sql: string | null): string | null {
  if (sql === null) return null;
  return sql.replace(/["`]/g, '').replace(/\s+/g, ' ').replace(/\s*([(),=])\s*/g, '$1').trim();
}

/**
 * スキーマと中身の写し。
 * sqlite_master の全行（表、索引、トリガー、ビュー、FTS の仮想表とその影の表）と、
 * 表ごとの列（順、型、not null、既定値、主キー、隠し列）、外部キー、索引の列を持つ。
 * rootpage は作る順で変わるので見ない。
 * schema_migrations の中身だけは、当てた版の並びが違って当然なので除く。
 */
function snapshot(db: Raw): { master: Row[]; tables: Record<string, Row>; data: Record<string, Row[]> } {
  const master = (db.prepare('select type, name, tbl_name, sql from sqlite_master order by type, name').all() as { type: string; name: string; tbl_name: string; sql: string | null }[])
    .map((r) => ({ ...r, sql: normalizeSql(r.sql) }));
  const tables: Record<string, Row> = {};
  const data: Record<string, Row[]> = {};
  for (const t of master.filter((r) => r.type === 'table')) {
    const indexes = (db.prepare('select name, "unique", origin, partial from pragma_index_list(?) order by name').all(t.name) as { name: string }[])
      .map((i) => ({ ...i, columns: db.prepare('select seqno, cid, name, "desc", coll, key from pragma_index_xinfo(?) order by seqno').all(i.name) }));
    tables[t.name] = {
      columns: db.prepare('select cid, name, type, "notnull", dflt_value, pk, hidden from pragma_table_xinfo(?) order by cid').all(t.name),
      foreignKeys: db.prepare('select id, seq, "table", "from", "to", on_update, on_delete, match from pragma_foreign_key_list(?) order by id, seq').all(t.name),
      indexes,
    };
    if (t.name !== 'schema_migrations') data[t.name] = db.prepare(`select * from "${t.name}"`).all() as Row[];
  }
  return { master, tables, data };
}

/** 畳む前のマイグレーションを、版 1 から順に全部当てた DB。 */
function legacyDb(): Raw {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  for (const m of LEGACY_MIGRATIONS) {
    db.exec(m.sql);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, 1);
  }
  return db;
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-baseline-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('起点のマイグレーション', () => {
  it('畳む前のマイグレーションは版 1 から起点の版まで抜けなく並んでいる', () => {
    expect(LEGACY_MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: BASELINE_VERSION }, (_, i) => i + 1));
    expect(BASELINE_DB_VERSION).toBe(BASELINE_VERSION);
  });

  it('製品の一覧は起点から始まり、新しい DB は起点だけでいちばん新しい版になる', () => {
    expect(MIGRATIONS[0]!.version).toBe(BASELINE_VERSION);
    const db = openDb(':memory:');
    const versions = (db.prepare('select version from schema_migrations order by version').all() as { version: number }[]).map((r) => r.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    expect(versions[versions.length - 1]).toBe(LATEST_DB_VERSION);
    db.close();
  });

  it('起点だけを当てた DB と、版 1 から順に当てた DB で、スキーマと中身が一致する', () => {
    const legacy = legacyDb();
    // 起点の後ろに次の版が足されても、ここは起点だけを比べる。
    const fresh = openDb(':memory:', { migrations: MIGRATIONS.filter((m) => m.version === BASELINE_VERSION) });
    const a = snapshot(legacy);
    const b = snapshot(fresh);
    // 表、索引、仮想表、影の表の名前がそろっていること（どちらかにしか無いものを、先に名前で見せる）。
    expect(b.master.map((r) => `${r.type}:${r.name}`)).toEqual(a.master.map((r) => `${r.type}:${r.name}`));
    expect(b.master).toEqual(a.master);
    expect(b.tables).toEqual(a.tables);
    // マイグレーションが入れた行（FTS の影の表の初期の行を含む）も同じであること。
    expect(b.data).toEqual(a.data);
    // 突き合わせが空を比べていないこと。
    expect(a.master.filter((r) => r.type === 'table').length).toBeGreaterThan(20);
    expect(a.master.some((r) => r.name === 'event_fts' && String(r.sql).startsWith('CREATE VIRTUAL TABLE'))).toBe(true);
    expect(a.master.some((r) => r.name === 'event_fts_data')).toBe(true);
    expect(a.data.event_fts_config!.length).toBeGreaterThan(0);
    legacy.close();
    fresh.close();
  });

  it('突き合わせは空白と引用の違いを見逃し、列の順、型、既定値、制約の違いは落とす', () => {
    const shot = (sql: string) => {
      const db = new Database(':memory:');
      db.exec(sql);
      const s = snapshot(db);
      db.close();
      return s;
    };
    const base = shot("create table t (a text not null, b integer not null default 0 check (b in (0, 1)));\ncreate index t_b on t(b, a);");
    expect(shot('create table "t" (\n  a text not null,\n  b integer not null default 0 check (b in (0,1))\n);\ncreate index t_b on t (b, a);')).toEqual(base);
    for (const [what, sql] of [
      ['列の順', 'create table t (b integer not null default 0 check (b in (0, 1)), a text not null); create index t_b on t(b, a);'],
      ['型', 'create table t (a text not null, b text not null default 0 check (b in (0, 1))); create index t_b on t(b, a);'],
      ['既定値', 'create table t (a text not null, b integer not null default 1 check (b in (0, 1))); create index t_b on t(b, a);'],
      ['not null', 'create table t (a text, b integer not null default 0 check (b in (0, 1))); create index t_b on t(b, a);'],
      ['check', 'create table t (a text not null, b integer not null default 0 check (b in (0, 2))); create index t_b on t(b, a);'],
      ['索引の列の順', 'create table t (a text not null, b integer not null default 0 check (b in (0, 1))); create index t_b on t(a, b);'],
      ['索引が無い', 'create table t (a text not null, b integer not null default 0 check (b in (0, 1)));'],
    ] as const) {
      expect(shot(sql), what).not.toEqual(base);
    }
  });
});

describe('起点より古い版の DB', () => {
  it('開かずに断り、DB にも控えの置き場にも何も書かない', () => {
    for (const from of [1, 9, BASELINE_VERSION - 1]) {
      const dir = fs.mkdtempSync(path.join(tmp, 'old-'));
      const file = path.join(dir, 'hangar.db');
      seedDbAt(file, from);
      const before = fs.readFileSync(file);
      let err: unknown;
      try { openDb(file).close(); } catch (e) { err = e; }
      expect(err, `from ${from}`).toBeInstanceOf(DbTooOldError);
      const e = err as DbTooOldError;
      expect(e.found).toBe(from);
      expect(e.baseline).toBe(BASELINE_VERSION);
      // どの版の DB か、起点の版はいくつか、どうすればよいかを言う。
      expect(e.message).toContain(`版 ${from}`);
      expect(e.message).toContain(`版 ${BASELINE_VERSION}`);
      expect(e.message).toContain(file);
      expect(e.message).toContain('もう一度起動してください');
      expect(e.message).not.toContain('\n');
      expect(fs.readFileSync(file).equals(before), `from ${from}`).toBe(true);
      expect(dbVersionOf(file)).toBe(from);
      expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    }
  });
});

describe('いちばん新しい版の DB', () => {
  it('版 1 から順に上がってきた DB を、何も当てず、控えも取らずに開く', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION, (db) => {
      db.prepare("insert into projects (id, name, status, is_scratch, updated_at, origin_device) values ('p1', 'a', 'active', 0, 1, 'd')").run();
    });
    const rows = (f: string) => {
      const db = new Database(f, { readonly: true });
      try { return db.prepare('select version, applied_at from schema_migrations order by version').all(); } finally { db.close(); }
    };
    const before = rows(file);
    expect(before).toHaveLength(LATEST_DB_VERSION);
    const db = openDb(file);
    expect(db.prepare('select id, name from projects').all()).toEqual([{ id: 'p1', name: 'a' }]);
    db.close();
    // 起点の行を当て直していない（版も当てた時刻もそのまま）。
    expect(rows(file)).toEqual(before);
    expect(fs.existsSync(path.join(tmp, 'backups'))).toBe(false);
  });
});

describe('起点の後のマイグレーション', () => {
  it('一覧の末尾に次の版を足すと、既存の DB には控えを取ってからその 1 本だけを当て、新しい DB には起点から順に当てる', () => {
    const next = nextMigration();
    expect(next.version).toBe(LATEST_DB_VERSION + 1);
    const migrations = [...MIGRATIONS, next];
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION);
    const at = new Date(Date.UTC(2026, 9, 9, 1, 2, 3, 4));
    const db = openDb(file, { migrations, now: () => at });
    expect(db.prepare("select name from sqlite_master where name = 'next_probe'").get()).toEqual({ name: 'next_probe' });
    db.close();
    expect(dbVersionOf(file)).toBe(next.version);
    const backups = fs.readdirSync(path.join(tmp, 'backups', 'db'));
    expect(backups).toEqual([`hangar-v${LATEST_DB_VERSION}-20261009T010203004Z.db`]);
    expect(dbVersionOf(path.join(tmp, 'backups', 'db', backups[0]!))).toBe(LATEST_DB_VERSION);
    // もう一度開いても当て直さず、控えも増えない。
    openDb(file, { migrations }).close();
    expect(fs.readdirSync(path.join(tmp, 'backups', 'db'))).toHaveLength(1);

    const fresh = openDb(':memory:', { migrations });
    expect((fresh.prepare('select version from schema_migrations order by version').all() as { version: number }[]).map((r) => r.version)).toEqual(migrations.map((m) => m.version));
    expect(fresh.prepare("select name from sqlite_master where name = 'next_probe'").get()).toEqual({ name: 'next_probe' });
    fresh.close();
  });
});
