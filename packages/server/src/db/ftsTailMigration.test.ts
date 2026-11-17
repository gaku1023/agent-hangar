import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { FTS_TAIL } from '../search/ftsTail.ts';
import { searchSessions } from '../search/search.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-fts-tail-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 66：event_fts の末尾に区切りを足す', () => {
  it('版 61 の DB を開くと、今ある行の末尾に区切りが付き、末尾の 2 文字が引ける', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 61, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
      const ins = db.prepare('insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)');
      ins.run('s1', null, 0, 'user', 'これは設計の相談');
      ins.run('s1', null, 1, 'user', '');
    });
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(66);
    const rows = db.prepare('select seq, text from event_fts order by seq').all() as { seq: number; text: string }[];
    expect(rows.map((r) => r.text)).toEqual(['これは設計の相談' + FTS_TAIL, FTS_TAIL]);
    const r = searchSessions(db, { q: '相談' });
    expect(r.total).toBe(1);
    expect(r.hits[0]!.snippets[0]!.text).toBe('これは設計の相談');
    db.close();
  });
});
