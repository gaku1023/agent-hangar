import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_VERSION } from '@agent-hangar/shared';
import { META_ROWS_V6, ensureSchema, migrateRowsV6, resetSchemaCache, rowsV6Statements, SCHEMA_STATEMENTS } from '../src/schema.ts';
import desktop from '../../../apps/desktop/package.json' with { type: 'json' };
import { startCloud, type CloudHarness } from './harness.ts';

let cloud: CloudHarness;

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
});

afterEach(async () => {
  await cloud.dispose();
});

describe('schema', () => {
  it('全部の表を作り、2 回呼んでも壊れない', async () => {
    await ensureSchema(cloud.env);
    await ensureSchema(cloud.env);
    const names = (
      await cloud.env.DB.prepare("select name from sqlite_master where type = 'table' order by name").all<{ name: string }>()
    ).results.map((r) => r.name);
    for (const t of ['devices', 'files', 'join_secrets', 'meta', 'rows']) expect(names).toContain(t);
    // 新しい D1 には、変更ログの表を最初から作らない。rows は連番を持つ形で作る。
    expect(names).not.toContain('changes');
    const cols = (await cloud.env.DB.prepare('pragma table_info(rows)').all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).toContain('seq');
    expect(SCHEMA_STATEMENTS.every((s) => !s.includes('\n'))).toBe(true);
  });

  it('JOIN_SECRET_HASH があれば join_secrets に写し、同じ値は重複しない', async () => {
    const e = { ...cloud.env, JOIN_SECRET_HASH: 'a'.repeat(64) };
    await ensureSchema(e);
    resetSchemaCache();
    await ensureSchema(e);
    const rows = (
      await cloud.env.DB.prepare('select secret_hash, revoked_at from join_secrets').all<{ secret_hash: string; revoked_at: number | null }>()
    ).results;
    expect(rows).toEqual([{ secret_hash: 'a'.repeat(64), revoked_at: null }]);
  });

  it('新しい JOIN_SECRET_HASH は古い行を revoke する', async () => {
    await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: 'a'.repeat(64) });
    resetSchemaCache();
    await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: 'b'.repeat(64) });
    const rows = (
      await cloud.env.DB.prepare('select secret_hash, revoked_at from join_secrets order by created_at, rowid').all<{
        secret_hash: string;
        revoked_at: number | null;
      }>()
    ).results;
    expect(rows[0]!.revoked_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ secret_hash: 'b'.repeat(64), revoked_at: null });
  });

  it('一度 revoke した秘密は、同じ JOIN_SECRET_HASH のまま起こし直しても復活しない', async () => {
    const a = 'a'.repeat(64);
    await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: a });
    // 運用者が D1 の側で締め出した状態である。
    await cloud.env.DB.prepare('update join_secrets set revoked_at = ? where secret_hash = ?').bind(1000, a).run();
    // isolate を作り直しても（cold start）、Worker の secret はまだ同じ値を持っている。
    resetSchemaCache();
    await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: a });
    const rows = (
      await cloud.env.DB.prepare('select secret_hash, revoked_at from join_secrets').all<{ secret_hash: string; revoked_at: number | null }>()
    ).results;
    expect(rows).toEqual([{ secret_hash: a, revoked_at: 1000 }]);
  });

  it('回した後に古い JOIN_SECRET_HASH が戻ってきても、新しい方を revoke しない', async () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: a });
    resetSchemaCache();
    await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: b });
    // 古い秘密を持ったままの 2 台目が hangar setup cloud をやり直した筋である。
    resetSchemaCache();
    await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: a });
    const active = (
      await cloud.env.DB.prepare('select secret_hash from join_secrets where revoked_at is null order by created_at, rowid').all<{ secret_hash: string }>()
    ).results.map((r) => r.secret_hash);
    expect(active).toEqual([b]);
  });

  it('Worker 自身が束縛の JOIN_SECRET_HASH を join_secrets に写す', async () => {
    const c = 'c'.repeat(64);
    const worker = await startCloud({ JOIN_SECRET_HASH: c });
    try {
      const r = await worker.SELF.fetch('https://x/health');
      expect(r.status).toBe(200);
      const rows = (
        await worker.env.DB.prepare('select secret_hash, revoked_at from join_secrets').all<{ secret_hash: string; revoked_at: number | null }>()
      ).results;
      expect(rows).toEqual([{ secret_hash: c, revoked_at: null }]);
    } finally {
      await worker.dispose();
    }
  });

  it('/health は ok と版を返し、そのついでに表ができている', async () => {
    const r = await cloud.SELF.fetch('https://x/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: desktop.version, compat: COMPAT_VERSION });
    const names = (
      await cloud.env.DB.prepare("select name from sqlite_master where type = 'table'").all<{ name: string }>()
    ).results.map((r2) => r2.name);
    expect(names).toContain('devices');
  });

  it('知らない道は 404 を返す', async () => {
    const r = await cloud.SELF.fetch('https://x/nope');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
  });
});

