import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-remote-shell-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 73：SSH のシェルタブの手元だけの表', () => {
  it('版 72 の DB から上がり、remote_tabs と remote_ssh_hosts ができて書ける', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 72, (db) => {
      expect(db.prepare("select count(*) c from sqlite_master where name in ('remote_tabs', 'remote_ssh_hosts')").get()).toEqual({ c: 0 });
    });
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(73);
    db.prepare("insert into remote_tabs (id, session_id, device_id, remote_name, title, created_at) values ('t1', 's1', 'd2', 'hangar-ssh-t1', 'Win', 1)").run();
    db.prepare("insert into remote_ssh_hosts (device_id, host, updated_at) values ('d2', 'win-box', 1)").run();
    expect(db.prepare('select kill_pending, closed_at from remote_tabs').get()).toEqual({ kill_pending: 0, closed_at: null });
    expect(db.prepare('select host from remote_ssh_hosts').get()).toEqual({ host: 'win-box' });
    db.close();
  });
});
