import { describe, expect, it } from 'vitest';
import { openDb } from './open.ts';
import { softDeleteShared, upsertShared } from './shared.ts';

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
