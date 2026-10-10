import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

/**
 * 版 19 は、旧実装の設定の同期（sync/claudeConfig.ts。段 4 の PR 18 で消した）が端末に残した記録を、1 回だけ消す。
 * 残すと、降ろしの諦めの控え（skipped:(config)）が「諦めた本文」として画面に出続け、取り直しが設定の項目を本文として降ろそうとする。
 */
const BEFORE = 18;
const AFTER = 19;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-legacy-config-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const fileSync = (db: { prepare(sql: string): { run(...a: unknown[]): unknown } }, key: string, kind: string): void => {
  db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)').run(key, kind, `p-${key}`, 'dev-b', 's', 1, 1, 1, 1);
};
const state = (db: { prepare(sql: string): { run(...a: unknown[]): unknown } }, key: string, value: string): void => {
  db.prepare('insert into sync_state (key, value) values (?, ?)').run(key, value);
};

describe('版 19：旧実装の設定の同期の記録', () => {
  it('版 18 の DB を開くと版 19 へ上がり、設定の行と鍵だけが消え、本文の記録は残る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      fileSync(db, 'config/dev-b/CLAUDE.md', 'config');
      fileSync(db, 'config/dev-b/skills/x/SKILL.md', 'config');
      fileSync(db, 'transcripts/dev-b/u.jsonl.gz', 'transcript');
      state(db, 'configPullConfirmed', '1');
      state(db, 'configPending', '[]');
      state(db, 'skipped:(config)', '{}');
      state(db, 'skipped:transcripts/dev-b/u.jsonl.gz', '{}');
      state(db, 'filesSeq', '9');
    });
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBe(AFTER);
    expect(db.prepare('select key from file_sync order by key').all()).toEqual([{ key: 'transcripts/dev-b/u.jsonl.gz' }]);
    expect(db.prepare('select key from sync_state order by key').all()).toEqual([{ key: 'filesSeq' }, { key: 'skipped:transcripts/dev-b/u.jsonl.gz' }]);
    db.close();
  });

  it('新しい設定の同期の表（config_*）には触らない', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      db.prepare('insert into config_base (item_id, sha256, synced_at) values (?,?,?)').run('file:CLAUDE.md', 'x', 1);
    });
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(db.prepare('select item_id from config_base').all()).toEqual([{ item_id: 'file:CLAUDE.md' }]);
    db.close();
  });
});
