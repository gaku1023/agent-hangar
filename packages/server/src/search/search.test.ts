import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { likeSnippet, searchSessions } from './search.ts';

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
  it('2 文字の語だけでも like で当たり、抜粋に語を含む', () => {
    const r = searchSessions(db, { q: '動画' });
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ sessionId: idOf(SESSION_ALPHA), matchCount: 1 });
    expect(r.hits[0]!.snippets).toHaveLength(1);
    expect(r.hits[0]!.snippets[0]!.text).toContain('動画');
    expect(r.hits[0]!.snippets[0]!.role).toBe('user');
    expect(r.hits[0]!.snippets[0]!.seq).toBe(0);
  });
  it('短い語と長い語の混在は両方を満たす行だけ', () => {
    // channels は 3 行に現れるが、動画 を含む行は最初の依頼だけである。
    expect(searchSessions(db, { q: 'チャンネル 動画' })).toMatchObject({ total: 1, hits: [{ sessionId: idOf(SESSION_ALPHA), matchCount: 1 }] });
    expect(searchSessions(db, { q: 'channels 動画' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels ls' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels ls' }).hits[0]!.snippets[0]!.text).toContain('ls');
  });
  it('どこにも無い短い語は空の結果', () => {
    expect(searchSessions(db, { q: 'zz' })).toEqual({ hits: [], total: 0 });
    expect(searchSessions(db, { q: 'channels zz' })).toEqual({ hits: [], total: 0 });
  });
  it('短い語だけの経路でも絞り込みは効く', () => {
    expect(searchSessions(db, { q: 'ls', running: true }, new Set()).total).toBe(0);
    expect(searchSessions(db, { q: 'ls', file: 'zzz' }).total).toBe(0);
    expect(searchSessions(db, { q: 'ls', until: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(1);
    expect(searchSessions(db, { q: '%' }).total).toBe(0);
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

describe('likeSnippet', () => {
  it('短い本文はそのまま返す', () => {
    expect(likeSnippet('動画チャンネルの整理', '動画')).toBe('動画チャンネルの整理');
  });
  it('長い本文は語の前後 60 文字に切り、切った側に省略記号を置く', () => {
    const text = 'あ'.repeat(100) + '動画' + 'い'.repeat(100);
    const out = likeSnippet(text, '動画');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect([...out].length).toBe(62);
    expect(out).toContain('動画');
  });
  it('大文字小文字を区別せずに探す', () => {
    expect(likeSnippet('x'.repeat(100) + 'LS', 'ls')).toContain('LS');
  });
  it('語が無ければ先頭を返す', () => {
    expect(likeSnippet('abc', 'zz')).toBe('abc');
  });
});
