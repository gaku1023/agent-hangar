import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOUD_HEADERS, COMPAT_HEADER, COMPAT_VERSION, CONFIG_BUNDLE_MIN_WORKER_COMPAT, configKey, type ChangeOut, type FileEntry } from '@agent-hangar/shared';
import { MAX_ROW_BYTES } from '../src/changes.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

/**
 * 設定の同期の束（段 4 の PR 14 の端末側）を、Worker が受けて返せること。
 * 束は既存の `PUT /files`（kind: config）で `config/<端末>/.hangar/config-bundle.hgr` に置き、
 * 行は共有表 config_snapshots として `POST /changes` で運ぶ。Worker に新しい経路は足していない。
 */
const SECRET = 'join-secret-bundle';
const BUNDLE_PATH = '.hangar/config-bundle.hgr';

let cloud: CloudHarness;
let tokA = '';
let tokB = '';

const join = async (id: string): Promise<string> => {
  const r = await cloud.SELF.fetch('https://x/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }),
  });
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

const snapshot = (deviceId: string, updatedAt: number, o: Record<string, unknown> = {}) => ({
  tableName: 'config_snapshots',
  rowId: deviceId,
  op: 'upsert',
  payload: { device_id: deviceId, bundle_sha256: 'b'.repeat(64), bundle_size: 1234, item_count: 3, manifest: '[["a","h",1]]', deleted_at: null, updated_at: updatedAt, origin_device: deviceId, ...o },
  updatedAt,
});

const push = (tok: string, changes: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  cloud.SELF.fetch('https://x/changes', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ changes }),
  });

const pull = async (tok: string, since = 0): Promise<{ changes: ChangeOut[]; nextSeq: number; more: boolean }> =>
  (await (await cloud.SELF.fetch(`https://x/changes?since=${since}`, { headers: { authorization: `Bearer ${tok}` } })).json()) as { changes: ChangeOut[]; nextSeq: number; more: boolean };

const rows = async (tok: string): Promise<ChangeOut[]> =>
  ((await (await cloud.SELF.fetch('https://x/rows?after=&limit=500', { headers: { authorization: `Bearer ${tok}` } })).json()) as { changes: ChangeOut[] }).changes;

const putBundle = (tok: string, deviceId: string, body: Uint8Array<ArrayBuffer>, sha = 'c'.repeat(64)): Promise<Response> =>
  cloud.SELF.fetch(`https://x/files/${configKey(deviceId, BUNDLE_PATH)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${tok}`,
      'content-length': String(body.byteLength),
      [CLOUD_HEADERS.path]: BUNDLE_PATH,
      [CLOUD_HEADERS.kind]: 'config',
      [CLOUD_HEADERS.sha256]: sha,
      [CLOUD_HEADERS.size]: String(body.byteLength),
      [CLOUD_HEADERS.mtime]: '1700000000000',
      [CLOUD_HEADERS.encrypted]: '1',
    },
    body,
  });

const listFiles = async (tok: string): Promise<FileEntry[]> =>
  ((await (await cloud.SELF.fetch('https://x/files?since=0&limit=500', { headers: { authorization: `Bearer ${tok}` } })).json()) as { files: FileEntry[] }).files;

/** 位置から中身が決まるバイト列。 */
const patterned = (n: number): Uint8Array<ArrayBuffer> => {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 7) % 251;
  return buf;
};

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  tokA = await join('dev-a');
  tokB = await join('dev-b');
});

afterEach(async () => {
  await cloud.dispose();
  resetSchemaCache();
});

