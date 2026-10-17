import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION, deriveEpochKeys, toBase64Url, type ChangeIn } from '@agent-hangar/shared';
import { CompatError, HttpCloudClient, RevokedError } from '../../server/src/sync/client.ts';
import { SealedCloudClient, type RowKeyring } from '../../server/src/sync/sealedClient.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { addPcDevice, startCloud, type CloudHarness } from './harness.ts';

/**
 * 端末の本物の client（packages/server の HttpCloudClient と SealedCloudClient）と、本物の Worker（workerd）を HTTP で繋ぐ。
 * 偽物どうしでは、端末が長さを送るか、Worker がそれを R2 にそのまま渡すかを確かめられない。
 * PC は参加の往復を通さず、D1 に直に置く（harness の addPcDevice）。
 */

let cloud: CloudHarness;
let client: HttpCloudClient;
let spoolDir = '';
let workerUrl = '';
let token = '';

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  workerUrl = String(await cloud.mf.ready).replace(/\/+$/, '');
  token = await addPcDevice(cloud.env, 'pc-a');
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-e2e-'));
  client = new HttpCloudClient({ url: workerUrl, token, spoolDir });
});

afterEach(async () => {
  await cloud.dispose();
  fs.rmSync(spoolDir, { recursive: true, force: true });
});

describe('封じた行（SealedCloudClient と Worker）', () => {
  it('push した行を別の PC が pull すると元の行になり、D1 には表名、行 ID、題が平文で残らない', async () => {
    // 2 台が同じ世代 1 の鍵を持つ。鍵は作り物の決まった値である。
    const keys = await deriveEpochKeys(1, toBase64Url(new Uint8Array(32).fill(3)));
    const ring = (): RowKeyring => ({ current: () => keys, at: (n) => (n === 1 ? keys : null) });
    const a = new SealedCloudClient(client, ring(), 'pc-a');
    const b = new SealedCloudClient(new HttpCloudClient({ url: workerUrl, token: await addPcDevice(cloud.env, 'pc-b'), spoolDir }), ring(), 'pc-b');
    const rows: ChangeIn[] = [
      { tableName: 'sessions', rowId: 'session-id-1', op: 'upsert', payload: { id: 'session-id-1', title: 'title-1 '.repeat(60) }, updatedAt: 10 },
      { tableName: 'projects', rowId: 'project-id-1', op: 'delete', payload: {}, updatedAt: 20 },
    ];
    expect(await a.pushChanges(rows)).toMatchObject({ accepted: 2, skipped: 0 });
    const page = await b.pullChanges(0, 100);
    expect(page.unreadable).toEqual([]);
    expect(page.changes.map(({ seq: _s, ...c }) => c)).toEqual(rows.map((r) => ({ ...r, deviceId: 'pc-a' })));
    const snap = await b.snapshot(null, 100);
    expect(snap.changes.map((c) => c.rowId).sort()).toEqual(['project-id-1', 'session-id-1']);
    const stored = (await cloud.env.DB.prepare('select k, op, updated_at, device_id, epoch, sealed from rows').all()).results as Record<string, unknown>[];
    expect(stored).toHaveLength(2);
    const dump = stored.map((r) => Object.values(r).map((v) => (v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : Array.isArray(v) ? Buffer.from(v as number[]).toString('latin1') : String(v))).join('|')).join('\n');
    for (const plain of ['sessions', 'projects', 'session-id-1', 'project-id-1', 'title-1']) expect(dump).not.toContain(plain);
  });
});

// 版 9 の Worker の PUT /files は封じたメタ（x-hangar-meta）を求める。本文の索引を封じた形にする Task 10 で戻す。
describe.skip('HttpCloudClient と Worker', () => {
  it('流れてくる本文も長さを決めて送り、Worker は分けずに 1 回の put で置く', async () => {
    const n = 9 * 1024 * 1024 + 7; // Worker の PART_BYTES（8 MiB）を超える大きさ
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = i % 251;
    const key = 'transcripts/pc-a/big.jsonl.gz';
    // 端末の uploader と同じく、長さの分からない流れで渡す。
    const pieces = (async function* () { for (let at = 0; at < n; at += 64 * 1024) yield buf.subarray(at, at + 64 * 1024); })();
    const { seq } = await client.putFile(
      { key, path: 'projects/-x/big.jsonl', kind: 'transcript', sha256: 'a'.repeat(64), size: n, mtime: 1, encrypted: true },
      Readable.from(pieces),
    );
    expect(seq).toBe(1);
    const head = await cloud.env.BUCKET.head(key);
    expect(head!.size).toBe(n);
    // multipart の etag は「-部分の数」で終わる。付いていなければ Worker は本文を JS で切り分けていない。
    expect(head!.etag).not.toContain('-');
    const back = Buffer.from(await (await cloud.env.BUCKET.get(key))!.arrayBuffer());
    expect(back.equals(buf)).toBe(true);
    expect(fs.readdirSync(spoolDir)).toEqual([]);
  });
});

describe('互換の版（本物の client と本物の Worker）', () => {
  it('要求と応答の両方に版の見出しが載る', async () => {
    const seen: { sent: string | null; got: string | null }[] = [];
    const watched = new HttpCloudClient({
      url: workerUrl,
      token,
      spoolDir,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await fetch(input, init);
        seen.push({ sent: (init?.headers as Record<string, string> | undefined)?.[COMPAT_HEADER] ?? null, got: res.headers.get(COMPAT_HEADER) });
        return res;
      }) as typeof fetch,
    });
    await watched.pullChanges(0, 10);
    await watched.listFiles(0, 10);
    const v = String(COMPAT_VERSION);
    expect(seen).toEqual([{ sent: v, got: v }, { sent: v, got: v }]);
  });

  it('この PC の下限より Worker が古ければ、Worker を上げるよう伝える', async () => {
    const strict = new HttpCloudClient({ url: workerUrl, token, spoolDir, minWorkerCompat: COMPAT_VERSION + 1 });
    await expect(strict.pullChanges(0, 10)).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker', have: COMPAT_VERSION, need: COMPAT_VERSION + 1 });
  });

  it('Worker が下限を上げたら、426 を受けてこの PC の hangar を上げるよう伝える', async () => {
    const floor = COMPAT_VERSION + 1;
    resetSchemaCache();
    const strictCloud = await startCloud({ minDeviceCompat: floor });
    try {
      resetSchemaCache();
      await ensureSchema(strictCloud.env);
      const url = String(await strictCloud.mf.ready).replace(/\/+$/, '');
      const older = new HttpCloudClient({ url, token: await addPcDevice(strictCloud.env, 'pc-b'), spoolDir });
      const e = await older.pullChanges(0, 10).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CompatError);
      expect(e).toMatchObject({ upgrade: 'device', have: COMPAT_VERSION, need: floor });
    } finally {
      await strictCloud.dispose();
    }
  });
});

describe('PC の一覧と解除（HttpCloudClient と Worker）', () => {
  it('一覧を取り、ほかの PC を解除すると、その PC の client は RevokedError で断られる', async () => {
    const b = new HttpCloudClient({ url: workerUrl, token: await addPcDevice(cloud.env, 'pc-b'), spoolDir });
    expect((await client.listDevices()).map((d) => d.id).sort()).toEqual(['pc-a', 'pc-b']);
    expect((await client.revokeDevice('pc-b')).revokedAt).toBeGreaterThan(0);
    await expect(b.pullChanges(0, 10)).rejects.toBeInstanceOf(RevokedError);
    // 解除した側は今までどおり使える。
    expect((await client.pullChanges(0, 10)).changes).toEqual([]);
  });
});
