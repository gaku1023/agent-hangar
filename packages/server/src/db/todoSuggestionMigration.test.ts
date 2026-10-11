import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { listTodos } from '../projects/todos.ts';
import { openDb } from './open.ts';

/**
 * 版 20 は、todos に Claude の提案の 2 列（suggested_at、suggested_note）を足す。
 * 既存の行は null のままで、提案ではない（利用者が足した確定の TODO として読む）。
 */
const BEFORE = 19;
const AFTER = 20;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-todo-suggestion-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 20：TODO の提案の列', () => {
  it('版 19 の DB を開くと版 20 へ上がり、既存の TODO は提案でないまま残る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      db.prepare("insert into projects (id, name, status, is_scratch, updated_at, origin_device) values ('p1', 'a', 'active', 0, 1, 'd')").run();
      db.prepare("insert into todos (id, project_id, text, done, position, updated_at, origin_device) values ('t1', 'p1', 'やる', 0, 1, 1, 'd')").run();
    });
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(AFTER);
    const cols = (db.prepare('pragma table_info(todos)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['suggested_at', 'suggested_note']));
    expect(db.prepare('select suggested_at, suggested_note from todos').get()).toEqual({ suggested_at: null, suggested_note: null });
    expect(listTodos(db, 'p1')).toEqual([expect.objectContaining({ id: 't1', suggestion: null })]);
    // 未完の数にも数える。
    expect(db.prepare("select count(*) c from todos where project_id = 'p1' and done = 0 and suggested_at is null and deleted_at is null").get()).toEqual({ c: 1 });
    db.close();
  });
});
