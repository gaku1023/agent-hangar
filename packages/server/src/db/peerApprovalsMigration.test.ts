import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-peer-approvals-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 52：別の PC への起動の承認待ちの表', () => {
  it('版 49 の DB を開くと、空の peer_approvals ができ、頼みの ID ごとに 1 行だけ持てる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 49, () => undefined);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(52);
    expect(db.prepare('select count(*) c from peer_approvals').get()).toEqual({ c: 0 });
    const ins = db.prepare("insert into peer_approvals (id, caller_session_id, to_device, to_name, request, created_at) values (?, 's1', 'd2', 'laptop', '{}', 1)");
    ins.run('r1');
    expect(() => ins.run('r1')).toThrow();
    expect(db.prepare("select state, scratch from peer_approvals where id = 'r1'").get()).toEqual({ state: 'pending', scratch: 0 });
    db.close();
  });
});
