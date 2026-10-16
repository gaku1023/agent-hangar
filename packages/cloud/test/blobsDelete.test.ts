import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOB_DELETE_DAILY, BLOB_DELETE_GRACE_MS, CLOUD_HEADERS, MAX_BLOB_DELETE_KEYS, type BlobsDeleteOut } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { addPcDevice, startCloud, type CloudHarness } from './harness.ts';

/**
 * PC が決めた本文の削除（`DELETE /blobs`、互換の版 9）。
 * ゴミ箱の 30 日の判定は PC が行い、Worker は「自分の下だけ」「置いて 1 時間は消さない」「1 日 500 件まで」だけを守る。
 */

let cloud: CloudHarness;
let tokA = '';
let tokB = '';

const blobKey = (device: string, name: string): string => `b/${device}/${`h${name}`.padEnd(43, '_')}`;
const KA = (name: string): string => blobKey('dev-a', name);
const KB = (name: string): string => blobKey('dev-b', name);

const put = (tok: string, key: string, body = 'abc'): Promise<Response> =>
  cloud.SELF.fetch(`https://x/files/${key}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${tok}`,
      'content-length': String(body.length),
      [CLOUD_HEADERS.kind]: 'transcript',
      [CLOUD_HEADERS.size]: String(body.length),
      [CLOUD_HEADERS.epoch]: '1',
      [CLOUD_HEADERS.meta]: 'bWV0YQ',
    },
    body,
  });

