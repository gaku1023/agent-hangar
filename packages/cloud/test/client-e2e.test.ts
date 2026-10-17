import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION, deriveEpochKeys, toBase64Url, transcriptBlobKey, type ChangeIn } from '@agent-hangar/shared';
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

describe('封じた本文（SealedCloudClient と Worker）', () => {
  it('流れてくる本文も長さを決めて送り、Worker は分けずに 1 回の put で置き、別の PC が開ける。D1 と R2 にパスとセッションの UUID は残らない', async () => {
    const keys = await deriveEpochKeys(1, toBase64Url(new Uint8Array(32).fill(3)));
    const ring = (): RowKeyring => ({ current: () => keys, at: (n) => (n === 1 ? keys : null) });
    const a = new SealedCloudClient(client, ring(), 'pc-a');
    const b = new SealedCloudClient(new HttpCloudClient({ url: workerUrl, token: await addPcDevice(cloud.env, 'pc-b'), spoolDir }), ring(), 'pc-b');
    // gzip で縮まない中身にして、暗号化した後も Worker の PART_BYTES（8 MiB）を超える大きさにする。
    const n = 9 * 1024 * 1024 + 7;
    const buf = randomBytes(n);
    const uuid = 'session-uuid-big-1';
    const rel = `projects/-w-project-x/${uuid}.jsonl`;
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const key = await transcriptBlobKey(keys.index, 'pc-a', 'pc-a', uuid, null);
    // 端末の uploader と同じく、長さの分からない流れで渡す。
    const pieces = (async function* () { for (let at = 0; at < n; at += 64 * 1024) yield buf.subarray(at, at + 64 * 1024); })();
    const { seq } = await a.putFile({ key, epoch: 1, kind: 'transcript', path: rel, sha256, size: n, mtime: 1, origin: 'pc-a' }, Readable.from(pieces));
    expect(seq).toBe(1);
    const head = await cloud.env.BUCKET.head(key);
    expect(head!.size).toBeGreaterThan(8 * 1024 * 1024);
    // multipart の etag は「-部分の数」で終わる。付いていなければ Worker は本文を JS で切り分けていない。
    expect(head!.etag).not.toContain('-');
    const [e] = (await b.listFiles(0, 100)).files;
    expect(e).toMatchObject({ key, epoch: 1, kind: 'transcript', path: rel, sha256, size: n, origin: 'pc-a', deviceId: 'pc-a', storedSize: head!.size });
    const back: Buffer[] = [];
    for await (const c of await b.getFile(key, 1)) back.push(c as Buffer);
    expect(Buffer.concat(back).equals(buf)).toBe(true);
    const stored = (await cloud.env.DB.prepare('select key, kind, device_id, size, epoch, sealed_meta from files').all()).results as Record<string, unknown>[];
    expect(stored).toHaveLength(1);
    const dump = stored.map((r) => Object.values(r).map((v) => (v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : Array.isArray(v) ? Buffer.from(v as number[]).toString('latin1') : String(v))).join('|')).join('\n');
    for (const plain of [uuid, 'project-x', 'projects', 'jsonl', sha256]) expect(dump).not.toContain(plain);
    expect((await cloud.env.BUCKET.list()).objects.map((o) => o.key)).toEqual([key]);
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
