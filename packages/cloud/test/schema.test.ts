import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_VERSION } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache, SCHEMA_STATEMENTS } from '../src/schema.ts';
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

const tables = async (db: D1Database): Promise<string[]> =>
  (await db.prepare("select name from sqlite_master where type = 'table' order by name").all<{ name: string }>()).results.map((r) => r.name);

const columns = async (db: D1Database, table: string): Promise<string[]> =>
  (await db.prepare(`pragma table_info(${table})`).all<{ name: string }>()).results.map((c) => c.name);

const cloudIdInMeta = async (db: D1Database): Promise<string | undefined> =>
  (await db.prepare("select value from meta where key = 'cloud_id'").first<{ value: string }>())?.value;

describe('schema（版 9）', () => {
  it('版 9 の表が作られ、rows に表名と行 ID と payload の列が無い', async () => {
    await ensureSchema(cloud.env);
    await ensureSchema(cloud.env);
    const names = await tables(cloud.env.DB);
    for (const t of ['devices', 'files', 'join_codes', 'keyboxes', 'launch_requests', 'meta', 'mobile_feeds', 'mobile_pairings', 'phone_keyboxes', 'roster', 'rows']) expect(names).toContain(t);
    // 参加用の秘密と、版 5 までの変更ログは持たない。
    expect(names).not.toContain('join_secrets');
    expect(names).not.toContain('changes');
    expect(await columns(cloud.env.DB, 'rows')).toEqual(['seq', 'k', 'op', 'updated_at', 'device_id', 'epoch', 'sealed']);
    expect(await columns(cloud.env.DB, 'files')).toEqual(['seq', 'key', 'kind', 'device_id', 'size', 'stored_size', 'uploaded_at', 'epoch', 'sealed_meta']);
    for (const t of ['keyboxes', 'phone_keyboxes']) expect(await columns(cloud.env.DB, t)).toEqual(['epoch', 'recipient', 'created_at', 'sealed']);
    expect(await columns(cloud.env.DB, 'roster')).toEqual(['id', 'version', 'updated_at', 'sealed']);
    expect(await columns(cloud.env.DB, 'join_codes')).toEqual(['code_hash', 'created_by', 'created_at', 'expires_at', 'used_at', 'status', 'device_id', 'request', 'request_at']);
    const indexes = (await cloud.env.DB.prepare("select name from sqlite_master where type = 'index'").all<{ name: string }>()).results.map((r) => r.name);
    expect(indexes).toContain('join_codes_by');
    expect(SCHEMA_STATEMENTS.every((s) => !s.includes('\n'))).toBe(true);
  });

  it('devices に IP と所在地の列が無い（名前と OS も持たない）', async () => {
    await ensureSchema(cloud.env);
    const cols = await columns(cloud.env.DB, 'devices');
    expect(cols).toEqual(['id', 'kind', 'token_hash', 'joined_at', 'last_seen_at', 'last_pulled_seq', 'revoked_at', 'expires_at']);
    for (const c of ['last_ip', 'last_city', 'last_region', 'last_country', 'name', 'platform']) expect(cols).not.toContain(c);
    expect(SCHEMA_STATEMENTS.some((s) => /last_ip|last_city|last_region|last_country/.test(s))).toBe(false);
  });

  it('スマホの表は鍵の世代（epoch）を持ち、mobile_pairings は request を持つ', async () => {
    await ensureSchema(cloud.env);
    for (const t of ['mobile_feeds', 'launch_requests', 'mobile_pairings']) expect(await columns(cloud.env.DB, t)).toContain('epoch');
    expect(await columns(cloud.env.DB, 'mobile_pairings')).toContain('request');
  });

  it('roster は 1 行だけを持つ', async () => {
    await ensureSchema(cloud.env);
    const db = cloud.env.DB;
    await db.prepare('insert into roster (id, version, updated_at, sealed) values (1, 1, 1, ?)').bind(new Uint8Array([1])).run();
    await expect(db.prepare('insert into roster (id, version, updated_at, sealed) values (2, 1, 1, ?)').bind(new Uint8Array([1])).run()).rejects.toThrow();
  });

  it('cloud_id は 2 回目の用意で変わらない', async () => {
    const first = await ensureSchema(cloud.env);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await cloudIdInMeta(cloud.env.DB)).toBe(first);
    // isolate を作り直しても（cold start）、表を作ったときの値のままである。
    resetSchemaCache();
    expect(await ensureSchema(cloud.env)).toBe(first);
    expect(await cloudIdInMeta(cloud.env.DB)).toBe(first);
  });

  it('/health は ok と版と cloudId を返し、そのついでに表ができている', async () => {
    const r = await cloud.SELF.fetch('https://x/health');
    expect(r.status).toBe(200);
    const cloudId = await cloudIdInMeta(cloud.env.DB);
    expect(cloudId).toBeDefined();
    expect(await r.json()).toEqual({ ok: true, version: desktop.version, compat: COMPAT_VERSION, cloudId });
    expect(await tables(cloud.env.DB)).toContain('devices');
  });

  it('知らない道は 404 を返す', async () => {
    const r = await cloud.SELF.fetch('https://x/nope');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
  });
});
