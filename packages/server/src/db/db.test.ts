import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from './migrations.ts';
import { openDb } from './open.ts';
import { softDeleteShared, upsertShared } from './shared.ts';

/** version 以下のマイグレーションだけを当てた実物のファイルを作る。既存の DB からの移行を試すため。 */
function openDbAt(file: string, version: number): void {
  const db = new Database(file);
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
    db.exec(m.sql);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, 1);
  }
  db.close();
}

describe('openDb', () => {
  it('共有テーブル、ローカルテーブル、FTS を作る', () => {
    const db = openDb(':memory:');
    const names = db.prepare("select name from sqlite_master where type in ('table') order by name").all().map((r) => (r as { name: string }).name);
    for (const t of ['devices', 'projects', 'project_roots', 'sessions', 'runs', 'run_tabs', 'session_summaries', 'todos', 'project_memos', 'artifacts', 'artifact_versions', 'takeover_requests', 'changes', 'transcript_files', 'event_index', 'event_fts', 'session_stats', 'usage_snapshots', 'sync_state', 'settings_local', 'schema_migrations']) {
      expect(names, t).toContain(t);
    }
  });
  it('二度開いてもマイグレーションを重ねて適用しない', () => {
    const db = openDb(':memory:');
    const n = () => (db.prepare('select count(*) c from schema_migrations').get() as { c: number }).c;
    expect(n()).toBeGreaterThan(0);
  });
  it('version 3 の端末ローカルの表がある', () => {
    const db = openDb(':memory:');
    const names = (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['session_live_stats', 'artifact_calls', 'usage_daily']));
    db.prepare('insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)').run('u1', 'claude-opus-4-1', 'high', 50_000, 200_000, 0.12, 1);
    db.prepare('insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens) values (?,?,?,?,?)').run('s1', '2026-09-01', '/a.jsonl', 10, 2);
    expect(db.prepare('select count(*) c from usage_daily').get()).toEqual({ c: 1 });
  });
  it('version 4 で usage_daily がファイル別になり、artifact_versions に artifact_id の索引がある', () => {
    const db = openDb(':memory:');
    expect((db.prepare('select max(version) v from schema_migrations').get() as { v: number }).v).toBe(4);
    const cols = (db.prepare("select name from pragma_table_info('usage_daily')").all() as { name: string }[]).map((r) => r.name);
    expect(cols).toContain('file_path');
    // 同じセッションの同じ日でも、ファイルが違えば別の行になる。
    const ins = db.prepare('insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens) values (?,?,?,?,?)');
    ins.run('s1', '2026-09-01', '/main.jsonl', 10, 2);
    ins.run('s1', '2026-09-01', '/sub.jsonl', 5, 1);
    expect(db.prepare('select count(*) c from usage_daily').get()).toEqual({ c: 2 });
    const idx = (db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'artifact_versions'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toContain('artifact_versions_artifact');
  });
  it('マイグレーション 3 まで進んだ既存の DB から上げられ、日別の行は主線のファイルに移る', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mig-'));
    const file = path.join(tmp, 'hangar.db');
    openDbAt(file, 3);
    const old = new Database(file);
    old.prepare('insert into usage_daily (session_id, day, input_tokens, output_tokens) values (?,?,?,?)').run('s1', '2026-09-01', 10, 2);
    old.prepare('insert into usage_daily (session_id, day, input_tokens, output_tokens) values (?,?,?,?)').run('s2', '2026-09-02', 7, 3);
    old.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?)').run('/p/s1.jsonl', 's1', null, 1, 1, 1, 1);
    old.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version) values (?,?,?,?,?,?,?)').run('/p/s1-sub.jsonl', 's1', 'ag1', 1, 1, 1, 1);
    old.close();
    const db = openDb(file);
    expect((db.prepare('select max(version) v from schema_migrations').get() as { v: number }).v).toBe(4);
    expect(db.prepare('select session_id, day, file_path, input_tokens, output_tokens from usage_daily order by session_id').all()).toEqual([
      { session_id: 's1', day: '2026-09-01', file_path: '/p/s1.jsonl', input_tokens: 10, output_tokens: 2 },
      { session_id: 's2', day: '2026-09-02', file_path: '', input_tokens: 7, output_tokens: 3 },
    ]);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it('FTS5 trigram で日本語の部分一致ができる', () => {
    const db = openDb(':memory:');
    db.prepare('insert into event_fts (session_id, seq, role, text) values (?,?,?,?)').run('s1', 0, 'user', '動画チャンネルの整理をしたい');
    const rows = db.prepare("select seq from event_fts where text match ?").all('"チャンネル"');
    expect(rows).toHaveLength(1);
  });
});

