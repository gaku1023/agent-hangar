import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { searchSessions } from './search.ts';

let dir: string;
let db: Db;
const idOf = (p: string) => (db.prepare('select id from sessions where provider_session_id = ?').get(p) as { id: string }).id;
beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('searchSessions', () => {
  it('日本語の部分一致で当たり、抜粋を返す', () => {
    const r = searchSessions(db, { q: 'チャンネル' });
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ sessionId: idOf(SESSION_ALPHA), matchCount: 1 });
    expect(r.hits[0]!.snippets[0]!.text).toContain('チャンネル');
    expect(r.hits[0]!.snippets[0]!.role).toBe('user');
  });
  it('ハイフン入りの語も落ちない', () => {
    expect(() => searchSessions(db, { q: 'agent-hangar' })).not.toThrow();
  });
  it('複数語は AND', () => {
    expect(searchSessions(db, { q: 'channels hello' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels' }).total).toBe(1);
  });
  it('空の検索語は空の結果', () => {
    expect(searchSessions(db, { q: '' })).toEqual({ hits: [], total: 0 });
  });
  it('プロジェクト、期間、実行中、ファイルで絞る', () => {
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    const alpha = db.prepare('select * from sessions where id = ?').get(idOf(SESSION_ALPHA)) as Record<string, unknown>;
    upsertShared(db, 'sessions', { ...alpha, project_id: 'p1' }, 'd');
    expect(searchSessions(db, { q: 'channels', projectId: 'p1' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', projectId: 'p2' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', since: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', until: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', running: true }, new Set()).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', running: true }, new Set([SESSION_ALPHA])).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', running: false }, new Set([SESSION_ALPHA])).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', file: 'a.md' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', file: 'zzz' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello' }).hits[0]!.sessionId).toBe(idOf(SESSION_OTHER));
  });
});
