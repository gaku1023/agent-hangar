import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { listTranscriptFiles } from '../provider/claude-code/transcript/discover.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { ensureSession, findSession, forgetTranscriptFile, indexFile, INDEXER_VERSION, markTruncatedForReindex } from './indexFile.ts';
import type { Drift } from '../provider/claude-code/compat/types.ts';
import { localDay } from '../usage/aggregate.ts';
import { getSession, listSessions } from '../db/queries.ts';
import { setSessionName } from '../sessions/notes.ts';
import { proposeSessionState, rejectSessionState, setSessionState } from '../sessions/states.ts';

let dir: string;
let db: Db;
const DEV = 'dev-1';
beforeEach(() => { dir = copyFixtureClaudeDir(); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const files = () => listTranscriptFiles(dir);
const alphaMain = () => files().find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
const alphaSub = () => files().find((f) => f.sessionId === SESSION_ALPHA && f.agentId === 'abc123')!;
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
/** 題名の解決が本物のファイルを読むので、確実に存在しないパスを渡す。 */
const missing = () => path.join(dir, 'no-such-artifact.html');
const ART_URL = 'https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001';
const artifactCall = (toolId: string, input: Record<string, unknown>, ts = '2026-09-01T12:00:00.000Z') =>
  ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: toolId, name: 'Artifact', input }], usage: { input_tokens: 0, output_tokens: 1 } }, uuid: `a-${toolId}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
const artifactResult = (toolId: string, text: string, ts = '2026-09-01T12:00:03.000Z') =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text }] }, uuid: `u-${toolId}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
const appendJson = (p: string, ...recs: unknown[]) => { for (const r of recs) fs.appendFileSync(p, JSON.stringify(r) + '\n'); };

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
    expect(s).toMatchObject({ provider: 'claude-code', provider_session_id: SESSION_ALPHA, cwd: '/Users/me/workspace/alpha', first_prompt: '動画チャンネルの整理をしたい。まず現状を見て', ai_title: '動画チャンネルの整理', custom_title: 'channels-cleanup', home_device: DEV, started_at: Date.parse('2026-09-01T10:00:00.000Z'), last_activity_at: Date.parse('2026-09-01T10:04:00.000Z') });
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

  it('索引は名前（session_notes）に触らない。何度走らせても、作り直しても変わらない', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionName(db, 'other-pc', r.sessionId, 'hangar で付けた名前');
    const note = () => db.prepare('select * from session_notes where session_id = ?').get(r.sessionId);
    const noteSeq = () => (db.prepare("select max(seq) s from changes where table_name = 'session_notes'").get() as { s: number }).s;
    const before = note();
    const seq = noteSeq();
    // 追記、変化なしの走り直し、作り直し（版の上がり）、ファイルの作り直し。
    appendJson(alphaMain().path, { type: 'custom-title', customTitle: '本文で付け直した名前', sessionId: SESSION_ALPHA }, { type: 'user', message: { role: 'user', content: '続き' }, uuid: 'u-more', timestamp: '2026-09-01T13:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
    indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: INDEXER_VERSION + 1 });
    const lines = fs.readFileSync(alphaMain().path, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(alphaMain().path, lines.slice(0, 3).join('\n') + '\n');
    indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: INDEXER_VERSION + 1 });
    expect(note()).toEqual(before);
    expect(noteSeq()).toBe(seq);
    // 本文の題名は sessions の側に入る。索引が同期へ送る sessions の行は、名前とメモを運ばない。
    expect((db.prepare('select custom_title t from sessions where id = ?').get(r.sessionId) as { t: string }).t).toBe('本文で付け直した名前');
    const payloads = (db.prepare("select payload from changes where table_name = 'sessions' and row_id = ?").all(r.sessionId) as { payload: string }[]).map((c) => JSON.parse(c.payload) as Record<string, unknown>);
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(Object.keys(p)).not.toContain('name');
      expect(Object.keys(p)).not.toContain('memo');
    }
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
    const r = indexFile(db, { path: p, sessionId: 'bbbbbbbb-0000-4000-8000-000000000009', agentId: null, deviceId: null }, { deviceId: DEV, cwdFallback: '/Users/me/workspace/alpha' });
    expect((db.prepare('select cwd from sessions where id = ?').get(r.sessionId) as { cwd: string }).cwd).toBe('/Users/me/workspace/alpha');
  });

  it('Artifact の呼び出しと結果からアーティファクトを作り、追記で結果だけ届いても結びつける', () => {
    const r0 = indexFile(db, alphaMain(), { deviceId: DEV });
    const url = 'https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001';
    const call = artifactCall('toolu_art', { file_path: missing(), description: '週報', favicon: '📊' });
    fs.appendFileSync(alphaMain().path, JSON.stringify(call) + '\n');
    const r1 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r1.artifactIds).toEqual([]);
    expect(db.prepare('select * from artifact_calls where tool_id = ?').get('toolu_art')).toMatchObject({ session_id: r0.sessionId, file_path: missing(), description: '週報', favicon: '📊' });
    const result = artifactResult('toolu_art', `Published ${missing()} at ${url}`, '2026-09-01T12:00:03.000Z');
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
    const rows = () => db.prepare('select day, sum(input_tokens) i, sum(output_tokens) o from usage_daily where session_id = ? group by day order by day').all(r.sessionId) as { day: string; i: number; o: number }[];
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

  it('主線を作り直してもサブエージェントぶんの日別は残る', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    const sum = () => (db.prepare('select ifnull(sum(input_tokens), 0) i, ifnull(sum(output_tokens), 0) o from usage_daily where session_id = ?').get(r.sessionId) as { i: number; o: number });
    const mainOnly = sum();
    indexFile(db, alphaSub(), { deviceId: DEV });
    const withSub = sum();
    expect(withSub.o).toBeGreaterThan(mainOnly.o);
    // 主線だけを作り直しても、サブエージェントのファイル由来の日別は失われない。
    db.prepare('update transcript_files set indexer_version = 0 where agent_id is null').run();
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(sum()).toEqual(withSub);
  });

  it('1 回の索引化でセッションのプロジェクトを引くのは一度だけ', () => {
    const r0 = indexFile(db, alphaMain(), { deviceId: DEV });
    const url2 = 'https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000003';
    appendJson(alphaMain().path,
      artifactCall('toolu_p1', { file_path: missing(), description: '一つ目' }), artifactResult('toolu_p1', `Published at ${ART_URL}`),
      artifactCall('toolu_p2', { file_path: missing(), description: '二つ目' }, '2026-09-01T12:10:00.000Z'), artifactResult('toolu_p2', `Published at ${url2}`, '2026-09-01T12:10:03.000Z'));
    const orig = db.prepare.bind(db);
    let n = 0;
    db.prepare = ((sql: string) => { if (/select project_id from sessions/.test(sql)) n++; return orig(sql); }) as typeof db.prepare;
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    db.prepare = orig;
    expect(r.sessionId).toBe(r0.sessionId);
    expect(r.artifactIds).toHaveLength(2);
    expect(n).toBe(1);
  });

  it('サブエージェントの公開は主線の作り直しで消えない', () => {
    const r0 = indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaSub(), { deviceId: DEV });
    const subUrl = 'https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000002';
    appendJson(alphaMain().path, artifactCall('toolu_main', { file_path: missing(), description: '主線' }), artifactResult('toolu_main', `Published at ${ART_URL}`));
    appendJson(alphaSub().path, artifactCall('toolu_sub', { file_path: missing(), description: 'サブ' }, '2026-09-01T12:04:00.000Z'), artifactResult('toolu_sub', `Published at ${subUrl}`, '2026-09-01T12:05:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaSub(), { deviceId: DEV });
    expect(count('select count(*) c from artifact_versions where session_id = ?', r0.sessionId)).toBe(2);
    // 主線だけを作り直しても、サブエージェント由来の版は残る。
    db.prepare('update transcript_files set indexer_version = 0 where agent_id is null').run();
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r.artifactIds).toHaveLength(1);
    expect(count('select count(*) c from artifact_versions where session_id = ?', r0.sessionId)).toBe(2);
    // 版が 1 件も無いアーティファクトを残さない。
    expect(count('select count(*) c from artifacts a where not exists (select 1 from artifact_versions v where v.artifact_id = a.id and v.deleted_at is null)')).toBe(0);
  });

  it('publish 以外の Artifact の呼び出しは公開として記録しない', () => {
    const r0 = indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path,
      artifactCall('toolu_read', { action: 'read', url: ART_URL }), artifactResult('toolu_read', `Read the page at ${ART_URL}`),
      artifactCall('toolu_list', { action: 'list' }), artifactResult('toolu_list', `1. Weekly ${ART_URL}`),
      artifactCall('toolu_del', { action: 'delete', url: ART_URL }), artifactResult('toolu_del', `Deleted ${ART_URL}`));
    const r1 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r1.artifactIds).toEqual([]);
    expect(count('select count(*) c from artifacts')).toBe(0);
    expect(count('select count(*) c from artifact_versions')).toBe(0);
    expect(count('select count(*) c from artifact_calls where session_id = ?', r0.sessionId)).toBe(0);
    // action を明に書いた publish は記録する。
    appendJson(alphaMain().path, artifactCall('toolu_pub', { action: 'publish', file_path: missing(), description: '週報' }), artifactResult('toolu_pub', `Published at ${ART_URL}`));
    const r2 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r2.artifactIds).toHaveLength(1);
    expect(count('select count(*) c from artifact_versions')).toBe(1);
  });
});

