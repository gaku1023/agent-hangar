import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { listTranscriptFiles } from '../provider/claude-code/discover.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { buildBaselineSummary, formatDuration, writeBaselineIfNeeded } from './baseline.ts';
import { indexFile } from './indexFile.ts';

describe('formatDuration', () => {
  it('粒度を切り替える', () => {
    expect(formatDuration(30_000)).toBe('1 分未満');
    expect(formatDuration(5 * 60_000)).toBe('5 分');
    expect(formatDuration(2 * 3_600_000 + 7 * 60_000)).toBe('2 時間 7 分');
    expect(formatDuration(3 * 86_400_000)).toBe('3 日');
  });
});

describe('buildBaselineSummary', () => {
  const base = { aiTitle: '動画チャンネルの整理', name: 'channels-cleanup', firstPrompt: '動画チャンネルの整理をしたい。まず現状を見て', lastPrompt: 'b.md も同じように直して', files: ['/a/channels/a.md'], turns: 2, startedAt: 0, lastActivityAt: 4 * 60_000, running: false };
  it('題名は ai-title、1 文は最初の発言、本文に最初と最後とファイルと期間を並べる', () => {
    const s = buildBaselineSummary(base);
    expect(s.title).toBe('動画チャンネルの整理');
    expect(s.oneLiner).toBe('動画チャンネルの整理をしたい。まず現状を見て');
    expect(s.body).toBe('最初の依頼：動画チャンネルの整理をしたい。まず現状を見て\n最後の依頼：b.md も同じように直して\n触ったファイル：a.md\n2 ターン、4 分');
    expect(s).toMatchObject({ state: 'done', nextSteps: [], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: 2 });
  });
  it('ai-title が無ければ名前、それも無ければ最初の発言の先頭 40 字', () => {
    expect(buildBaselineSummary({ ...base, aiTitle: null }).title).toBe('channels-cleanup');
    expect(buildBaselineSummary({ ...base, aiTitle: null, name: null, firstPrompt: 'あ'.repeat(50) }).title).toBe('あ'.repeat(40));
    expect(buildBaselineSummary({ ...base, aiTitle: null, name: null, firstPrompt: null }).title).toBe('題名のないセッション');
  });
  it('実行中なら in_progress、ファイルが多ければ件数を添える', () => {
    const s = buildBaselineSummary({ ...base, running: true, files: ['/a/1.ts', '/a/2.ts', '/a/3.ts', '/a/4.ts', '/a/5.ts', '/a/6.ts', '/a/7.ts'] });
    expect(s.state).toBe('in_progress');
    expect(s.body).toContain('触ったファイル：1.ts, 2.ts, 3.ts, 4.ts, 5.ts ほか 2 件');
  });
  it('最初と最後が同じなら最後を省く', () => {
    expect(buildBaselineSummary({ ...base, lastPrompt: base.firstPrompt, files: [] }).body).toBe('最初の依頼：動画チャンネルの整理をしたい。まず現状を見て\n触ったファイル：なし\n2 ターン、4 分');
  });
});

describe('writeBaselineIfNeeded', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => { dir = copyFixtureClaudeDir(); db = openDb(':memory:'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('索引化したセッションに baseline の要約を書く', () => {
    const file = listTranscriptFiles(dir).find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
    const r = indexFile(db, file, { deviceId: 'd' });
    expect(writeBaselineIfNeeded(db, r.sessionId, 'd', false)).toBe(true);
    const row = db.prepare('select * from session_summaries where session_id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(row).toMatchObject({ title: '動画チャンネルの整理', source: 'baseline', state: 'done', based_on_turns: 2 });
    expect(JSON.parse(row.next_steps as string)).toEqual([]);
    expect(row.body).toContain('触ったファイル：a.md');
  });
  it('baseline 以外の要約があれば触らない', () => {
    const file = listTranscriptFiles(dir).find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
    const r = indexFile(db, file, { deviceId: 'd' });
    upsertShared(db, 'session_summaries', { session_id: r.sessionId, title: '手書き', one_liner: 'o', body: 'b', state: 'blocked', next_steps: '[]', source: 'in_session', based_on_turns: 2 }, 'd', 'session_id');
    expect(writeBaselineIfNeeded(db, r.sessionId, 'd', false)).toBe(false);
    expect((db.prepare('select title from session_summaries where session_id = ?').get(r.sessionId) as { title: string }).title).toBe('手書き');
  });
  it('中身が変わらなければ書き直さない', () => {
    const file = listTranscriptFiles(dir).find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
    const r = indexFile(db, file, { deviceId: 'd' });
    expect(writeBaselineIfNeeded(db, r.sessionId, 'd', false)).toBe(true);
    const before = db.prepare('select updated_at from session_summaries where session_id = ?').get(r.sessionId) as { updated_at: number };
    const changes = (db.prepare("select count(*) c from changes where table_name = 'session_summaries'").get() as { c: number }).c;
    expect(writeBaselineIfNeeded(db, r.sessionId, 'd', false)).toBe(false);
    expect(db.prepare('select updated_at from session_summaries where session_id = ?').get(r.sessionId)).toEqual(before);
    expect((db.prepare("select count(*) c from changes where table_name = 'session_summaries'").get() as { c: number }).c).toBe(changes);
  });
  it('実行中の切り替えで state だけが変わる', () => {
    const file = listTranscriptFiles(dir).find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
    const r = indexFile(db, file, { deviceId: 'd' });
    writeBaselineIfNeeded(db, r.sessionId, 'd', true);
    expect((db.prepare('select state from session_summaries where session_id = ?').get(r.sessionId) as { state: string }).state).toBe('in_progress');
    writeBaselineIfNeeded(db, r.sessionId, 'd', false);
    expect((db.prepare('select state from session_summaries where session_id = ?').get(r.sessionId) as { state: string }).state).toBe('done');
  });
});
