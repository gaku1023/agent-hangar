import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-peer-relay-ended-at-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 63：結果の返却の行の終わった時刻と、送れなくなった控えの片付け', () => {
  it('終わった行に終わった時刻を埋め、行の消えた控えは頼んだ PC が分かれば行を作り直し、分からなければ外す', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 60, (db) => {
      db.prepare("insert into peer_relay (session_id, request_id, from_device, seq, armed_at, ended, title, created_at) values ('s-ended', 'r-ended', 'pc-a', 2, null, 1, 't', 100)").run();
      db.prepare("insert into peer_relay (session_id, request_id, from_device, seq, armed_at, ended, title, created_at) values ('s-open', 'r-open', 'pc-a', 1, 5, 0, 't', 200)").run();
      // 行が先に消えて送れなくなった ended。受けた頼みの記録があるものと、無いもの。
      db.prepare("insert into peer_relay_out (request_id, seq, payload, sent, created_at) values ('r-lost', 3, '{}', 0, 900)").run();
      db.prepare("insert into peer_relay_out (request_id, seq, payload, sent, created_at) values ('r-lost', 2, '{}', 1, 800)").run();
      db.prepare("insert into peer_launches (id, from_device, handled_at, result, ok, answered, session_id, parent_session_id) values ('r-lost', 'pc-c', 50, 'started', 1, 1, 's-lost', 'p-1')").run();
      db.prepare("insert into peer_relay_out (request_id, seq, payload, sent, created_at) values ('r-gone', 1, '{}', 0, 700)").run();
    });
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(63);
    const rows = db.prepare('select session_id, request_id, from_device, seq, ended, ended_at from peer_relay order by session_id').all();
    expect(rows).toEqual([
      { session_id: 's-ended', request_id: 'r-ended', from_device: 'pc-a', seq: 2, ended: 1, ended_at: 100 },
      { session_id: 's-lost', request_id: 'r-lost', from_device: 'pc-c', seq: 3, ended: 1, ended_at: 900 },
      { session_id: 's-open', request_id: 'r-open', from_device: 'pc-a', seq: 1, ended: 0, ended_at: null },
    ]);
    expect(db.prepare('select request_id, seq, sent from peer_relay_out order by request_id, seq').all()).toEqual([
      { request_id: 'r-lost', seq: 2, sent: 1 },
      { request_id: 'r-lost', seq: 3, sent: 0 },
    ]);
    db.close();
  });
});
