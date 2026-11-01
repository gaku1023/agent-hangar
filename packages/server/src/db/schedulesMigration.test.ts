import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-schedules-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 45：予定と履歴の表', () => {
  it('版 44 の DB を開くと、空の schedules と schedule_runs ができる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 44, () => undefined);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(45);
    expect(db.prepare('select count(*) c from schedules').get()).toEqual({ c: 0 });
    expect(db.prepare('select count(*) c from schedule_runs').get()).toEqual({ c: 0 });
    db.close();
  });
});
