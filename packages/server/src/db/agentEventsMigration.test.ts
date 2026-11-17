import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

/**
 * 版 35 は、本文を DB に持つエージェント（opencode）の本文の表 agent_events を足す。
 * 1 行は正規化したイベント 1 つで、位置（session_id、agent_key、seq）は event_index と同じ番号である。
 * 表を足すだけで、既存の行（Claude の索引）には触らない。
 */
const BEFORE = 34;
const AFTER = 35;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-agent-events-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 35：本文を DB に持つエージェントの本文の表', () => {
  it('版 34 の DB を開くと版 35 へ上がり、空の agent_events ができる。既存の索引はそのまま残る', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
      db.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref) values ('s1', 0, 'user', 1, 0, 10, '/w/u1.jsonl')").run();
    });
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(AFTER);
    expect(db.prepare('select count(*) c from agent_events').get()).toEqual({ c: 0 });
    expect(db.prepare("select seq, kind, file_path_ref from event_index where session_id = 's1'").all()).toEqual([{ seq: 0, kind: 'user', file_path_ref: '/w/u1.jsonl' }]);
    db.close();
  });

  it('同じ位置の行は 1 つしか持てない', () => {
    const db = openDb(':memory:');
    const ins = db.prepare('insert into agent_events (session_id, agent_key, seq, body) values (?, ?, ?, ?)');
    ins.run('s1', '', 0, '{}');
    ins.run('s1', 'sub', 0, '{}');
    expect(() => ins.run('s1', '', 0, '{}')).toThrow();
    db.close();
  });
});
