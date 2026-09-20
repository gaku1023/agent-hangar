import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOUD_HEADERS } from '@agent-hangar/shared';
import { d1RowsToday } from '../src/meter.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { META_SWEEP_AT, SWEEP_EVERY_MS, SWEEP_GRACE_MS, SWEEP_LIST_LIMIT, sweepIfDue, sweepOnce } from '../src/sweep.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-1';
const HOUR = 3_600_000;

let cloud: CloudHarness;
let tok = '';

const join = async (id: string): Promise<string> => {
  const r = await cloud.SELF.fetch('https://x/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }),
  });
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

const put = (key: string, body: string, over: Record<string, string> = {}): Promise<Response> =>
  cloud.SELF.fetch(`https://x/files/${key}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${tok}`,
      [CLOUD_HEADERS.path]: 'projects/-x/u1.jsonl',
      [CLOUD_HEADERS.kind]: 'transcript',
      [CLOUD_HEADERS.sha256]: 'a'.repeat(64),
      [CLOUD_HEADERS.size]: String(body.length),
      [CLOUD_HEADERS.mtime]: '1700000000000',
      [CLOUD_HEADERS.encrypted]: '1',
      ...over,
    },
    body,
  });

/**
 * 索引の鍵を D1 から直に読む。
 * `GET /files` で読むと、その要求が掃除を始めてしまい、明に呼んだ掃除と競う。
 * 経路から始まることは「GET /files が掃除を始める」で別に確かめる。
 */
const indexKeys = async (): Promise<string[]> =>
  (await cloud.env.DB.prepare('select key from files order by key').all<{ key: string }>()).results.map((r) => r.key);

const bucketKeys = async (): Promise<string[]> => (await cloud.env.BUCKET.list({ limit: 1000 })).objects.map((o) => o.key);

/** 索引に無い本体を R2 に置く。PUT の途中で倒れた後（R2 は書けて D1 が書けなかった）の姿である。 */
const orphanBody = async (key: string): Promise<void> => { await cloud.env.BUCKET.put(key, 'gomi'); };

