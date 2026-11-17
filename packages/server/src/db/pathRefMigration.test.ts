import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';
import { EVENT_PATH_SQL, fillPathRefs, fillPathRefsAfter, startPathRefFill } from './pathRef.ts';

/**
 * 版 65 は、event_index が行ごとに持っていたファイルのパス（file_path_ref）を、別の表 event_paths の番号（path_id）で指すようにする。
 * 開くときは表と列を足すだけで、行の書き直しは起動後に背面で数千行ずつ進める（埋め終えるまでは旧い列で読む）。
 */
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-path-ref-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 65：パスを番号で指す', () => {
  const seed = (file: string, rows: number): void => {
    seedDbAt(file, 60, (db) => {
      db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
      const ins = db.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref) values ('s1', ?, 'user', 1, ?, 10, ?)");
      db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(i, i * 10, i % 3 === 2 ? '/w/b.jsonl' : '/w/a.jsonl'); })();
    });
  };

  it('版 60 の DB を開くときは、表と列を足すだけで行を書き直さず、旧い列の値を残す', () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 5);
    expect(dbVersionOf(file)).toBe(60);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(65);
    expect(db.prepare('select count(*) c from event_paths').get()).toEqual({ c: 0 });
    expect(db.prepare('select count(*) c from event_index where path_id is null and file_path_ref <> \'\'').get()).toEqual({ c: 5 });
    db.close();
  });

  it('起動後の埋めは、数行ずつ番号を振って旧い列を空にし、同じパスは 1 行にまとめ、何度呼んでも壊れない', () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 7);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(fillPathRefs(db, 3)).toBe(3);
    expect(db.prepare('select count(*) c from event_index where path_id is null').get()).toEqual({ c: 4 });
    expect(fillPathRefs(db, 3)).toBe(3);
    expect(fillPathRefs(db, 3)).toBe(1);
    expect(fillPathRefs(db, 3)).toBe(0);
    expect(db.prepare('select e.seq, p.path from event_index e join event_paths p on p.id = e.path_id order by e.seq').all())
      .toEqual([0, 1, 2, 3, 4, 5, 6].map((seq) => ({ seq, path: seq % 3 === 2 ? '/w/b.jsonl' : '/w/a.jsonl' })));
    expect(db.prepare('select count(*) c from event_paths').get()).toEqual({ c: 2 });
    expect(db.prepare("select count(*) c from event_index where file_path_ref <> ''").get()).toEqual({ c: 0 });
    db.close();
  });

  it('覚えた最後の id より後ろから読み、振り終えた行をなめ直さない', () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 7);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    const first = fillPathRefsAfter(db, 0, 3);
    expect(first.filled).toBe(3);
    // 覚えた id より前に旧い行が残っていても、after より後ろだけを読む。
    const ids = (db.prepare('select id from event_index order by id').all() as { id: number }[]).map((r) => r.id);
    db.prepare("update event_index set path_id = null, file_path_ref = '/w/a.jsonl' where id = ?").run(ids[0]);
    const second = fillPathRefsAfter(db, first.last, 3);
    expect(second.filled).toBe(3);
    expect(second.last).toBeGreaterThan(first.last);
    expect(db.prepare('select count(*) c from event_index where path_id is null').get()).toEqual({ c: 2 });
    expect(fillPathRefsAfter(db, second.last, 3).filled).toBe(1);
    expect(fillPathRefsAfter(db, 0, 3).filled).toBe(1);
    db.close();
  });

  it('埋め終えていない行は旧い列のパスで、埋めた行は番号のパスで、同じ関数が読める', () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 4);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    fillPathRefs(db, 2);
    const paths = db.prepare(`select seq, ${EVENT_PATH_SQL} path from event_index e order by seq`).all();
    expect(paths).toEqual([{ seq: 0, path: '/w/a.jsonl' }, { seq: 1, path: '/w/a.jsonl' }, { seq: 2, path: '/w/b.jsonl' }, { seq: 3, path: '/w/a.jsonl' }]);
    db.close();
  });

  it('埋めの背面の走りは、終わると止まり、止めると途中で次を呼ばない', async () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 10);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    await new Promise<void>((resolve) => { startPathRefFill(db, { limit: 4, delayMs: 0, onDone: resolve }); });
    expect(db.prepare('select count(*) c from event_index where path_id is null').get()).toEqual({ c: 0 });
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