describe('last_activity_at の共有の間引き（同期の版 6）', () => {
  const T0 = Date.parse('2026-09-01T10:04:00.000Z');
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const say = (uuid: string, ms: number) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text: '続けます' }], usage: { input_tokens: 0, output_tokens: 1 } }, uuid, timestamp: at(ms), cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
  const turnEnd = (uuid: string, ms: number) => ({ type: 'system', subtype: 'turn_duration', durationMs: 1000, messageCount: 2, uuid, isSidechain: false, isMeta: false, timestamp: at(ms), cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
  const shared = (id: string) => (db.prepare('select last_activity_at a from sessions where id = ?').get(id) as { a: number }).a;
  const unsent = () => count("select count(*) c from changes where table_name = 'sessions' and pushed_at is null");
  const settle = () => { db.prepare('update changes set pushed_at = 1').run(); };

  it('ほかの事実が変わらず、進みが 5 分未満なら共有の行を書かない。画面の時刻は手元の統計で進む', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(shared(sessionId)).toBe(T0);
    settle();
    appendJson(alphaMain().path, say('x1', 2 * 60_000));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(shared(sessionId)).toBe(T0);
    expect(unsent()).toBe(0);
    expect(getSession(db, [], sessionId)!.lastActivityAt).toBe(T0 + 2 * 60_000);
    // 前に共有した値から 5 分進んだら書く。
    appendJson(alphaMain().path, say('x2', 5 * 60_000));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(shared(sessionId)).toBe(T0 + 5 * 60_000);
    expect(unsent()).toBe(1);
  });

  it('ターンの終わり（turn_duration）では、5 分未満でも書く', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    settle();
    appendJson(alphaMain().path, say('y1', 60_000), turnEnd('y2', 61_000));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(shared(sessionId)).toBe(T0 + 61_000);
    expect(unsent()).toBe(1);
  });

  it('ほかの事実が変わったら、5 分未満でも書く', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    settle();
    appendJson(alphaMain().path, { type: 'custom-title', customTitle: 'new-title', sessionId: SESSION_ALPHA }, say('z1', 60_000));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(db.prepare('select custom_title t, last_activity_at a from sessions where id = ?').get(sessionId)).toEqual({ t: 'new-title', a: T0 + 60_000 });
    expect(unsent()).toBe(1);
  });

  it('一覧の並びも手元の統計の時刻で決める', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    upsertShared(db, 'sessions', { id: 'other', provider: 'claude-code', provider_session_id: 'u-other', cwd: '/w', home_device: DEV, last_activity_at: T0 + 60_000 }, DEV);
    expect(listSessions(db, []).map((x) => x.id).slice(0, 2)).toEqual(['other', sessionId]);
    appendJson(alphaMain().path, say('w1', 2 * 60_000));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(shared(sessionId)).toBe(T0);
    expect(listSessions(db, []).map((x) => x.id).slice(0, 2)).toEqual([sessionId, 'other']);
  });
});

