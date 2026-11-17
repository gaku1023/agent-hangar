import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { FTS_TAIL } from '../search/ftsTail.ts';
import { backfillFtsTailStep, createFtsTailBackfill, FTS_TAIL_CURSOR_KEY } from '../search/ftsTailBackfill.ts';
import { searchSessions } from '../search/search.ts';
import { openDb } from './open.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-fts-tail-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const texts = (db: ReturnType<typeof openDb>): string[] => (db.prepare('select text from event_fts order by rowid').all() as { text: string }[]).map((r) => r.text);

function seed(file: string, n: number): void {
  seedDbAt(file, 61, (db) => {
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
    const ins = db.prepare('insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)');
    db.transaction(() => { for (let i = 0; i < n; i++) ins.run('s1', null, i, 'user', i === 0 ? 'これは設計の相談' : `行${i}`); })();
  });
}

describe('版 66：event_fts の末尾の区切りは背面で足す', () => {
  it('版 66 は行を書き換えず印だけを置く（開いた直後は区切りが付いていない）', () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 50);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(66);
    expect(texts(db).some((t) => t.includes(FTS_TAIL))).toBe(false);
    expect((db.prepare('select value from settings_local where key = ?').get(FTS_TAIL_CURSOR_KEY) as { value: string }).value).toBe('0');
    db.close();
  });

  it('途中の状態でも、検索と抜粋が壊れない', () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 50);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(backfillFtsTailStep(db, 10)).toBe(true);
    const r = searchSessions(db, { q: '相談' });
    expect(r.total).toBe(1);
    expect(r.hits[0]!.snippets[0]!.text).toBe('これは設計の相談');
    // 足していない行（rowid 11 以降）も、区切りのない抜粋で返る。
    const r2 = searchSessions(db, { q: '行40' });
    expect(r2.total).toBe(1);
    expect(r2.hits[0]!.snippets[0]!.text).toBe('行40');
    db.close();
  });

  it('続きから進んで全部終わり、印が消え、末尾の 2 文字が引ける', () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 50);
    let db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(backfillFtsTailStep(db, 20)).toBe(true);
    db.close();
    // 止まって開き直しても、続きから進む。
    db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    const cur = Number((db.prepare('select value from settings_local where key = ?').get(FTS_TAIL_CURSOR_KEY) as { value: string }).value);
    expect(cur).toBeGreaterThan(0);
    const before = texts(db);
    expect(before.slice(0, cur).every((t) => t.endsWith(FTS_TAIL))).toBe(true);
    expect(before.slice(cur).some((t) => t.endsWith(FTS_TAIL))).toBe(false);
    while (backfillFtsTailStep(db, 20)) { /* 続ける */ }
    expect(texts(db).every((t) => t.endsWith(FTS_TAIL) && t.indexOf(FTS_TAIL) === t.length - 1)).toBe(true);
    expect(db.prepare('select 1 from settings_local where key = ?').get(FTS_TAIL_CURSOR_KEY)).toBeUndefined();
    expect(backfillFtsTailStep(db)).toBe(false);
    expect(searchSessions(db, { q: '相談' }).hits[0]!.snippets[0]!.text).toBe('これは設計の相談');
    db.close();
  });

  it('背面の仕事の間に新しく積んだ（すでに区切りつきの）行へ、区切りを二重に足さない', () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 5);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    db.prepare('insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)').run('s1', null, 99, 'user', 'あたらしい' + FTS_TAIL);
    while (backfillFtsTailStep(db, 2)) { /* 続ける */ }
    expect(texts(db).at(-1)).toBe('あたらしい' + FTS_TAIL);
    db.close();
  });

  it('タイマーで全部終わり、止めると進まない', async () => {
    const file = path.join(tmp, 'hangar.db');
    seed(file, 30);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    const job = createFtsTailBackfill(db, { batch: 10, gapMs: 1 });
    job.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(texts(db).every((t) => t.endsWith(FTS_TAIL))).toBe(true);
    job.stop();
    db.close();
  });
});
