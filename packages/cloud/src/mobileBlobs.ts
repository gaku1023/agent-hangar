import { Hono } from 'hono';
import { MOBILE_IMAGE_MAX_BYTES, MOBILE_IMAGES_PER_LAUNCH, MOBILE_IMAGES_PER_PHONE, isSafeKeyId } from '@agent-hangar/shared';
import { authMiddleware, requireKind } from './auth.ts';
import type { Env, Vars } from './env.ts';

/**
 * スマホの画像の置き場（互換の版 8）。mobile.ts が `/m/blobs` に載せる。
 *
 * 画像はスマホが封をしたバイト列のまま R2 の `mobile/<スマホの ID>/<依頼の ID>/<番号>` に置く。Worker は中身を読まない。
 * 今の `files` の口（validKey）は変えない。`mobile/` の鍵はその口からは読めも書けもしない。
 * スマホのトークンで触れるのは、自分の ID の下に置くことだけである。
 * PC のトークンで触れるのは、自分宛てで、受け取った（claimed）依頼の画像を読むことだけである。鍵は依頼の行の `from_device` から組む。
 *
 * 消す時期は 3 つ。
 * PC が答えを返したとき（started でも failed でも）に、その依頼の画像を消す（deleteLaunchImages）。
 * 答えが来ないままの画像は、スマホが画像を置くときと依頼を出すときに、そのスマホの下の 24 時間より古いものを消す（sweepImages）。cron は足さない。
 * 解除したスマホの画像は、孤児の掃除（sweep.ts の sweepBodies）が 24 時間より古いものを消す。
 */

/** 依頼の ID の文字数の上限。スマホは UUID（36 字）を振る。 */
export const MAX_LAUNCH_ID_CHARS = 64;
/** 封（AES-GCM の nonce 12 バイトと tag 16 バイト）の分。 */
export const SEAL_OVERHEAD_BYTES = 28;
/** 置く本文の上限。画像 1 枚の上限に封の分を足したもの。 */
export const MAX_BLOB_BYTES = MOBILE_IMAGE_MAX_BYTES + SEAL_OVERHEAD_BYTES;
/** 置いたままの画像を残す時間。 */
export const IMAGE_KEEP_MS = 24 * 60 * 60_000;

const phonePrefix = (phoneId: string) => `mobile/${phoneId}/`;
const launchPrefix = (phoneId: string, launchId: string) => `mobile/${phoneId}/${launchId}/`;

/** 依頼の ID の形。R2 の鍵に入るので、スラッシュと `..` と先頭のドットを通さない（isSafeKeyId）。 */
export const isBlobLaunchId = (id: string): boolean => id.length <= MAX_LAUNCH_ID_CHARS && isSafeKeyId(id);

/** 番号は 0 から MOBILE_IMAGES_PER_LAUNCH 未満の整数（先頭のゼロなし）。 */
const parseIndex = (s: string): number | null => {
  if (!/^(0|[1-9]\d*)$/.test(s)) return null;
  const n = Number(s);
  return n < MOBILE_IMAGES_PER_LAUNCH ? n : null;
};

/** 接頭辞の下の鍵を全部挙げる（uploaded つき）。 */
async function listAll(bucket: R2Bucket, prefix: string): Promise<{ key: string; uploaded: number }[]> {
  const out: { key: string; uploaded: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const o of page.objects) out.push({ key: o.key, uploaded: o.uploaded.getTime() });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function removeKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

/** そのスマホの下で、24 時間より古い画像を消し、残った鍵を返す。 */
export async function sweepImages(bucket: R2Bucket, phoneId: string, now: number): Promise<{ deleted: number; kept: string[] }> {
  const all = await listAll(bucket, phonePrefix(phoneId));
  const old = all.filter((o) => o.uploaded <= now - IMAGE_KEEP_MS).map((o) => o.key);
  await removeKeys(bucket, old);
  const oldSet = new Set(old);
  return { deleted: old.length, kept: all.map((o) => o.key).filter((k) => !oldSet.has(k)) };
}

/** 消した枚数だけを返す（試験と、数えなくてよい呼び手のため）。 */
export async function sweepOldImages(bucket: R2Bucket, phoneId: string, now: number): Promise<number> {
  return (await sweepImages(bucket, phoneId, now)).deleted;
}

/** 1 件の依頼の画像を全部消す。 */
export async function deleteLaunchImages(bucket: R2Bucket, phoneId: string, launchId: string): Promise<void> {
  if (!isBlobLaunchId(launchId)) return;
  await removeKeys(bucket, (await listAll(bucket, launchPrefix(phoneId, launchId))).map((o) => o.key));
}

export const blobsApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * スマホが封をした画像を置く。本文は封をしたバイト列そのまま（application/octet-stream）。
 * 長さを名乗らない本文は 411、上限（MAX_BLOB_BYTES）を超える名乗りは本文を読まずに 413 で断る。
 * 置いたままの画像が MOBILE_IMAGES_PER_PHONE 枚に達していたら、新しい鍵は 429 で断る（同じ鍵の置き直しは通る）。
 * 数える前に 24 時間より古いものを消すので、置きっぱなしの分で詰まらない。
 */
blobsApp.put('/:id/:n', authMiddleware(), requireKind('mobile'), async (c) => {
  const id = c.req.param('id');
  const n = parseIndex(c.req.param('n'));
  if (!isBlobLaunchId(id) || n === null) return c.json({ error: 'invalid key' }, 400);
  const declaredText = c.req.header('content-length');
  if (declaredText === undefined || !/^\d+$/.test(declaredText)) return c.json({ error: 'length required' }, 411);
  const declared = Number(declaredText);
  if (declared > MAX_BLOB_BYTES) return c.json({ error: 'payload too large', limit: MAX_BLOB_BYTES }, 413);
  const body = c.req.raw.body;
  if (declared === 0 || !body) return c.json({ error: 'empty body' }, 400);
  const phoneId = c.get('device').id;
  const key = `${launchPrefix(phoneId, id)}${n}`;
  const { kept } = await sweepImages(c.env.BUCKET, phoneId, Date.now());
  if (kept.length >= MOBILE_IMAGES_PER_PHONE && !kept.includes(key)) return c.json({ error: 'too many images' }, 429);
  await c.env.BUCKET.put(key, body);
  return c.json({ ok: true }, 201);
});

/**
 * 宛先の PC が画像を読む。
 * 依頼の行が自分宛て（target_device が自分）で、受け取った（claimed）ときだけ読め、鍵は行の from_device から組む。
 * それ以外（ほかの PC、受け取る前、答えた後、無い依頼）は 404 である。スマホのトークンは 403。
 */
blobsApp.get('/:id/:n', authMiddleware(), requireKind('pc'), async (c) => {
  const id = c.req.param('id');
  const n = parseIndex(c.req.param('n'));
  if (!isBlobLaunchId(id) || n === null) return c.json({ error: 'invalid key' }, 400);
  const row = await c.env.DB.prepare("select from_device from launch_requests where id = ? and target_device = ? and status = 'claimed'").bind(id, c.get('device').id).first<{ from_device: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const obj = await c.env.BUCKET.get(`${launchPrefix(row.from_device, id)}${n}`);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size) } });
});
