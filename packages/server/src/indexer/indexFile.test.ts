import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { listTranscriptFiles } from '../provider/claude-code/discover.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { indexFile } from './indexFile.ts';
import { localDay } from '../usage/aggregate.ts';

let dir: string;
let db: Db;
const DEV = 'dev-1';
beforeEach(() => { dir = copyFixtureClaudeDir(); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const files = () => listTranscriptFiles(dir);
const alphaMain = () => files().find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
const alphaSub = () => files().find((f) => f.sessionId === SESSION_ALPHA && f.agentId === 'abc123')!;
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;

describe('indexFile', () => {
  it('本体ファイルを索引化し、sessions と session_stats を埋める', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r).toMatchObject({ providerSessionId: SESSION_ALPHA, appended: 17, changed: true, badLines: 0 });
    expect(count('select count(*) c from event_index where session_id = ? and parent_agent is null', r.sessionId)).toBe(17);
    const kinds = db.prepare('select kind, count(*) c from event_index where session_id = ? group by kind').all(r.sessionId) as { kind: string; c: number }[];
    expect(Object.fromEntries(kinds.map((k) => [k.kind, k.c]))).toEqual({ user: 2, assistant: 2, thinking: 1, tool_call: 3, tool_result: 3, system: 2, meta: 4 });
    expect(count('select count(*) c from event_fts where session_id = ?', r.sessionId)).toBe(7);
    expect(count('select count(*) c from event_fts where session_id = ? and text match ?', r.sessionId, '"チャンネル"')).toBe(1);
    // Bash の要約と command、Edit のファイルパス、Agent の description の 3 行に channels が現れる。
    expect(count('select count(*) c from event_fts where session_id = ? and text match ?', r.sessionId, '"channels"')).toBe(3);
    const s = db.prepare('select * from sessions where id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(s).toMatchObject({ provider: 'claude-code', provider_session_id: SESSION_ALPHA, cwd: '/Users/me/workspace/alpha', first_prompt: '動画チャンネルの整理をしたい。まず現状を見て', ai_title: '動画チャンネルの整理', name: 'channels-cleanup', home_device: DEV, started_at: Date.parse('2026-09-01T10:00:00.000Z'), last_activity_at: Date.parse('2026-09-01T10:04:00.000Z') });
    const st = db.prepare('select * from session_stats where session_id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(st).toMatchObject({ turns: 2, model: 'claude-fable-5-1', effort: 'high', files_changed: 1, pr_url: 'https://github.com/me/alpha/pull/12', input_tokens: 1110, output_tokens: 140, last_prompt: 'b.md も同じように直して' });
    const tf = db.prepare('select * from transcript_files where path = ?').get(alphaMain().path) as Record<string, unknown>;
    expect(tf).toMatchObject({ session_id: r.sessionId, agent_id: null, indexed_bytes: fs.statSync(alphaMain().path).size, indexer_version: 1 });
  });

  it('変化が無ければ何もしない', () => {
    indexFile(db, alphaMain(), { deviceId: DEV });
    const before = count('select count(*) c from changes');
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r).toMatchObject({ appended: 0, changed: false });
    expect(count('select count(*) c from changes')).toBe(before);
  });

  it('サブエージェントは同じセッションに parent_agent 付きで入り、seq は 0 から', () => {
    const main = indexFile(db, alphaMain(), { deviceId: DEV });
    const sub = indexFile(db, alphaSub(), { deviceId: DEV });
    expect(sub.sessionId).toBe(main.sessionId);
    expect(sub.appended).toBe(2);
    const rows = db.prepare("select seq, kind from event_index where session_id = ? and parent_agent = 'abc123' order by seq").all(main.sessionId);
    expect(rows).toEqual([{ seq: 0, kind: 'user' }, { seq: 1, kind: 'assistant' }]);
    expect(count("select count(*) c from event_fts where session_id = ? and agent_id = 'abc123'", main.sessionId)).toBe(2);
    expect((db.prepare('select turns from session_stats where session_id = ?').get(main.sessionId) as { turns: number }).turns).toBe(2);
  });

  it('サブエージェントを先に索引化してもセッション行ができる', () => {
    const sub = indexFile(db, alphaSub(), { deviceId: DEV });
    expect((db.prepare('select cwd from sessions where id = ?').get(sub.sessionId) as { cwd: string }).cwd).toBe('/Users/me/workspace/alpha');
  });

  it('追記分だけを読み、seq を続ける', () => {
    const first = indexFile(db, alphaMain(), { deviceId: DEV });
    fs.appendFileSync(alphaMain().path, JSON.stringify({ type: 'user', message: { role: 'user', content: '追加の依頼です' }, uuid: 'u9', timestamp: '2026-09-01T11:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA }) + '\n');
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r).toMatchObject({ sessionId: first.sessionId, appended: 1, changed: true });
    expect(db.prepare('select max(seq) m from event_index where session_id = ? and parent_agent is null').get(r.sessionId)).toEqual({ m: 17 });
    expect(count('select count(*) c from event_fts where session_id = ? and text match ?', r.sessionId, '"追加の依頼"')).toBe(1);
    const st = db.prepare('select turns, last_prompt from session_stats where session_id = ?').get(r.sessionId);
    expect(st).toEqual({ turns: 3, last_prompt: '追加の依頼です' });
    expect((db.prepare('select last_activity_at from sessions where id = ?').get(r.sessionId) as { last_activity_at: number }).last_activity_at).toBe(Date.parse('2026-09-01T11:00:00.000Z'));
  });

  it('スラッシュコマンドの記録は turns にも first_prompt にも last_prompt にも入らない', () => {
    indexFile(db, alphaMain(), { deviceId: DEV });
    const mk = (uuid: string, content: string, ts: string) => JSON.stringify({ type: 'user', message: { role: 'user', content }, uuid, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA }) + '\n';
    fs.appendFileSync(alphaMain().path,
      mk('u10', '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>', '2026-09-01T11:00:00.000Z')
      + mk('u11', '<local-command-stdout>cleared</local-command-stdout>', '2026-09-01T11:00:01.000Z'));
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r.appended).toBe(2);
    const st = db.prepare('select turns, last_prompt from session_stats where session_id = ?').get(r.sessionId);
    expect(st).toEqual({ turns: 2, last_prompt: 'b.md も同じように直して' });
    expect((db.prepare('select first_prompt from sessions where id = ?').get(r.sessionId) as { first_prompt: string }).first_prompt).toBe('動画チャンネルの整理をしたい。まず現状を見て');
    expect(count("select count(*) c from event_index where session_id = ? and kind = 'system'", r.sessionId)).toBe(4);
    // system になった本文は全文検索の索引に載せない。
    expect(count('select count(*) c from event_fts where session_id = ? and text match ?', r.sessionId, '"command-name"')).toBe(0);
    expect(count('select count(*) c from event_fts where session_id = ? and text match ?', r.sessionId, '"cleared"')).toBe(0);
  });

  it('ファイルが作り直されたら先頭から索引を作り直し、統計を二重に数えない', () => {
    indexFile(db, alphaMain(), { deviceId: DEV });
    const lines = fs.readFileSync(alphaMain().path, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(alphaMain().path, lines.slice(0, 3).join('\n') + '\n');
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r.appended).toBe(3);
    expect(count('select count(*) c from event_index where session_id = ? and parent_agent is null', r.sessionId)).toBe(3);
    expect(count('select count(*) c from event_fts where session_id = ? and agent_id is null', r.sessionId)).toBe(2);
    expect((db.prepare('select turns from session_stats where session_id = ?').get(r.sessionId) as { turns: number }).turns).toBe(1);
  });

  it('版が上がったら作り直す', () => {
    indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: 1 });
    const r = indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: 2 });
    expect(r.changed).toBe(true);
    expect(count('select count(*) c from event_index where session_id = ?', r.sessionId)).toBe(17);
    expect((db.prepare('select indexer_version v from transcript_files where path = ?').get(alphaMain().path) as { v: number }).v).toBe(2);
  });

  it('壊れた行は数えて飛ばす', () => {
    fs.appendFileSync(alphaMain().path, '{not json\n');
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r).toMatchObject({ appended: 17, badLines: 1 });
  });

  it('バイト位置から記録を読み戻せる', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    const rows = db.prepare('select byte_offset, byte_length, file_path_ref from event_index where session_id = ?').all(r.sessionId) as { byte_offset: number; byte_length: number; file_path_ref: string }[];
    const fd = fs.openSync(alphaMain().path, 'r');
    for (const row of rows) {
      const buf = Buffer.alloc(row.byte_length);
      fs.readSync(fd, buf, 0, row.byte_length, row.byte_offset);
      expect(() => JSON.parse(buf.toString('utf8'))).not.toThrow();
      expect(row.file_path_ref).toBe(alphaMain().path);
    }
    fs.closeSync(fd);
  });

  it('記録に cwd が無ければ cwdFallback を使う', () => {
    const p = path.join(dir, 'projects/-Users-me-workspace-alpha/bbbbbbbb-0000-4000-8000-000000000009.jsonl');
    fs.writeFileSync(p, JSON.stringify({ type: 'ai-title', aiTitle: 'x', sessionId: 'bbbbbbbb-0000-4000-8000-000000000009' }) + '\n');
    const r = indexFile(db, { path: p, sessionId: 'bbbbbbbb-0000-4000-8000-000000000009', agentId: null }, { deviceId: DEV, cwdFallback: '/Users/me/workspace/alpha' });
    expect((db.prepare('select cwd from sessions where id = ?').get(r.sessionId) as { cwd: string }).cwd).toBe('/Users/me/workspace/alpha');
  });

  it('Artifact の呼び出しと結果からアーティファクトを作り、追記で結果だけ届いても結びつける', () => {
    const r0 = indexFile(db, alphaMain(), { deviceId: DEV });
    const url = 'https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001';
    const call = { type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 'toolu_art', name: 'Artifact', input: { file_path: '/tmp/none.html', description: '週報', favicon: '📊' } }], usage: { input_tokens: 0, output_tokens: 1 } }, uuid: 'a9', timestamp: '2026-09-01T12:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA };
    fs.appendFileSync(alphaMain().path, JSON.stringify(call) + '\n');
    const r1 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r1.artifactIds).toEqual([]);
    expect(db.prepare('select * from artifact_calls where tool_id = ?').get('toolu_art')).toMatchObject({ session_id: r0.sessionId, file_path: '/tmp/none.html', description: '週報', favicon: '📊' });
    const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_art', content: `Published /tmp/none.html at ${url}` }] }, uuid: 'u9', timestamp: '2026-09-01T12:00:03.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA };
    fs.appendFileSync(alphaMain().path, JSON.stringify(result) + '\n');
    const r2 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r2.artifactIds).toHaveLength(1);
    const art = db.prepare('select * from artifacts where id = ?').get(r2.artifactIds[0]) as Record<string, unknown>;
    expect(art).toMatchObject({ url, title: '週報', favicon: '📊', first_published_at: Date.parse('2026-09-01T12:00:03.000Z') });
    expect((db.prepare('select count(*) c from artifact_versions where session_id = ?').get(r0.sessionId) as { c: number }).c).toBe(1);
    // 作り直しても版は増えない。
    db.prepare('update transcript_files set indexer_version = 0').run();
    const r3 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r3.artifactIds).toHaveLength(1);
    expect((db.prepare('select count(*) c from artifact_versions where session_id = ?').get(r0.sessionId) as { c: number }).c).toBe(1);
  });

  it('usage_daily に日別のトークンを積み、作り直しで二重にしない', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    const rows = () => db.prepare('select day, input_tokens i, output_tokens o from usage_daily where session_id = ? order by day').all(r.sessionId) as { day: string; i: number; o: number }[];
    // フィクスチャの記録はすべて 2026-09-01 の UTC 10 時台なので、ローカル時刻でも 1 日に収まる。
    const day = localDay(Date.parse('2026-09-01T10:00:05.000Z'));
    expect(rows()).toEqual([{ day, i: 1110, o: 140 }]);
    indexFile(db, alphaSub(), { deviceId: DEV });
    expect(rows()[0]!.i).toBeGreaterThan(1110);
    db.prepare('update transcript_files set indexer_version = 0').run();
    indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaSub(), { deviceId: DEV });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.o).toBe(140 + 3);
  });
});