describe('論理削除されたセッション', () => {
  const u = '22222222-2222-4222-8222-222222222222';
  it('手元のファイルが伸びても、削除された行には積み直さない', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    const before = count('select count(*) c from event_index where session_id = ?', r.sessionId);
    const usageBefore = count('select count(*) c from usage_daily where session_id = ?', r.sessionId);
    softDeleteShared(db, 'sessions', r.sessionId, DEV);
    appendJson(alphaMain().path, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'あとから足した行' }] }, uuid: 'later', timestamp: '2026-09-02T00:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
    const r2 = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r2).toMatchObject({ sessionId: r.sessionId, changed: false, skipped: true });
    expect(count('select count(*) c from event_index where session_id = ?', r.sessionId)).toBe(before);
    expect(count('select count(*) c from usage_daily where session_id = ?', r.sessionId)).toBe(usageBefore);
  });
  it('findSession は削除された行を返さない', () => {
    upsertShared(db, 'sessions', { id: 's-del', provider: 'claude-code', provider_session_id: u, cwd: '/w/alpha', home_device: DEV }, DEV);
    expect(findSession(db, u)).toBe('s-del');
    softDeleteShared(db, 'sessions', 's-del', DEV);
    expect(findSession(db, u)).toBeNull();
  });
  it('削除された行の写しは索引化しない', () => {
    upsertShared(db, 'sessions', { id: 's-del', provider: 'claude-code', provider_session_id: u, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
    softDeleteShared(db, 'sessions', 's-del', DEV);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-del-'));
    const p = path.join(root, 'dev-b', 'projects', '-w-alpha', `${u}.jsonl`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }, cwd: '/w/alpha', timestamp: '2026-09-01T00:00:00.000Z' }) + '\n');
    const r = indexFile(db, { path: p, sessionId: u, agentId: null, deviceId: 'dev-b' }, { deviceId: DEV, remote: true });
    expect(r).toMatchObject({ changed: false, skipped: true });
    expect(count('select count(*) c from event_index where session_id = ?', 's-del')).toBe(0);
    expect(count('select count(*) c from transcript_files')).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('最後のツール呼び出し（session_activity）', () => {
  const askCall = (toolId: string, question: string, ts = '2026-09-01T12:10:00.000Z') =>
    ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: toolId, name: 'AskUserQuestion', input: { questions: [{ question, header: 'h', options: [], multiSelect: false }] } }], usage: { input_tokens: 0, output_tokens: 1 } }, uuid: `a-${toolId}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
  const activity = (sessionId: string) => db.prepare('select tool, summary, tool_id, question from session_activity where session_id = ?').get(sessionId);

  it('主線の追記から最後の呼び出しと待っている問いを残し、答えが来たら問いを消す', () => {
    const first = indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path, askCall('q1', 'どちらにしますか？'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(activity(first.sessionId)).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', tool_id: 'q1', question: 'どちらにしますか？' });
    // 答えは次の追記で届く。前の追記で残した呼び出しと突き合わせて消す。
    appendJson(alphaMain().path, artifactResult('q1', '右上に置く'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(activity(first.sessionId)).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', tool_id: 'q1', question: null });
  });

  it('サブエージェントの呼び出しは、主線の「いま」にしない', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaSub(), { deviceId: DEV });
    const before = activity(r.sessionId);
    appendJson(alphaSub().path, artifactCall('sub-1', { file_path: missing() }));
    indexFile(db, alphaSub(), { deviceId: DEV });
    expect(activity(r.sessionId)).toEqual(before);
  });

  it('主線のファイルを忘れると、待っている問いごと activity の行も消える', () => {
    const first = indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path, askCall('q1', 'どちらにしますか？'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(activity(first.sessionId)).toBeDefined();
    forgetTranscriptFile(db, alphaMain().path);
    expect(activity(first.sessionId)).toBeUndefined();
  });

  it('移った先のファイルを読んだ後に元のファイルを忘れても、移った先の索引は先頭から揃う', () => {
    // EnterWorktree は会話の本文を worktree 用の projects の下へ移す。新しい場所を先に読み、元の場所が消えたのを後で見る順になりうる。
    const old = alphaMain();
    const { sessionId } = indexFile(db, old, { deviceId: DEV });
    const movedDir = path.join(dir, 'projects', '-Users-me-workspace-alpha--claude-worktrees-x');
    fs.mkdirSync(movedDir, { recursive: true });
    const moved = { ...old, path: path.join(movedDir, path.basename(old.path)) };
    fs.copyFileSync(old.path, moved.path);
    indexFile(db, moved, { deviceId: DEV });
    forgetTranscriptFile(db, old.path);
    appendJson(moved.path, { type: 'user', message: { role: 'user', content: '移った後の依頼です' }, uuid: 'u-moved', timestamp: '2026-09-01T11:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
    indexFile(db, moved, { deviceId: DEV });
    const rows = db.prepare('select seq, kind, byte_offset, file_path_ref from event_index where session_id = ? and parent_agent is null order by seq').all(sessionId) as { seq: number; kind: string; byte_offset: number; file_path_ref: string }[];
    expect(rows).toHaveLength(18);
    expect(rows[0]).toMatchObject({ seq: 0, byte_offset: 0, file_path_ref: moved.path });
    expect(rows.filter((r) => r.kind === 'user')).toHaveLength(3);
    expect(count('select count(*) c from event_fts where session_id = ? and text match ?', sessionId, '"チャンネル"')).toBe(1);
  });

  it('先頭の索引が抜けたファイルだけを、先頭から読み直させる', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaSub(), { deviceId: DEV });
    // 前の版の forgetTranscriptFile が残した壊れ方：先頭からの索引が消え、読み進めた位置だけが残っている。
    db.prepare("delete from event_index where session_id = ? and parent_agent is null and seq < 5").run(sessionId);
    expect(markTruncatedForReindex(db)).toBe(1);
    const versions = db.prepare('select agent_id, indexer_version from transcript_files order by agent_id').all();
    expect(versions).toEqual([{ agent_id: null, indexer_version: 0 }, { agent_id: 'abc123', indexer_version: INDEXER_VERSION }]);
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(count('select count(*) c from event_index where session_id = ? and parent_agent is null', sessionId)).toBe(17);
    expect(markTruncatedForReindex(db)).toBe(0);
  });

  it('サブエージェントのファイルを忘れても、主線の activity は残る', () => {
    const first = indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path, askCall('q1', 'どちらにしますか？'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaSub(), { deviceId: DEV });
    const before = activity(first.sessionId);
    forgetTranscriptFile(db, alphaSub().path);
    expect(activity(first.sessionId)).toEqual(before);
  });

  it('版が上がって作り直すと最後から数え直し、ツール呼び出しが無くなれば行ごと消える', () => {
    const first = indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path, askCall('q1', 'どちらにしますか？'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(activity(first.sessionId)).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', tool_id: 'q1', question: 'どちらにしますか？' });
    // 版だけを上げて同じ内容を作り直しても、最後の呼び出しは書き直されて変わらない。
    const r2 = indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: INDEXER_VERSION + 1 });
    expect(r2.changed).toBe(true);
    expect(activity(first.sessionId)).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', tool_id: 'q1', question: 'どちらにしますか？' });
    // ツール呼び出しの無い内容に切り詰めてから作り直すと、積み直した先頭にはツール呼び出しが無く、行ごと消える。
    const lines = fs.readFileSync(alphaMain().path, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(alphaMain().path, lines.slice(0, 3).join('\n') + '\n');
    indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: INDEXER_VERSION + 1 });
    expect(activity(first.sessionId)).toBeUndefined();
  });
});

describe('使用制限（session_limits）', () => {
  const limitHit = (ts = '2026-09-01T12:20:00.000Z') => ({ type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] }, quotaLimits: { status: 'rejected', resetsAt: 1_788_300_000, rateLimitType: 'five_hour' }, uuid: `l-${ts}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
  const info = (text: string) => ({ type: 'system', subtype: 'informational', content: text, uuid: 'i1', timestamp: '2026-09-01T12:20:01.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
  const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text }, uuid: 'p1', timestamp: '2026-09-01T13:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
  const limit = (sessionId: string) => db.prepare('select kind, resets_at, auto, hit_at from session_limits where session_id = ?').get(sessionId);

  it('合成の行で行を作り、自動の続きの知らせで auto を立て、次の指示で消す', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path, limitHit());
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(limit(r.sessionId)).toEqual({ kind: 'five_hour', resets_at: 1_788_300_000_000, auto: 0, hit_at: Date.parse('2026-09-01T12:20:00.000Z') });
    appendJson(alphaMain().path, info('Usage limit reached · continuing automatically at 1:00pm · esc to cancel'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(limit(r.sessionId)).toMatchObject({ auto: 1 });
    appendJson(alphaMain().path, prompt('続けて'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(limit(r.sessionId)).toBeUndefined();
  });

  it('初めの発言ですぐ 429 が返り、使用制限の行が発言の行より先に書かれても拾う。取り消しの知らせで auto を下ろす', () => {
    const u = '22222222-2222-4222-8222-222222222222';
    const file = path.join(dir, 'projects', '-Users-me-workspace-alpha', `${u}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = (o: Record<string, unknown>, ts: string, uuid: string) => ({ ...o, sessionId: u, uuid, timestamp: ts });
    // 0.5.0-rc.1 の macOS の VM で見た並び：使用制限の行と知らせが先、時刻の早い初めの発言の行が後。
    const lines = [
      at(limitHit('2026-09-01T12:20:00.500Z'), '2026-09-01T12:20:00.500Z', 'l1'),
      at(info('Usage limit reached · continuing automatically at 1:00pm · esc to cancel'), '2026-09-01T12:20:00.600Z', 'i1'),
      at(prompt('はじめ'), '2026-09-01T12:20:00.000Z', 'p0'),
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const r = indexFile(db, { path: file, sessionId: u, agentId: null, deviceId: null }, { deviceId: DEV });
    expect(limit(r.sessionId)).toMatchObject({ kind: 'five_hour', auto: 1 });
    appendJson(file, at(info('Automatic continue cancelled · /rate-limit-options to re-arm'), '2026-09-01T12:20:05.000Z', 'i2'));
    indexFile(db, { path: file, sessionId: u, agentId: null, deviceId: null }, { deviceId: DEV });
    expect(limit(r.sessionId)).toMatchObject({ kind: 'five_hour', auto: 0 });
  });

  it('作り直しでは先頭から積み直し、主線を忘れると行も消える', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path, limitHit());
    indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: INDEXER_VERSION + 1 });
    expect(limit(r.sessionId)).toMatchObject({ kind: 'five_hour' });
    forgetTranscriptFile(db, alphaMain().path);
    expect(limit(r.sessionId)).toBeUndefined();
  });

  it('サブエージェントの本文の使用制限は、主線の行にしない', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaSub(), { deviceId: DEV });
    appendJson(alphaSub().path, limitHit());
    indexFile(db, alphaSub(), { deviceId: DEV });
    expect(limit(r.sessionId)).toBeUndefined();
  });
});

describe('他端末の写しの索引化', () => {
  const u = '11111111-1111-4111-8111-111111111111';
  const remoteFile = (root: string, text: string): string => {
    const p = path.join(root, 'dev-b', 'projects', '-w-alpha', `${u}.jsonl`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  const line = (role: 'user' | 'assistant', text: string) => JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { usage: { input_tokens: 1000, output_tokens: 500 } } : {}) }, cwd: '/w/alpha', timestamp: '2026-09-01T00:00:00.000Z' }) + '\n';
  let remoteDir: string;
  beforeEach(() => { remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rem-')); });
  afterEach(() => { fs.rmSync(remoteDir, { recursive: true, force: true }); });

  it('sessions の行がまだ無ければ飛ばす', () => {
    const p = remoteFile(remoteDir, line('user', 'hello'));
    const r = indexFile(db, { path: p, sessionId: u, agentId: null, deviceId: 'dev-b' }, { deviceId: 'dev-a', remote: true });
    expect(r).toMatchObject({ changed: false, skipped: true });
    expect(count('select count(*) c from sessions')).toBe(0);
    expect(count('select count(*) c from changes')).toBe(0);
  });

  it('sessions があれば索引と統計だけ書き、共有テーブルには書かない', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: u, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
    const before = db.prepare('select updated_at from sessions where id = ?').get('s1') as { updated_at: number };
    const changesBefore = count('select count(*) c from changes');
    const p = remoteFile(remoteDir, line('user', 'hello'));
    const r = indexFile(db, { path: p, sessionId: u, agentId: null, deviceId: 'dev-b' }, { deviceId: 'dev-a', remote: true });
    expect(r).toMatchObject({ sessionId: 's1', changed: true, skipped: false });
    expect(count('select count(*) c from event_index where session_id = ?', 's1')).toBeGreaterThan(0);
    expect(db.prepare('select turns from session_stats where session_id = ?').get('s1')).toEqual({ turns: 1 });
    expect(db.prepare('select device_id from transcript_files where path = ?').get(p)).toEqual({ device_id: 'dev-b' });
    expect(db.prepare('select updated_at from sessions where id = ?').get('s1')).toEqual(before);
    expect(count('select count(*) c from changes')).toBe(changesBefore);
    expect(findSession(db, u)).toBe('s1');
    expect(findSession(db, 'nope')).toBeNull();
  });

  it('forgetTranscriptFile は索引と行を消す', () => {
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: u, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
    const p = remoteFile(remoteDir, line('user', 'hello') + line('assistant', 'hi'));
    indexFile(db, { path: p, sessionId: u, agentId: null, deviceId: 'dev-b' }, { deviceId: 'dev-a', remote: true });
    expect(count('select count(*) c from usage_daily where file_path = ?', p)).toBe(1);
    forgetTranscriptFile(db, p);
    expect(db.prepare('select 1 from transcript_files where path = ?').get(p)).toBeUndefined();
    expect(count('select count(*) c from event_index where session_id = ?', 's1')).toBe(0);
    expect(count("select count(*) c from event_fts where session_id = 's1'")).toBe(0);
    // 日別の集計も落とす。残すと、同じ本文を別のパスで数え直したときにトークンが倍になる。
    expect(count('select count(*) c from usage_daily where file_path = ?', p)).toBe(0);
    forgetTranscriptFile(db, '/nope');
  });
});

describe('新しい発言で状態を外す', () => {
  /** フィクスチャの主線の最後の記録の時刻。 */
  const ALPHA_END = Date.parse('2026-09-01T10:04:00.000Z');
  const rec = (o: Record<string, unknown>, ts: string) => ({ ...o, uuid: `x-${ts}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
  const prompt = (text: string, ts: string) => rec({ type: 'user', message: { role: 'user', content: text } }, ts);
  const stateOf = (id: string) => db.prepare('select status, candidate_at, rejected_at from session_states where session_id = ?').get(id);
  /** 最後に積んだ変更の連番。未送信の差分は同じ行ごとに 1 つへまとまるので、書いたかどうかは件数ではなくこれで見る。 */
  const lastSeq = (table = 'session_states') => (db.prepare('select max(seq) s from changes where table_name = ?').get(table) as { s: number | null }).s;

  /** 状態を付けた後に resume したプロセス。発言を出したプロセスの起動時刻として返す。 */
  const RESUMED = ALPHA_END + 120_000;
  const resumed = { deviceId: DEV, processStartOf: () => RESUMED };

  it('resume した後に打った発言で、状態を外して Active に戻す。起動時刻はそのセッションと発言の時刻で引く', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'done', setBy: 'user', now: ALPHA_END + 60_000 });
    appendJson(alphaMain().path, prompt('もう一つ直して', '2026-09-01T11:00:00.000Z'));
    const asked: unknown[] = [];
    indexFile(db, alphaMain(), { deviceId: DEV, processStartOf: (q) => { asked.push(q); return RESUMED; } });
    expect(stateOf(sessionId)).toEqual({ status: null, candidate_at: null, rejected_at: null });
    expect(asked).toEqual([{ sessionId, providerSessionId: SESSION_ALPHA, promptTs: Date.parse('2026-09-01T11:00:00.000Z') }]);
  });
  // 実物の確かめ（2026-10-02）：会話で Paused を選んだ直後に、同じ会話で打った発言で外れていた。
  it('同じプロセスの続きの発言（プロセスの起動が状態を付けた時刻より前）では、状態を外さない', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'paused', returnOn: '2026-09-02', setBy: 'conversation', now: ALPHA_END + 60_000 });
    appendJson(alphaMain().path, prompt('ポーズになってなくね？', '2026-09-01T11:00:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV, processStartOf: () => ALPHA_END - 600_000 });
    expect(stateOf(sessionId)).toMatchObject({ status: 'paused' });
  });
  it('プロセスの起動時刻が取れなければ状態は外さず、提案は外す', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'done', setBy: 'user', now: ALPHA_END + 60_000 });
    appendJson(alphaMain().path, prompt('続けて', '2026-09-01T11:00:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV, processStartOf: () => null });
    expect(stateOf(sessionId)).toMatchObject({ status: 'done' });
    // 起動時刻を引く口が渡されないときも同じである。
    appendJson(alphaMain().path, prompt('もう一度', '2026-09-01T11:10:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(stateOf(sessionId)).toMatchObject({ status: 'done' });
  });
  it('続きの発言で、提案と却下の印は外す', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    proposeSessionState(db, DEV, sessionId, { status: 'done', note: '済んだ', returnOn: null, source: 'in_session', now: ALPHA_END + 60_000 });
    appendJson(alphaMain().path, prompt('まだ続ける', '2026-09-01T11:00:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV, processStartOf: () => null });
    expect(stateOf(sessionId)).toEqual({ status: null, candidate_at: null, rejected_at: null });
    proposeSessionState(db, DEV, sessionId, { status: 'done', note: '済んだ', returnOn: null, source: 'in_session', now: Date.parse('2026-09-01T11:05:00.000Z') });
    rejectSessionState(db, DEV, sessionId, Date.parse('2026-09-01T11:06:00.000Z'));
    appendJson(alphaMain().path, prompt('もう少し', '2026-09-01T11:10:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(stateOf(sessionId)).toEqual({ status: null, candidate_at: null, rejected_at: null });
  });
  it('発言の時刻が状態を付けた時刻より前なら外さない', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'done', setBy: 'user', now: Date.parse('2026-09-01T11:00:00.000Z') });
    appendJson(alphaMain().path, prompt('遅れて索引に来た発言', '2026-09-01T10:30:00.000Z'));
    indexFile(db, alphaMain(), resumed);
    expect(stateOf(sessionId)).toMatchObject({ status: 'done' });
  });
  it('AskUserQuestion の答え（ツールの結果）、要約で続けた頭、中断の印では外さない', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'done', setBy: 'conversation', now: ALPHA_END + 60_000 });
    appendJson(alphaMain().path,
      rec({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'このセッションをどうしますか' }] } }], usage: { input_tokens: 0, output_tokens: 1 } } }, '2026-09-01T10:06:00.000Z'),
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'User has answered your questions: "このセッションをどうしますか"="Done にする".' }] } }, '2026-09-01T10:07:00.000Z'),
      rec({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } }, '2026-09-01T10:08:00.000Z'),
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }, '2026-09-01T10:09:00.000Z'));
    indexFile(db, alphaMain(), resumed);
    expect(stateOf(sessionId)).toMatchObject({ status: 'done' });
  });
  // Review Focus 3：作り直しは前からある発言を全部読み直す。
  it('索引を作り直しても、前からある発言では外れない', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: 1 });
    setSessionState(db, DEV, sessionId, { status: 'paused', returnOn: '2026-09-02', setBy: 'user', now: ALPHA_END + 60_000 });
    const before = lastSeq();
    indexFile(db, alphaMain(), { ...resumed, indexerVersion: 2 });
    expect(stateOf(sessionId)).toMatchObject({ status: 'paused' });
    expect(lastSeq()).toBe(before);
  });
  // Review Focus 2：状態の無いセッションでは、発言のたびに共有テーブルへ書かない。
  it('状態も提案も無いセッションの発言では、session_states に書かない', () => {
    indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path, prompt('続けて', '2026-09-01T11:00:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(lastSeq()).toBeNull();
    expect(count('select count(*) c from session_states')).toBe(0);
  });
  it('サブエージェントの記録は発言に数えない', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'done', setBy: 'user', now: ALPHA_END + 60_000 });
    appendJson(alphaSub().path, prompt('サブエージェントへの指示', '2026-09-01T11:00:00.000Z'));
    indexFile(db, alphaSub(), resumed);
    expect(stateOf(sessionId)).toMatchObject({ status: 'done' });
  });
  it('他端末の写しの発言では外さず、共有テーブルに書かない', () => {
    const u = '22222222-2222-4222-8222-222222222222';
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rem-state-'));
    try {
      upsertShared(db, 'sessions', { id: 's9', provider: 'claude-code', provider_session_id: u, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
      setSessionState(db, DEV, 's9', { status: 'done', setBy: 'user', now: Date.parse('2026-09-01T00:00:00.000Z') });
      const before = lastSeq();
      const p = path.join(remoteDir, 'dev-b', 'projects', '-w-alpha', `${u}.jsonl`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: '別の PC で続けた' }, cwd: '/w/alpha', timestamp: '2026-09-02T00:00:00.000Z' }) + '\n');
      indexFile(db, { path: p, sessionId: u, agentId: null, deviceId: 'dev-b' }, { ...resumed, remote: true });
      expect(stateOf('s9')).toMatchObject({ status: 'done' });
      expect(lastSeq()).toBe(before);
    } finally {
      fs.rmSync(remoteDir, { recursive: true, force: true });
    }
  });
});

