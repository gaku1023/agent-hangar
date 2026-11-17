import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

/**
 * 版 65 は、event_index が行ごとに持っていたファイルのパス（file_path_ref）を、別の表 event_paths の番号（path_id）で指すようにする。
 * 同じパスは 1 行にまとまり、元の列は無くなる。
 */
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-path-ref-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 65：パスを番号で指す', () => {
  it('版 64 の DB を開くと、同じパスの行は同じ番号を指し、元の列は無くなる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 60, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
      const ins = db.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref) values ('s1', ?, 'user', 1, ?, 10, ?)");
      ins.run(0, 0, '/w/a.jsonl');
      ins.run(1, 10, '/w/a.jsonl');
      ins.run(2, 0, '/w/b.jsonl');
    });
    expect(dbVersionOf(file)).toBe(60);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(65);
    expect(db.prepare('select e.seq, p.path from event_index e join event_paths p on p.id = e.path_id order by e.seq').all())
      .toEqual([{ seq: 0, path: '/w/a.jsonl' }, { seq: 1, path: '/w/a.jsonl' }, { seq: 2, path: '/w/b.jsonl' }]);
    expect(db.prepare('select count(*) c from event_paths').get()).toEqual({ c: 2 });
    const cols = (db.prepare("select name from pragma_table_info('event_index')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('file_path_ref');
    expect(cols).toContain('path_id');
    db.close();
  });
});

describe('版 65 のあとの縮め', () => {
  it('書き直しで縮んだ行は、VACUUM でファイルの大きさに現す', () => {
    const file = path.join(tmp, 'big.db');
    seedDbAt(file, 60, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
      const ins = db.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref) values ('s1', ?, 'user', 1, ?, 10, ?)");
      db.transaction(() => { for (let i = 0; i < 100000; i++) ins.run(i, i * 10, `/w/${'x'.repeat(130)}${i % 50}.jsonl`); })();
    });
    const sizeBefore = fs.statSync(file).size;
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    db.pragma('wal_checkpoint(TRUNCATE)');
    expect(fs.statSync(file).size).toBeLessThan(sizeBefore * 0.5);
    expect(db.prepare('select count(*) c from event_index').get()).toEqual({ c: 100000 });
    db.close();
  });
});

describe('版 65 に上がるときの控え', () => {
  it('版 60 の DB（パスの文字を持つ形）の控えは、索引を抜いても開け、行の元のパスは落とさない（jsonl が無い会話）', () => {
    const file = path.join(tmp, 'old.db');
    const gone = path.join(tmp, 'gone.jsonl');
    const live = path.join(tmp, 'live.jsonl');
    fs.writeFileSync(live, '{}\n');
    seedDbAt(file, 60, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
      const ins = db.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref) values ('s1', ?, 'user', 1, 0, 10, ?)");
      ins.run(0, gone);
      ins.run(1, live);
      const tf = db.prepare("insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?, 's1', ?, 1, 1, 1, 1)");
      tf.run(gone, null);
      tf.run(live, 'a1');
    });
    openDb(file, { backupDir: path.join(tmp, 'backups'), now: () => new Date('2026-11-18T00:00:00Z') }).close();
    const bak = fs.readdirSync(path.join(tmp, 'backups')).find((f) => f.endsWith('.db'))!;
    const raw = new Database(path.join(tmp, 'backups', bak), { readonly: true });
    // 元のファイルが無い会話の行は、控えに残る。
    expect(raw.prepare('select file_path_ref p from event_index').all()).toEqual([{ p: gone }]);
    expect(raw.prepare('select path from transcript_files where indexer_version = 0').all()).toEqual([{ path: live }]);
    raw.close();
  });
});
