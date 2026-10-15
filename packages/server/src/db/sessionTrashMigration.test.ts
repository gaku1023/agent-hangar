import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbVersionOf, seedDbAt } from '../../test/oldDb.ts';
import { openDb } from './open.ts';

/**
 * 版 26 は、セッションの削除（sessions/trash.ts）のための端末ローカルの表を 2 つ足す。
 * trashed_transcripts は、この PC がゴミ箱へ移した本文の元のパスの控えで、戻ってきたら復元する。
 * trash_applied は、この PC が削除の印を処理し終えたセッションで、同じ印を何度も処理しない。
 * どちらも同期に載らない。
 */
const BEFORE = 25;
const AFTER = 26;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-session-trash-migration-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版 26：削除の控え', () => {
  it('版 25 の DB を開くと版 26 へ上がり、控えの表が空で作られる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, BEFORE, () => {});
    expect(dbVersionOf(file)).toBe(BEFORE);
    const db = openDb(file, { backupDir: path.join(tmp, 'backups') });
    expect(dbVersionOf(file)).toBeGreaterThanOrEqual(AFTER);
    const cols = (t: string) => (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('trashed_transcripts')).toEqual(['path', 'session_id', 'kind', 'trashed_at']);
    expect(cols('trash_applied')).toEqual(['session_id', 'trashed_at']);
    expect(db.prepare('select count(*) n from trashed_transcripts').get()).toEqual({ n: 0 });
    db.close();
  });
});
