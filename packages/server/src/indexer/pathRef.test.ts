import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { openDb } from '../db/open.ts';
import { searchSessions } from '../search/search.ts';
import { listTranscriptFiles } from '../provider/claude-code/transcript/discover.ts';
import { readFilePage, openFsBody } from '../transcript/filePage.ts';
import { indexFile } from '../../test/claudeIndex.ts';

/** 索引はパスの文字を行ごとに持たず、番号（event_paths）で指す。書く、読む、検索、積み直しが、どれも番号で動く。 */
describe('索引はパスを番号で指す', () => {
  it('同じファイルの行は 1 つのパスを指し、読む道は番号からパスを引いて開く。検索も引ける', () => {
    const claude = copyFixtureClaudeDir();
    try {
      const db = openDb(':memory:');
      const main = listTranscriptFiles(claude).find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
      indexFile(db, main, { deviceId: 'dev-1' });
      const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
      const rows = n('select count(*) c from event_index');
      expect(rows).toBeGreaterThan(1);
      expect(n('select count(*) c from event_paths')).toBe(1);
      expect(n('select count(*) c from event_index e join event_paths p on p.id = e.path_id and p.path = ' + `'${main.path.replaceAll("'", "''")}'`)).toBe(rows);
      expect(((db.prepare("select ref from (select ifnull(max(file_path_ref), '') ref from event_index)").get() as { ref: string }).ref)).toBe('');
      expect(searchSessions(db, { q: 'channels' }).total).toBe(1);
      const opened: string[] = [];
      const id = (db.prepare('select id from sessions').get() as { id: string }).id;
      const page = readFilePage(db, id, { limit: 100 }, { open: (p) => { opened.push(p); return openFsBody(p); }, normalize: (rec, seq) => [{ kind: 'unknown', seq, raw: rec } as never] });
      expect(page.events.length).toBeGreaterThan(0);
      expect(new Set(opened)).toEqual(new Set([main.path]));
      // 積み直し（indexer_version を 0 にして読み直す）でも、パスの表は増えない。
      db.prepare('update transcript_files set indexer_version = 0').run();
      indexFile(db, main, { deviceId: 'dev-1' });
      expect(n('select count(*) c from event_paths')).toBe(1);
      expect(n('select count(*) c from event_index')).toBe(rows);
      db.close();
    } finally { fs.rmSync(claude, { recursive: true, force: true }); }
  });
});