/** 版 5 までの Worker が作った D1 を真似る。 */
async function oldD1(db: D1Database, o: { rows: [k: string, updatedAt: number][]; changesSeqs?: number[]; seqHigh?: number; withChanges?: boolean }): Promise<void> {
  const stmts = [
    db.prepare('create table meta (key text primary key, value text not null)'),
    db.prepare('create table rows (k text primary key, table_name text not null, row_id text not null, op text not null, payload text not null, updated_at integer not null, device_id text not null)'),
  ];
  if (o.withChanges !== false) {
    stmts.push(
      db.prepare('create table changes (seq integer primary key autoincrement, table_name text not null, row_id text not null, op text not null, payload text not null, updated_at integer not null, device_id text not null, received_at integer not null)'),
      db.prepare('create index changes_device on changes(device_id, seq)'),
    );
  }
  for (const [k, at] of o.rows) {
    const [t, id] = k.split(':');
    stmts.push(db.prepare("insert into rows values (?, ?, ?, 'upsert', '{}', ?, 'dev-a')").bind(k, t, id, at));
  }
  for (const seq of o.changesSeqs ?? []) stmts.push(db.prepare("insert into changes values (?, 'projects', 'x', 'upsert', '{}', 1, 'dev-a', 1)").bind(seq));
  if (o.seqHigh !== undefined) stmts.push(db.prepare("insert into meta values ('seq_high', ?)").bind(String(o.seqHigh)));
  await db.batch(stmts);
}

const rowSeqs = async (db: D1Database): Promise<[string, number][]> =>
  (await db.prepare('select k, seq from rows order by seq').all<{ k: string; seq: number }>()).results.map((r) => [r.k, r.seq]);

const tables = async (db: D1Database): Promise<string[]> =>
  (await db.prepare("select name from sqlite_master where type = 'table'").all<{ name: string }>()).results.map((r) => r.name);

/** 移行の後に新しい行を 1 つ書き、振られた連番を返す。push と同じ形の文である。 */
const insertNew = async (db: D1Database, k: string): Promise<number> => {
  await db.prepare("insert into rows (k, table_name, row_id, op, payload, updated_at, device_id) values (?, 'projects', 'n', 'upsert', '{}', 1, 'dev-b') on conflict(k) do nothing").bind(k).run();
  return (await db.prepare('select seq from rows where k = ?').bind(k).first<{ seq: number }>())!.seq;
};

describe('rows の移行（同期の版 6）', () => {
  it('旧い rows に、旧い高水位より上から updated_at と鍵の順に連番を振り、changes を消す', async () => {
    const db = cloud.env.DB;
    await oldD1(db, { rows: [['projects:b', 5], ['projects:a', 5], ['sessions:s', 1]], changesSeqs: [8, 10], seqHigh: 7 });
    await ensureSchema(cloud.env);
    // H は meta.seq_high（7）と changes の最大（10）の大きい方。
    expect(await rowSeqs(db)).toEqual([['sessions:s', 11], ['projects:a', 12], ['projects:b', 13]]);
    expect(await tables(db)).not.toContain('changes');
    expect(await tables(db)).not.toContain('rows_v6');
    expect(await insertNew(db, 'projects:new')).toBe(14);
    // 鍵の一意は保たれる。
    await insertNew(db, 'projects:a');
    expect((await db.prepare("select count(*) c from rows where k = 'projects:a'").first<{ c: number }>())!.c).toBe(1);
    expect(await db.prepare('select value from meta where key = ?').bind(META_ROWS_V6).first()).not.toBeNull();
  });

  it('changes が圧縮で空でも、meta.seq_high より上から振る', async () => {
    const db = cloud.env.DB;
    await oldD1(db, { rows: [['projects:a', 1], ['projects:b', 2]], seqHigh: 50 });
    await ensureSchema(cloud.env);
    expect(await rowSeqs(db)).toEqual([['projects:a', 51], ['projects:b', 52]]);
  });

  it('rows が空でも、移行の後の最初の行は旧い高水位より上に振る', async () => {
    const db = cloud.env.DB;
    await oldD1(db, { rows: [], changesSeqs: [20] });
    await ensureSchema(cloud.env);
    expect(await rowSeqs(db)).toEqual([]);
    expect(await insertNew(db, 'projects:new')).toBe(21);
  });

  it('changes の表が無くても移行できる', async () => {
    const db = cloud.env.DB;
    await oldD1(db, { rows: [['projects:a', 1]], seqHigh: 3, withChanges: false });
    await ensureSchema(cloud.env);
    expect(await rowSeqs(db)).toEqual([['projects:a', 4]]);
  });

  it('移行の文の束を 2 回流すと、2 回目は印の一意で丸ごと落ち、連番を振り直さない', async () => {
    const db = cloud.env.DB;
    await oldD1(db, { rows: [['projects:a', 1], ['projects:b', 2]], changesSeqs: [3] });
    const late = await rowsV6Statements(db, Date.now());
    await ensureSchema(cloud.env);
    const after = await rowSeqs(db);
    // 2 本目の isolate が、移行の前に組んだ束を後から流した筋である。
    await expect(db.batch(late)).rejects.toThrow();
    expect(await rowSeqs(db)).toEqual(after);
    expect(await tables(db)).not.toContain('rows_v6');
  });

  it('2 つの isolate が同時に移行を始めても、両方とも落ちずに済み、1 回だけ振る', async () => {
    const db = cloud.env.DB;
    await oldD1(db, { rows: [['projects:a', 1], ['projects:b', 2]], changesSeqs: [3] });
    const results = await Promise.all([migrateRowsV6(db, Date.now()), migrateRowsV6(db, Date.now())]);
    expect(results.filter((r) => r === 'migrated')).toHaveLength(1);
    expect(await rowSeqs(db)).toEqual([['projects:a', 4], ['projects:b', 5]]);
  });

  it('移行済みの D1 では何もしない', async () => {
    await ensureSchema(cloud.env);
    expect(await migrateRowsV6(cloud.env.DB, Date.now())).toBe('none');
  });
});
