import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb, type Db } from './open.ts';
import { upsertShared } from './shared.ts';

/** 版 18 は、設定の同期の作り直し用の 3 表（束、基準、送らなかった項目）を足す。 */
const BEFORE = 17;
const AFTER = 18;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-config-sync-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const columns = (db: Db, table: string): string[] => (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('版 18：設定の同期の表', () => {
  it('新しい DB には 3 表があり、束だけが共有テーブルの列を持つ', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'config_snapshots')).toEqual(['device_id', 'bundle_sha256', 'bundle_size', 'item_count', 'manifest', 'updated_at', 'deleted_at', 'origin_device']);
    expect(columns(db, 'config_base')).toEqual(['item_id', 'sha256', 'synced_at']);
    expect(columns(db, 'config_unsent')).toEqual(['id', 'kind', 'item_id', 'label', 'reason', 'content_sha256', 'allowed', 'found_at']);
    db.close();
  });

  it('版 17 の DB を開くと版 18 へ上がり、既存の行はそのまま残る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      db.prepare('insert into devices (id, name, platform, updated_at, origin_device) values (?,?,?,?,?)').run('dev-a', 'mac', 'darwin', 1, 'dev-a');
    });
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBe(AFTER);
    expect(db.prepare('select id, name from devices').all()).toEqual([{ id: 'dev-a', name: 'mac' }]);
    expect(db.prepare('select count(*) n from config_snapshots').get()).toEqual({ n: 0 });
    db.close();
  });

  it('束の行は共有テーブルとして changes に積まれ、1 台 1 行である', () => {
    const db = openDb(':memory:');
    const row = { device_id: 'dev-a', bundle_sha256: 'a'.repeat(64), bundle_size: 10, item_count: 2, manifest: '[]' };
    upsertShared(db, 'config_snapshots', row, 'dev-a', 'device_id');
    upsertShared(db, 'config_snapshots', { ...row, bundle_sha256: 'b'.repeat(64) }, 'dev-a', 'device_id');
    expect(db.prepare('select device_id, bundle_sha256 from config_snapshots').all()).toEqual([{ device_id: 'dev-a', bundle_sha256: 'b'.repeat(64) }]);
    // 送っていない差分は、同じ行について最後の 1 つだけである。
    expect(db.prepare("select row_id, op from changes where table_name = 'config_snapshots' and pushed_at is null").all()).toEqual([{ row_id: 'dev-a', op: 'upsert' }]);
    db.close();
  });

  it('送らなかった項目の種類は 2 つに限る', () => {
    const db = openDb(':memory:');
    const ins = (kind: string) => db.prepare('insert into config_unsent (id, kind, item_id, label, reason, content_sha256, found_at) values (?,?,?,?,?,?,?)').run(`k-${kind}`, kind, 'x', 'x', 'r', 's', 1);
    expect(() => ins('secret')).not.toThrow();
    expect(() => ins('permission-rule')).not.toThrow();
    expect(() => ins('other')).toThrow();
    db.close();
  });
});