const del = (tok: string, body: unknown): Promise<Response> =>
  cloud.SELF.fetch('https://x/blobs', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const deleted = async (tok: string, keys: string[]): Promise<BlobsDeleteOut> => {
  const r = await del(tok, { keys });
  expect(r.status).toBe(200);
  return (await r.json()) as BlobsDeleteOut;
};

/** 索引の行を、置いてから 1 時間を過ぎた形にする。 */
const ageAll = (): Promise<unknown> => cloud.env.DB.prepare('update files set uploaded_at = uploaded_at - ?').bind(BLOB_DELETE_GRACE_MS + 60_000).run();

const indexKeys = async (): Promise<string[]> => (await cloud.env.DB.prepare('select key from files order by key').all<{ key: string }>()).results.map((r) => r.key);
const r2Keys = async (): Promise<string[]> => (await cloud.env.BUCKET.list({ limit: 1000 })).objects.map((o) => o.key).sort();

/** 索引と R2 に、1 時間を過ぎた本文を n 本、直に置く（PUT を n 回通すと遅いので）。 */
const seedOld = async (device: string, n: number, prefix = 'o'): Promise<string[]> => {
  const keys = Array.from({ length: n }, (_, i) => blobKey(device, `${prefix}${i}`));
  const at = Date.now() - BLOB_DELETE_GRACE_MS - 60_000;
  for (let i = 0; i < keys.length; i += 50) {
    const part = keys.slice(i, i + 50);
    await cloud.env.DB.batch(
      part.map((k) => cloud.env.DB.prepare("insert into files (key, kind, device_id, size, stored_size, uploaded_at, epoch, sealed_meta) values (?, 'transcript', ?, 1, 1, ?, 1, 'bQ')").bind(k, device, at)),
    );
    for (const k of part) await cloud.env.BUCKET.put(k, 'x');
  }
  return keys;
};

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  tokA = await addPcDevice(cloud.env, 'dev-a');
  tokB = await addPcDevice(cloud.env, 'dev-b');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('DELETE /blobs', () => {
  it('自分の下の、置いて 1 時間を過ぎた本文を R2 と索引から消す', async () => {
    await put(tokA, KA('u1'));
    await put(tokA, KA('u2'));
    await ageAll();
    expect(await deleted(tokA, [KA('u1')])).toEqual({ deleted: [KA('u1')], refused: [] });
    expect(await indexKeys()).toEqual([KA('u2')]);
    expect(await r2Keys()).toEqual([KA('u2')]);
  });

  it('置いて 1 時間以内のものは refused で、消さない', async () => {
    await put(tokA, KA('old'));
    await ageAll();
    await put(tokA, KA('new'));
    expect(await deleted(tokA, [KA('old'), KA('new')])).toEqual({ deleted: [KA('old')], refused: [KA('new')] });
    expect(await indexKeys()).toEqual([KA('new')]);
    expect(await r2Keys()).toEqual([KA('new')]);
  });

  it('他人の下の鍵は refused で、消さない', async () => {
    await put(tokB, KB('u1'));
    await ageAll();
    expect(await deleted(tokA, [KB('u1')])).toEqual({ deleted: [], refused: [KB('u1')] });
    expect(await indexKeys()).toEqual([KB('u1')]);
    expect(await r2Keys()).toEqual([KB('u1')]);
  });

  it('索引に無い自分の鍵は消えたものとして deleted に入れ、R2 には触らない', async () => {
    // 索引に無い本体は PUT の途中かもしれないので、R2 の孤児は掃除（sweepBodies）に任せる。
    await cloud.env.BUCKET.put(KA('orphan'), 'x');
    expect(await deleted(tokA, [KA('orphan'), KA('nothing')])).toEqual({ deleted: [KA('orphan'), KA('nothing')], refused: [] });
    expect(await r2Keys()).toEqual([KA('orphan')]);
  });

  it('同じ鍵が重なっても 1 回だけ数える', async () => {
    await put(tokA, KA('u1'));
    await ageAll();
    expect(await deleted(tokA, [KA('u1'), KA('u1')])).toEqual({ deleted: [KA('u1')], refused: [] });
  });

  it('形の違う本文、b/ の形でない鍵、51 件以上は 400 で、何も消さない', async () => {
    await put(tokA, KA('u1'));
    await ageAll();
    for (const body of [
      null,
      {},
      { keys: 'x' },
      { keys: [] },
      { keys: [KA('u1'), 'transcripts/dev-a/u1.jsonl.gz'] },
      { keys: [KA('u1'), 3] },
      { keys: Array.from({ length: MAX_BLOB_DELETE_KEYS + 1 }, (_, i) => KA(`k${i}`)) },
    ])
      expect([JSON.stringify(body).slice(0, 40), (await del(tokA, body)).status]).toEqual([JSON.stringify(body).slice(0, 40), 400]);
    expect(await indexKeys()).toEqual([KA('u1')]);
  });

  it('1 日 500 件までで、501 件目は 429。ほかの端末は数えが別', async () => {
    const keys = await seedOld('dev-a', BLOB_DELETE_DAILY + 1);
    for (let i = 0; i < BLOB_DELETE_DAILY; i += MAX_BLOB_DELETE_KEYS) {
      const part = keys.slice(i, i + MAX_BLOB_DELETE_KEYS);
      expect((await deleted(tokA, part)).deleted).toHaveLength(part.length);
    }
    const last = keys[BLOB_DELETE_DAILY]!;
    const r = await del(tokA, { keys: [last] });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: 'too many deletes', limit: BLOB_DELETE_DAILY });
    expect(await indexKeys()).toEqual([last]);
    // 数えは端末ごとなので、ほかの端末は消せる。
    const [b] = await seedOld('dev-b', 1);
    expect(await deleted(tokB, [b!])).toEqual({ deleted: [b], refused: [] });
    // 日が変われば戻る（meta の日付を前の日にして確かめる）。
    await cloud.env.DB.prepare("update meta set value = json_set(value, '$.day', '2000-01-01') where key = ?").bind('blob_delete:dev-a').run();
    expect(await deleted(tokA, [last])).toEqual({ deleted: [last], refused: [] });
  });

  it('残りが足りなければ、残りの分だけ消し、あふれた分は refused', async () => {
    const keys = await seedOld('dev-a', BLOB_DELETE_DAILY + 10);
    for (let i = 0; i < BLOB_DELETE_DAILY - 5; i += MAX_BLOB_DELETE_KEYS) {
      const part = keys.slice(i, Math.min(i + MAX_BLOB_DELETE_KEYS, BLOB_DELETE_DAILY - 5));
      await deleted(tokA, part);
    }
    const rest = keys.slice(BLOB_DELETE_DAILY - 5, BLOB_DELETE_DAILY + 5);
    const out = await deleted(tokA, rest);
    expect(out.deleted).toEqual(rest.slice(0, 5));
    expect(out.refused).toEqual(rest.slice(5));
    expect((await del(tokA, { keys: [keys[BLOB_DELETE_DAILY + 9]!] })).status).toBe(429);
  });

  it('スマホのトークンでは使えない（403）', async () => {
    const phone = 'token-phone-1-0123456789abcdef';
    await cloud.env.DB.prepare("insert into devices (id, kind, token_hash, joined_at) values ('phone-1', 'mobile', ?, 1)")
      .bind(await sha256Hex(phone))
      .run();
    expect((await del(phone, { keys: [blobKey('phone-1', 'u1')] })).status).toBe(403);
  });
});
