import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache, SCHEMA_STATEMENTS } from '../src/schema.ts';
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
    for (const t of ['changes', 'devices', 'files', 'join_secrets', 'meta', 'rows']) expect(names).toContain(t);
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

  it('/health は ok と版を返し、そのついでに表ができている', async () => {
    const r = await cloud.SELF.fetch('https://x/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: '0.4.0' });
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
