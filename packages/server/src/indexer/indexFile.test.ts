import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../db/migrations.ts';
import { openDb, type Db } from '../db/open.ts';
import { listTranscriptFiles } from '../provider/claude-code/discover.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { findSession, forgetTranscriptFile, indexFile, INDEXER_VERSION } from './indexFile.ts';
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
/** 題名の解決が本物のファイルを読むので、確実に存在しないパスを渡す。 */
const missing = () => path.join(dir, 'no-such-artifact.html');
const ART_URL = 'https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001';
const artifactCall = (toolId: string, input: Record<string, unknown>, ts = '2026-09-01T12:00:00.000Z') =>
  ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: toolId, name: 'Artifact', input }], usage: { input_tokens: 0, output_tokens: 1 } }, uuid: `a-${toolId}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
const artifactResult = (toolId: string, text: string, ts = '2026-09-01T12:00:03.000Z') =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text }] }, uuid: `u-${toolId}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
const appendJson = (p: string, ...recs: unknown[]) => { for (const r of recs) fs.appendFileSync(p, JSON.stringify(r) + '\n'); };

/** version 以下のマイグレーションだけを当てた実物のファイルの DB を作り、中身を仕込む。 */
function seedOldDb(file: string, version: number, seed: (db: Db) => void): void {
  const raw = new Database(file) as unknown as Db;
  raw.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
    raw.exec(m.sql);
    raw.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, 1);
  }
  seed(raw);
  raw.close();
}

const insSession = 'insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values (?,?,?,?,?,?,?)';
const insFile = 'insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?)';

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

  it('移行前の日別が残っていた DB でも、積み直したあとに二重に数えない', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-old-'));
    const file = path.join(tmp, 'hangar.db');
    const day = localDay(Date.parse('2026-09-01T10:00:05.000Z'));
    // 版 3 の DB には、どのファイル由来か分からない日別の行がある。
    seedOldDb(file, 3, (old) => {
      old.prepare(insSession).run('s-alpha', 'claude-code', SESSION_ALPHA, '/Users/me/workspace/alpha', DEV, 1, DEV);
      old.prepare('insert into usage_daily (session_id, day, input_tokens, output_tokens) values (?,?,?,?)').run('s-alpha', day, 999, 99);
    });
    const upgraded = openDb(file);
    indexFile(upgraded, alphaMain(), { deviceId: DEV });
    indexFile(upgraded, alphaSub(), { deviceId: DEV });
    const sum = (d: Db) => d.prepare('select sum(input_tokens) i, sum(output_tokens) o from usage_daily').get() as { i: number; o: number };
    // まっさらな DB に同じファイルを索引した結果と一致する（古い行は 1 つも足されない）。
    const fresh = openDb(':memory:');
    indexFile(fresh, alphaMain(), { deviceId: DEV });
    indexFile(fresh, alphaSub(), { deviceId: DEV });
    expect(sum(upgraded)).toEqual(sum(fresh));
    upgraded.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('移行のあとは索引済みのファイルも作り直しに回り、日別が積み直される', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-old-'));
    const file = path.join(tmp, 'hangar.db');
    const main = alphaMain();
    const st = fs.statSync(main.path);
    // 版 3 の DB では、このファイルは最後まで索引済みになっている。
    seedOldDb(file, 3, (old) => {
      old.prepare(insSession).run('s-alpha', 'claude-code', SESSION_ALPHA, '/Users/me/workspace/alpha', DEV, 1, DEV);
      old.prepare(insFile).run(main.path, 's-alpha', null, st.size, Math.floor(st.mtimeMs), st.size, INDEXER_VERSION);
      old.prepare('insert into usage_daily (session_id, day, input_tokens, output_tokens) values (?,?,?,?)').run('s-alpha', localDay(Date.parse('2026-09-01T10:00:05.000Z')), 999, 99);
    });
    const upgraded = openDb(file);
    // 移行が印を戻しているので、大きさも更新時刻も同じでも飛ばさない。
    const r = indexFile(upgraded, main, { deviceId: DEV });
    expect(r.changed).toBe(true);
    expect(upgraded.prepare('select sum(input_tokens) i, sum(output_tokens) o from usage_daily').get()).toEqual({ i: 1110, o: 140 });
    upgraded.close();
    fs.rmSync(tmp, { recursive: true, force: true });
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
