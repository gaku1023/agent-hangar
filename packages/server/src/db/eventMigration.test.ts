import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-event-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 55：結び付けと履歴と PR の持ち主の表', () => {
  it('migration 55 creates tables on a v54 db', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 54, () => undefined);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(55);
    for (const t of ['event_bindings', 'event_runs', 'event_deliveries', 'session_prs']) {
      expect(db.prepare(`select count(*) c from ${t}`).get()).toEqual({ c: 0 });
    }
    const cols = (db.prepare('pragma table_info(session_states)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('candidate_wake_on');
    db.close();
  });
});

describe('版 56：webhook と受け箱の後片付けの預かり', () => {
  it('migration 56 creates the orphan table on a v55 db', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 55, () => undefined);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(56);
    expect(db.prepare('select count(*) c from event_hook_orphans').get()).toEqual({ c: 0 });
    db.close();
  });
});