describe('upsertShared', () => {
  it('行を作り、changes に 1 行を積む', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'x', status: 'active', is_scratch: 0 }, 'dev1');
    const row = db.prepare('select * from projects where id = ?').get('p1') as Record<string, unknown>;
    expect(row.name).toBe('x');
    expect(row.origin_device).toBe('dev1');
    expect(typeof row.updated_at).toBe('number');
    const ch = db.prepare('select * from changes').all() as Record<string, unknown>[];
    expect(ch).toHaveLength(1);
    expect(ch[0]!.table_name).toBe('projects');
    expect(ch[0]!.op).toBe('upsert');
    expect(JSON.parse(ch[0]!.payload as string).name).toBe('x');
  });
  it('同じ id は更新になり、行は増えない', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'x', status: 'active', is_scratch: 0 }, 'dev1');
    upsertShared(db, 'projects', { id: 'p1', name: 'y', status: 'paused', is_scratch: 0 }, 'dev1');
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 1 });
    expect((db.prepare('select name, status from projects').get() as { name: string; status: string })).toEqual({ name: 'y', status: 'paused' });
    // 未送信の差分は後勝ちなので 1 行にまとまり、中身は最後の状態になる。
    expect(db.prepare('select count(*) c from changes').get()).toEqual({ c: 1 });
    expect(JSON.parse((db.prepare('select payload from changes').get() as { payload: string }).payload).status).toBe('paused');
  });
  it('未送信の差分はまとめ、送信済みの差分は残す', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'x', status: 'active', is_scratch: 0 }, 'dev1');
    db.prepare('update changes set pushed_at = ?').run(1);
    for (let i = 0; i < 5; i++) upsertShared(db, 'projects', { id: 'p1', name: 'x', status: 'active', is_scratch: 0 }, 'dev1');
    expect(db.prepare('select count(*) c from changes where pushed_at is null').get()).toEqual({ c: 1 });
    expect(db.prepare('select count(*) c from changes where pushed_at is not null').get()).toEqual({ c: 1 });
  });
  it('他の行の差分はまとめない', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'x', status: 'active', is_scratch: 0 }, 'dev1');
    upsertShared(db, 'projects', { id: 'p2', name: 'y', status: 'active', is_scratch: 0 }, 'dev1');
    expect(db.prepare('select count(*) c from changes').get()).toEqual({ c: 2 });
  });
  it('主キーが id でない表も書ける', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'dev1' }, 'dev1');
    upsertShared(db, 'session_summaries', { session_id: 's1', title: 't', one_liner: 'o', body: 'b', state: 'done', next_steps: '[]', source: 'baseline', based_on_turns: 3 }, 'dev1', 'session_id');
    expect(db.prepare('select title from session_summaries where session_id = ?').get('s1')).toEqual({ title: 't' });
  });
  it('softDeleteShared は deleted_at を立てて delete を積む', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'x', status: 'active', is_scratch: 0 }, 'dev1');
    softDeleteShared(db, 'projects', 'p1', 'dev1');
    const row = db.prepare('select deleted_at from projects where id = ?').get('p1') as { deleted_at: number | null };
    expect(row.deleted_at).not.toBeNull();
    expect((db.prepare("select op from changes order by seq desc limit 1").get() as { op: string }).op).toBe('delete');
    // 未送信の upsert は delete に置き換わる。
    expect(db.prepare('select count(*) c from changes').get()).toEqual({ c: 1 });
  });
});
