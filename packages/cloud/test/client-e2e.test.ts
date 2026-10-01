import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpCloudClient } from '../../server/src/sync/client.ts';
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

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  const url = String(await cloud.mf.ready).replace(/\/+$/, '');
  const r = await fetch(`${url}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id: 'dev-a', name: 'dev-a', platform: 'darwin' } }),
  });
  const { deviceToken } = (await r.json()) as { deviceToken: string };
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-e2e-'));
  client = new HttpCloudClient({ url, token: deviceToken, spoolDir });
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
