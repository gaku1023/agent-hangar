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
/** そのセッションがファイルを触ったことにする。索引の行を 1 つ足すだけで、本文は要らない。 */
const touchFile = (sessionId: string, file: string) => db.prepare("insert into event_index (session_id, seq, kind, file_path_ref, byte_offset, byte_length, file_path) values (?, 9999, 'tool', 'x', 0, 0, ?)").run(sessionId, file);
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
    expect(searchSessions(db, { q: 'ls', live: 'running' }).total).toBe(0);
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
    // 状態の判定は DB に無いので、呼ぶ側が provider_session_id と hangar の id から決める。
    // 既定は終了。
    expect(searchSessions(db, { q: 'channels', live: 'running' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', live: 'ended' }).total).toBe(1);
    const liveOf = (_sid: string, psid: string) => (psid === SESSION_ALPHA ? 'waiting' as const : 'ended' as const);
    expect(searchSessions(db, { q: 'channels', live: 'waiting' }, liveOf).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', live: 'running' }, liveOf).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', live: 'ended' }, liveOf).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', live: 'running' }, (sid) => (sid === idOf(SESSION_ALPHA) ? 'running' : 'ended')).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', file: 'a.md' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', file: 'zzz' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello' }).hits[0]!.sessionId).toBe(idOf(SESSION_OTHER));
  });
  // 一覧で「触ったファイル」だけを入れたとき、キーワードが無くても絞れるようにする。
  it('キーワードが空でも、ファイルがあればそのファイルを触ったセッションを新しい順に返す', () => {
    const r = searchSessions(db, { q: '', file: 'a.md' });
    expect(r.total).toBe(1);
    expect(r.hits).toEqual([{ sessionId: idOf(SESSION_ALPHA), matchCount: expect.any(Number), snippets: [] }]);
    expect(r.hits[0]!.matchCount).toBeGreaterThan(0);
    expect(searchSessions(db, { q: '  ', file: 'a.md' }).total).toBe(1);
    expect(searchSessions(db, { q: '', file: 'zzz' })).toEqual({ hits: [], total: 0 });
    expect(searchSessions(db, { q: '', file: '%' })).toEqual({ hits: [], total: 0 });
    expect(searchSessions(db, { q: '', file: 'a.md', live: 'running' }).total).toBe(0);
    expect(searchSessions(db, { q: '', file: 'a.md', live: 'waiting' }, () => 'waiting').total).toBe(1);
    expect(searchSessions(db, { q: '', file: 'a.md', since: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(0);
    // ファイルも無ければ、これまでどおり空の結果である。一覧は手元で組む。
    expect(searchSessions(db, { q: '', projectId: 'p1' })).toEqual({ hits: [], total: 0 });
  });
  it('キーワードが空の経路も新しい順に並べる', () => {
    const alpha = db.prepare('select * from sessions where id = ?').get(idOf(SESSION_ALPHA)) as Record<string, unknown>;
    const other = db.prepare('select * from sessions where id = ?').get(idOf(SESSION_OTHER)) as Record<string, unknown>;
    // 同じファイルを触ったことにして、2 件を並べる。
    touchFile(idOf(SESSION_OTHER), '/w/shared/a.md');
    upsertShared(db, 'sessions', { ...alpha, last_activity_at: 1000 }, 'd');
    upsertShared(db, 'sessions', { ...other, last_activity_at: 2000 }, 'd');
    expect(searchSessions(db, { q: '', file: 'a.md' }).hits.map((h) => h.sessionId)).toEqual([idOf(SESSION_OTHER), idOf(SESSION_ALPHA)]);
  });
  // 件数は全部を数え、行は limit で切る。続きは offset で読む。
  it('offset から limit 件だけを返し、total は全件の数', () => {
    touchFile(idOf(SESSION_OTHER), '/w/shared/a.md');
    const both = searchSessions(db, { q: '', file: 'a.md' });
    expect(both.total).toBe(2);
    const first = searchSessions(db, { q: '', file: 'a.md', limit: 1 });
    expect(first).toMatchObject({ total: 2, hits: [{ sessionId: both.hits[0]!.sessionId }] });
    const rest = searchSessions(db, { q: '', file: 'a.md', limit: 1, offset: 1 });
    expect(rest).toMatchObject({ total: 2, hits: [{ sessionId: both.hits[1]!.sessionId }] });
    expect(searchSessions(db, { q: 'channels', offset: 5 })).toEqual({ hits: [], total: 1 });
    expect(searchSessions(db, { q: 'channels', offset: -3 }).hits).toHaveLength(1);
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