describe('Claude Code との互換の見張り', () => {
  const NEW = 'bbbbbbbb-0000-4000-8000-0000000000c1';
  const lines = (uuid: string) => [
    { type: 'user', message: { role: 'user', content: '古い版の発言' }, uuid: 'c1', timestamp: '2026-10-01T00:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: uuid, version: '2.1.100' },
    { type: 'old-meta', sessionId: uuid },
    { type: 'system', subtype: 'turn_end', content: '', timestamp: '2026-10-01T00:00:01.000Z', sessionId: uuid, version: '2.1.300' },
    { type: 'new-meta', sessionId: uuid },
  ];
  it('手元の本文の行を見張り、版を添えてずれを渡す。索引の中身は変えない', () => {
    const p = path.join(dir, 'projects', '-Users-me-workspace-alpha', `${NEW}.jsonl`);
    appendJson(p, ...lines(NEW));
    const seen: Drift[] = [];
    indexFile(db, { path: p, sessionId: NEW, agentId: null, deviceId: null }, { deviceId: DEV, compat: { sink: { note: (d) => seen.push(d) }, since: () => '2.1.292' } });
    expect(seen).toEqual([
      { contract: 'transcript', value: 'system.subtype=turn_end', version: '2.1.300' },
      { contract: 'transcript', value: 'type=new-meta', version: '2.1.300' },
    ]);
    const sid = findSession(db, NEW)!;
    expect((db.prepare('select kind from event_index where session_id = ? order by seq').all(sid) as { kind: string }[]).map((r) => r.kind)).toEqual(['user', 'meta', 'system', 'meta']);
  });
  it('ずれの受け口が投げても、そのファイルの索引は最後まで作る', () => {
    const p = path.join(dir, 'projects', '-Users-me-workspace-alpha', `${NEW}.jsonl`);
    appendJson(p, ...lines(NEW));
    const sink = { note: () => { throw new Error('sink'); } };
    expect(() => indexFile(db, { path: p, sessionId: NEW, agentId: null, deviceId: null }, { deviceId: DEV, compat: { sink, since: () => '2.1.292' } })).not.toThrow();
    const sid = findSession(db, NEW)!;
    expect((db.prepare('select kind from event_index where session_id = ? order by seq').all(sid) as { kind: string }[]).map((r) => r.kind)).toEqual(['user', 'meta', 'system', 'meta']);
  });
  it('他端末から降ろした写しは見張らない', () => {
    const p = path.join(dir, 'remote-copy.jsonl');
    appendJson(p, ...lines(NEW));
    ensureSession(db, NEW, '/Users/me/workspace/alpha', DEV);
    const seen: Drift[] = [];
    indexFile(db, { path: p, sessionId: NEW, agentId: null, deviceId: 'other' }, { deviceId: DEV, remote: true, compat: { sink: { note: (d) => seen.push(d) }, since: () => '2.1.292' } });
    expect(seen).toEqual([]);
  });
});

describe('indexFile の重さ', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const assistantLine = (text: string, ts: string) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text }] }, uuid: `a-${ts}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });

  it('呼び手が stat を渡せば、もう一度 statSync しない', () => {
    const f = alphaMain();
    indexFile(db, f, { deviceId: DEV });
    const st = fs.statSync(f.path);
    const statSync = vi.spyOn(fs, 'statSync');
    expect(indexFile(db, f, { deviceId: DEV, stat: st })).toMatchObject({ changed: false });
    expect(statSync).not.toHaveBeenCalled();
    // 伸びたファイルでは、新しい行を読む側（readNewLines）が今の末尾を 1 度だけ確かめる。
    appendJson(f.path, assistantLine('追記', '2026-09-01T11:00:00.000Z'));
    const grown = fs.statSync(f.path);
    statSync.mockClear();
    expect(indexFile(db, f, { deviceId: DEV, stat: grown })).toMatchObject({ changed: true, appended: 1 });
    expect(statSync).toHaveBeenCalledTimes(1);
  });

  it('変わっていないファイルでは、準備済みの文を使い回して prepare しない', () => {
    const f = alphaMain();
    indexFile(db, f, { deviceId: DEV });
    indexFile(db, f, { deviceId: DEV });
    const prepare = vi.spyOn(db, 'prepare');
    expect(indexFile(db, f, { deviceId: DEV })).toMatchObject({ changed: false });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('追記を読むときも、索引の表の文は DB ごとに 1 度だけ準備する', () => {
    const f = alphaMain();
    indexFile(db, f, { deviceId: DEV });
    appendJson(f.path, assistantLine('1 回目', '2026-09-01T11:00:00.000Z'));
    indexFile(db, f, { deviceId: DEV });
    const prepare = vi.spyOn(db, 'prepare');
    appendJson(f.path, assistantLine('2 回目', '2026-09-01T11:01:00.000Z'));
    expect(indexFile(db, f, { deviceId: DEV })).toMatchObject({ changed: true, appended: 1 });
    // sessions と changes は共有の行の書き手（db/shared.ts）が扱うので、ここでは索引が自分で持つ表だけを見る。
    const own = /\b(transcript_files|event_index|event_fts|usage_daily|session_stats|session_activity|session_limits|artifact_calls)\b/;
    expect(prepare.mock.calls.map((c) => c[0]).filter((sql) => own.test(sql))).toEqual([]);
  });
});
