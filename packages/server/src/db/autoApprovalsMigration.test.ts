import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-auto-approvals-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 59：統括の自動の許可の記録', () => {
  it('版 58 の DB を開くと、空の auto_approvals ができる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 58, () => undefined);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(59);
    expect(db.prepare('select count(*) c from auto_approvals').get()).toEqual({ c: 0 });
    db.prepare("insert into auto_approvals (id, at, session_id, title, tool, input, label, reason, policy_text) values ('a1', 1, 's1', 't', 'Read', '/x', 'Yes', 'r', null)").run();
    expect(db.prepare('select tool from auto_approvals').get()).toEqual({ tool: 'Read' });
    db.close();
  });
});
