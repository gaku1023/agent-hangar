import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-delete-approvals-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 44：削除の承認の表', () => {
  it('版 43 の DB を開くと、空の delete_approvals ができ、会話 1 つに 1 行だけ持てる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 43, () => undefined);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(44);
    expect(db.prepare('select count(*) c from delete_approvals').get()).toEqual({ c: 0 });
    const ins = db.prepare("insert into delete_approvals (id, session_id, from_session_id, requested_at, state) values (?, 's1', null, 1, 'pending')");
    ins.run('a1');
    expect(() => ins.run('a2')).toThrow();
    db.close();
  });
});
