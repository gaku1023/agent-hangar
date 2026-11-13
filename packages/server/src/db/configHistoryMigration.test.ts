import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-config-history-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 58：設定の適用の履歴', () => {
  it('版 56 の DB を開くと、空の config_history ができる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 56, () => undefined);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(58);
    const cols = (db.prepare('pragma table_info(config_history)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'at', 'from_device', 'mode', 'items', 'generations', 'undone', 'seen']);
    expect(db.prepare('select count(*) c from config_history').get()).toEqual({ c: 0 });
    db.close();
  });
});
