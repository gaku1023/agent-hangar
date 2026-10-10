import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';
import { CompatError, HttpCloudClient } from '../../server/src/sync/client.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

/**
 * 端末の本物の client（packages/server の HttpCloudClient）と、本物の Worker（workerd）を HTTP で繋ぐ。
 * 偽物どうしでは、端末が長さを送るか、Worker がそれを R2 にそのまま渡すかを確かめられない。
 */

const SECRET = 'join-secret-e2e';

let cloud: CloudHarness;
let client: HttpCloudClient;
let spoolDir = '';
let workerUrl = '';
let token = '';

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  workerUrl = String(await cloud.mf.ready).replace(/\/+$/, '');
  // 参加も版を載せる。本番の下限は 1 なので、載せない参加は 426 で断られる。
  const r = await fetch(`${workerUrl}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [COMPAT_HEADER]: String(COMPAT_VERSION) },
    body: JSON.stringify({ secret: SECRET, device: { id: 'dev-a', name: 'dev-a', platform: 'darwin' } }),
  });
  token = ((await r.json()) as { deviceToken: string }).deviceToken;
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-e2e-'));
  client = new HttpCloudClient({ url: workerUrl, token, spoolDir });
});

afterEach(async () => {
  await cloud.dispose();
  fs.rmSync(spoolDir, { recursive: true, force: true });
});

describe('HttpCloudClient と Worker', () => {
  it('流れてくる本文も長さを決めて送り、Worker は分けずに 1 回の put で置く', async () => {
    const n = 9 * 1024 * 1024 + 7; // Worker の PART_BYTES（8 MiB）を超える大きさ
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = i % 251;
    const key = 'transcripts/dev-a/big.jsonl.gz';
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
      await ensureSchema({ ...strictCloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
      const url = String(await strictCloud.mf.ready).replace(/\/+$/, '');
      // 参加は、下限と同じ版を名乗る新しい端末のふりをして通す。
      const r = await fetch(`${url}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [COMPAT_HEADER]: String(floor) },
        body: JSON.stringify({ secret: SECRET, device: { id: 'dev-b', name: 'dev-b', platform: 'darwin' } }),
      });
      expect(r.status).toBe(201);
      const { deviceToken } = (await r.json()) as { deviceToken: string };
      const older = new HttpCloudClient({ url, token: deviceToken, spoolDir });
      const e = await older.pullChanges(0, 10).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CompatError);
      expect(e).toMatchObject({ upgrade: 'device', have: COMPAT_VERSION, need: floor });
    } finally {
      await strictCloud.dispose();
    }
  });
});