describe('互換の版（束を受け取れる Worker）', () => {
  it('Worker は束の行を知る版（CONFIG_BUNDLE_MIN_WORKER_COMPAT）を名乗り、/health にも見出しにも載せる', async () => {
    expect(CONFIG_BUNDLE_MIN_WORKER_COMPAT).toBe(3);
    // 段 4 の PR 18 で名乗る版は 4 になった（旧実装を消した版）。束の行を知る版（3）以上であれば、端末は束の行を送る。
    expect(COMPAT_VERSION).toBeGreaterThanOrEqual(CONFIG_BUNDLE_MIN_WORKER_COMPAT);
    const h = await cloud.RAW.fetch('https://x/health');
    expect(((await h.json()) as { compat: number }).compat).toBe(COMPAT_VERSION);
    const r = await cloud.SELF.fetch('https://x/changes?since=0', { headers: { authorization: `Bearer ${tokA}` } });
    expect(r.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
  });
});

describe('共有表 config_snapshots（POST /changes と GET /changes と GET /rows）', () => {
  it('束の行を受け取り、別の端末の pull にも、取り直しの rows にも、そのまま載る', async () => {
    const row = snapshot('dev-a', 100);
    const r = await push(tokA, [row]);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ accepted: 1, skipped: 0 });
    const p = await pull(tokB);
    expect(p.changes.map((c) => ({ tableName: c.tableName, rowId: c.rowId, op: c.op, payload: c.payload, deviceId: c.deviceId }))).toEqual([
      { tableName: 'config_snapshots', rowId: 'dev-a', op: 'upsert', payload: row.payload, deviceId: 'dev-a' },
    ]);
    expect((await rows(tokB)).map((c) => c.payload)).toEqual([row.payload]);
    // 自端末の変更は、自分の pull には返らない。
    expect((await pull(tokA)).changes).toEqual([]);
  });

  it('新しい行が古い行を置き換え、古い行と同着は捨てる。取り下げた行（deleted_at）も同じ表に載る', async () => {
    await push(tokA, [snapshot('dev-a', 100)]);
    expect(await (await push(tokA, [snapshot('dev-a', 100, { bundle_sha256: 'd'.repeat(64) })])).json()).toMatchObject({ accepted: 0, skipped: 1 });
    expect(await (await push(tokA, [snapshot('dev-a', 200, { bundle_sha256: 'e'.repeat(64), deleted_at: 200 })])).json()).toMatchObject({ accepted: 1, skipped: 0 });
    const [only] = await rows(tokB);
    expect(only?.payload).toMatchObject({ bundle_sha256: 'e'.repeat(64), deleted_at: 200 });
    expect(await rows(tokB)).toHaveLength(1);
  });

  it('目録（manifest）が上限いっぱいの行も受け取る。上限を超える行は今までどおり 413 で断る', async () => {
    const ok = snapshot('dev-a', 100, { manifest: 'm'.repeat(96 * 1024) });
    expect((await push(tokA, [ok])).status).toBe(200);
    const big = snapshot('dev-a', 200, { manifest: 'm'.repeat(MAX_ROW_BYTES) });
    expect((await push(tokA, [big])).status).toBe(413);
  });

  it('ほかの表の行と同じ push に混ぜても、1 回で通る', async () => {
    const project = { tableName: 'projects', rowId: 'p1', op: 'upsert', updatedAt: 5, payload: { id: 'p1', name: 'p', status: 'active', is_scratch: 0, updated_at: 5, deleted_at: null, origin_device: 'dev-a' } };
    const r = await push(tokA, [project, snapshot('dev-a', 6)]);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ accepted: 2 });
    expect((await pull(tokB)).changes.map((c) => c.tableName)).toEqual(['projects', 'config_snapshots']);
  });

  it('版 3 までを名乗る端末の push は、表を問わず 426 で断られる（下限は旧実装を持たない版 4。段 4 の PR 18）', async () => {
    const project = { tableName: 'projects', rowId: 'p1', op: 'upsert', updatedAt: 5, payload: { id: 'p1', name: 'p', status: 'active', is_scratch: 0, updated_at: 5, deleted_at: null, origin_device: 'dev-a' } };
    for (const v of ['2', '3']) {
      const old = await push(tokA, [project], { [COMPAT_HEADER]: v });
      expect([v, old.status]).toEqual([v, 426]);
      expect(old.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
      expect((await push(tokA, [snapshot('dev-a', 6)], { [COMPAT_HEADER]: v })).status).toBe(426);
    }
    // 断った要求は、何も書いていない。
    expect((await pull(tokB)).changes).toEqual([]);
    // 版 4 を名乗る端末は、束の行も、ほかの表の行も、1 回で通る。
    expect((await push(tokA, [project, snapshot('dev-a', 6)], { [COMPAT_HEADER]: '4' })).status).toBe(200);
  });

  it('知らない表の行は、これまでどおり 400 で丸ごと断る', async () => {
    const r = await push(tokA, [{ ...snapshot('dev-a', 1), tableName: 'config_items' }]);
    expect(r.status).toBe(400);
    expect(await rows(tokA)).toEqual([]);
  });
});

describe('束の本体（PUT と GET の /files/config/<端末>/.hangar/config-bundle.hgr）', () => {
  it('端末 A が置いた束を、端末 B が索引から見つけて、1 バイトも違わずに降ろせる', async () => {
    const body = patterned(600 * 1024);
    const put = await putBundle(tokA, 'dev-a', body);
    expect(put.status).toBe(201);
    const entries = await listFiles(tokB);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: configKey('dev-a', BUNDLE_PATH), path: BUNDLE_PATH, kind: 'config', deviceId: 'dev-a', size: body.byteLength, encrypted: true });
    const got = await cloud.SELF.fetch(`https://x/files/${configKey('dev-a', BUNDLE_PATH)}`, { headers: { authorization: `Bearer ${tokB}` } });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(body);
  });

  it('置き直すと、本体と索引が入れ替わって 1 行のまま（件数が増えない）', async () => {
    await putBundle(tokA, 'dev-a', patterned(1000), 'a'.repeat(64));
    const second = patterned(2000);
    expect((await putBundle(tokA, 'dev-a', second, 'f'.repeat(64))).status).toBe(201);
    const entries = await listFiles(tokB);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sha256: 'f'.repeat(64), size: 2000 });
    const got = await cloud.SELF.fetch(`https://x/files/${configKey('dev-a', BUNDLE_PATH)}`, { headers: { authorization: `Bearer ${tokB}` } });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(second);
  });

  it('他の端末の束は上書きできない（403）', async () => {
    const r = await putBundle(tokB, 'dev-a', patterned(10));
    expect(r.status).toBe(403);
    expect(await listFiles(tokA)).toEqual([]);
  });
});