/** 本体の無い索引を D1 に置く。R2 だけ先に消えた後の姿である。 */
const orphanIndex = async (key: string, uploadedAt: number): Promise<void> => {
  await cloud.env.DB.prepare(
    'insert into files (key, path, kind, device_id, sha256, size, stored_size, mtime, encrypted, uploaded_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(key, 'projects/-x/gone.jsonl', 'transcript', 'a', 'b'.repeat(64), 4, 4, 1, 1, uploadedAt)
    .run();
};

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud({ JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  await ensureSchema(cloud.env);
  tok = await join('a');
});

afterEach(async () => { await cloud.dispose(); resetSchemaCache(); });

describe('孤児の掃除', () => {
  it('索引に無い本体を消し、索引にある本体は残す', async () => {
    expect((await put('transcripts/a/live.jsonl.gz', 'honbun')).status).toBe(201);
    await orphanBody('transcripts/a/orphan.jsonl.gz');
    expect((await bucketKeys()).sort()).toEqual(['transcripts/a/live.jsonl.gz', 'transcripts/a/orphan.jsonl.gz']);

    const r = await sweepOnce(cloud.env, Date.now() + 2 * HOUR);
    expect(r.bodies).toEqual(['transcripts/a/orphan.jsonl.gz']);
    expect(await bucketKeys()).toEqual(['transcripts/a/live.jsonl.gz']);
    // 索引は 1 件も減らない。
    expect(await indexKeys()).toEqual(['transcripts/a/live.jsonl.gz']);
  });

  it('置いたばかりの本体には触らない（書いている最中の 1 本を消さない）', async () => {
    await orphanBody('transcripts/a/justnow.jsonl.gz');
    // 猶予の中なので、索引に無くてもまだ孤児とは決めつけない。
    const r = await sweepOnce(cloud.env, Date.now() + SWEEP_GRACE_MS / 2);
    expect(r.bodies).toEqual([]);
    expect(await bucketKeys()).toEqual(['transcripts/a/justnow.jsonl.gz']);
  });

  it('本体の無い索引を消す（降ろす側が永久に 404 を踏み続けない）', async () => {
    const now = Date.now();
    await orphanIndex('transcripts/a/gone.jsonl.gz', now - 2 * HOUR);
    expect((await put('transcripts/a/live.jsonl.gz', 'honbun')).status).toBe(201);
    expect((await indexKeys()).sort()).toEqual(['transcripts/a/gone.jsonl.gz', 'transcripts/a/live.jsonl.gz']);

    const r = await sweepOnce(cloud.env, now + 2 * HOUR);
    expect(r.entries).toEqual(['transcripts/a/gone.jsonl.gz']);
    expect(await indexKeys()).toEqual(['transcripts/a/live.jsonl.gz']);
    expect(await bucketKeys()).toEqual(['transcripts/a/live.jsonl.gz']);
  });

  it('置いたばかりの索引には触らない', async () => {
    const now = Date.now();
    await orphanIndex('transcripts/a/writing.jsonl.gz', now);
    const r = await sweepOnce(cloud.env, now + SWEEP_GRACE_MS / 2);
    expect(r.entries).toEqual([]);
    expect(await indexKeys()).toEqual(['transcripts/a/writing.jsonl.gz']);
  });

  it('1 回に見る数を区切り、続きは次の回から読む', async () => {
    const now = Date.now();
    for (let i = 0; i < SWEEP_LIST_LIMIT + 3; i++) await orphanBody(`transcripts/a/o${String(i).padStart(3, '0')}.gz`);
    const first = await sweepOnce(cloud.env, now + 2 * HOUR);
    expect(first.bodies).toHaveLength(SWEEP_LIST_LIMIT);
    expect(await bucketKeys()).toHaveLength(3);
    const second = await sweepOnce(cloud.env, now + 3 * HOUR);
    expect(second.bodies).toHaveLength(3);
    expect(await bucketKeys()).toEqual([]);
  });
});

describe('掃除の回し方', () => {
  it('間隔が空くまでは走らない', async () => {
    const now = Date.now();
    await orphanBody('transcripts/a/orphan.jsonl.gz');
    expect(await sweepIfDue(cloud.env, now + 2 * HOUR)).not.toBeNull();
    // すぐもう一度呼んでも走らない。重なった要求どうしでも、走るのは 1 本だけである。
    await orphanBody('transcripts/a/orphan2.jsonl.gz');
    expect(await sweepIfDue(cloud.env, now + 2 * HOUR)).toBeNull();
    expect(await bucketKeys()).toEqual(['transcripts/a/orphan2.jsonl.gz']);
    // 間隔が空けば、また走る。
    expect(await sweepIfDue(cloud.env, now + 2 * HOUR + SWEEP_EVERY_MS)).not.toBeNull();
    expect(await bucketKeys()).toEqual([]);
  });

  it('GET /files が掃除を始める（応答は待たせない）', async () => {
    const before = await cloud.env.DB.prepare('select value from meta where key = ?').bind(META_SWEEP_AT).first();
    expect(before).toBeNull();
    const res = await cloud.SELF.fetch('https://x/files?since=0', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    // 応答を待たせずに始めるので、終わるのは応答の後である。掃除の跡が付くまで少しだけ待つ。
    let value: string | undefined;
    for (let i = 0; i < 50 && value === undefined; i++) {
      value = (await cloud.env.DB.prepare('select value from meta where key = ?').bind(META_SWEEP_AT).first<{ value: string }>())?.value;
      if (value === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    expect(Number(value)).toBeGreaterThan(0);
  });

  it('掃除そのものが無料枠をほとんど使わない', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) await orphanBody(`transcripts/a/o${i}.gz`);
    await orphanIndex('transcripts/a/gone.gz', now - 2 * HOUR);
    const before = await d1RowsToday(cloud.env.DB, now);
    await sweepIfDue(cloud.env, now + 2 * HOUR);
    const spent = (await d1RowsToday(cloud.env.DB, now)) - before;
    // 1 回の掃除で D1 に書く行数。走るのは 1 日に 4 回なので、1 日 10 万行の枠の 0.1% にも遠い。
    expect(spent).toBeLessThanOrEqual(16);
    expect((86_400_000 / SWEEP_EVERY_MS) * spent).toBeLessThan(100);
  });
});
