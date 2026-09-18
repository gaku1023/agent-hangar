import { Hono } from 'hono';
import { CLOUD_HEADERS, MAX_KEY_BYTES, PULL_LIMIT, decodeHeaderText, isSafeKeyId, isSafeRelPath, splitFileKey, type FileEntry, type FileKind, type ListFilesResponse } from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';

type FileRow = {
  seq: number;
  key: string;
  path: string;
  kind: FileKind;
  device_id: string;
  sha256: string;
  size: number;
  stored_size: number;
  mtime: number;
  encrypted: number;
  uploaded_at: number;
};

const toEntry = (r: FileRow): FileEntry => ({
  seq: r.seq,
  key: r.key,
  path: r.path,
  kind: r.kind,
  deviceId: r.device_id,
  sha256: r.sha256,
  size: r.size,
  storedSize: r.stored_size,
  mtime: r.mtime,
  encrypted: r.encrypted === 1,
  uploadedAt: r.uploaded_at,
});

// R2 の鍵の上限である。物差しは端末側と共有する（`packages/shared/src/cloud.ts`）。
// ここで独自の文字種の表を持つと、日本語や空白を含む `~/.claude` のファイルが
// 端末側では鍵を作れるのに Worker で 400 になる、という食い違いが起きる。
export { MAX_KEY_BYTES };

/**
 * 鍵の形と権限である。
 * `transcripts/<端末 ID>/...` は自端末の分だけ書けて消せる。
 * `config/...` はどの端末でも書ける（`~/.claude` は 1 つの持ち物なので端末で分けない）。
 * `GET` は形さえ合っていれば誰でもよい。他端末の本文を降ろすのが同期の目的だからである。
 */
export function validKey(key: string, deviceId: string, method: 'PUT' | 'GET' | 'DELETE'): boolean {
  const s = splitFileKey(key);
  if (!s) return false;
  if (method === 'GET' || s.prefix === 'config') return true;
  // 端末 ID にスラッシュが混ざっていると、他端末の接頭辞の下に潜り込める。
  // 参加のときの検査に頼らず、ここでも形を見る。
  if (!isSafeKeyId(deviceId)) return false;
  return s.rel.startsWith(`${deviceId}/`);
}

/** 権限を抜きにした形だけの検査である。形が違えば 400、形は合っていて権限が無ければ 403 に分ける。 */
const keyShapeOk = (key: string): boolean => validKey(key, '', 'GET');

const isSha = (s: string | undefined): s is string => !!s && /^[0-9a-f]{64}$/.test(s);

/** 見出しの数値である。空、符号、小数、桁あふれを断る。 */
function toInt(s: string | undefined): number | null {
  if (s === undefined || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * R2 に預ける 1 つの部分の大きさである。
 * R2 は最後以外の部分に 5 MiB の下限を課すので、それより大きく取る。
 */
const PART_BYTES = 8 * 1024 * 1024;

/** 1 本の本文の上限である。Workers 自体の上限より手前で断ち、記憶を食い潰されないようにする。 */
export const MAX_BODY_BYTES = 100 * 1024 * 1024;

const concat = (chunks: Uint8Array[], n: number): Uint8Array => {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

/**
 * 本文を R2 へ預け、預けた大きさを返す。上限を超えたら何も残さずに null を返す。
 *
 * 端末は本文を gzip して暗号化しながら流すので、送る前に大きさが分からない。
 * したがって要求は chunked で届き、`content-length` が無い。
 * R2 は長さの分からない読み取りの流れを受け取らないので、次の形にした。
 *
 * - 8 MiB に満たない本文は、そのまま 1 回の `put` で置く。
 * - それを超えたら multipart に切り替え、8 MiB ごとに部分を上げる。
 *
 * どちらでも記憶に載るのは高々 1 つの部分ぶんで、本文の全体を抱え込まない。
 * 途中で倒れたら multipart を畳むので、半端な本体が R2 に残らない。
 */
async function storeBody(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  customMetadata: Record<string, string>,
): Promise<number | null> {
  const reader = body.getReader();
  let mp: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          if (mp) await mp.abort().catch(() => {});
          return null;
        }
        held.push(value);
        heldBytes += value.byteLength;
      }
      if (done) break;
      if (heldBytes >= PART_BYTES) {
        mp ??= await bucket.createMultipartUpload(key, { customMetadata });
        parts.push(await mp.uploadPart(parts.length + 1, concat(held, heldBytes)));
        held = [];
        heldBytes = 0;
      }
    }
    if (!mp) {
      const obj = await bucket.put(key, concat(held, heldBytes), { customMetadata });
      return obj?.size ?? heldBytes;
    }
    if (heldBytes > 0) parts.push(await mp.uploadPart(parts.length + 1, concat(held, heldBytes)));
    return (await mp.complete(parts)).size;
  } catch (e) {
    if (mp) await mp.abort().catch(() => {});
    throw e;
  }
}

export const filesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 索引を連番の昇順で返す。自端末の分も返す（この端末が作り直したときの取り直しに要る）。 */
filesApp.get('/', async (c) => {
  const since = Math.max(Number(c.req.query('since') ?? 0) || 0, 0);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? PULL_LIMIT) || PULL_LIMIT, 1), PULL_LIMIT);
  const rows = await c.env.DB.prepare('select * from files where seq > ? order by seq limit ?')
    .bind(since, limit + 1)
    .all<FileRow>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const nextSeq = page.length ? page[page.length - 1]!.seq : since;
  const res: ListFilesResponse = { files: page.map(toEntry), nextSeq, more };
  return c.json(res);
});

/** 本文をそのまま R2 へ流し、索引を置き直す。中身は端末側で暗号化済みで、Worker は覗かない。 */
filesApp.put('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const device = c.get('device');
  if (!keyShapeOk(key)) return c.json({ error: 'invalid key' }, 400);
  if (!validKey(key, device.id, 'PUT')) return c.json({ error: 'forbidden' }, 403);
  const h = (name: string): string | undefined => c.req.header(name);
  // 見出しの値は ByteString しか運べないので、端末は `encodeHeaderText` で符号化して送る。
  // 復号は共有の関数で行う。片方だけ変えると、索引に百分率のままの文字列が黙って残る。
  const wirePath = h(CLOUD_HEADERS.path);
  const path = wirePath === undefined ? undefined : (decodeHeaderText(wirePath) ?? undefined);
  const kind = h(CLOUD_HEADERS.kind);
  const sha = h(CLOUD_HEADERS.sha256);
  const size = toInt(h(CLOUD_HEADERS.size));
  const mtime = toInt(h(CLOUD_HEADERS.mtime));
  const enc = h(CLOUD_HEADERS.encrypted);
  if (path === undefined || !isSafeRelPath(path)) return c.json({ error: 'invalid headers' }, 400);
  if (kind !== 'transcript' && kind !== 'config') return c.json({ error: 'invalid headers' }, 400);
  // 種別と接頭辞が食い違うと、索引の kind から鍵の置き場を当てにしている側が取り違える。
  if ((kind === 'config') !== key.startsWith('config/')) return c.json({ error: 'invalid headers' }, 400);
  if (!isSha(sha) || size === null || mtime === null || (enc !== '1' && enc !== '0')) return c.json({ error: 'invalid headers' }, 400);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: 'empty body' }, 400);
  // customMetadata の値も見出し由来なので、ここに秘密は入らない（path と sha と端末 ID だけ）。
  // customMetadata の値も見出しとして運ばれるので、符号化したままの形で置く。
  const storedSize = await storeBody(c.env.BUCKET, key, body, { path: wirePath!, sha256: sha, device: device.id });
  if (storedSize === null) return c.json({ error: 'too large' }, 413);
  const now = Date.now();
  const r = await c.env.DB.batch([
    c.env.DB.prepare('delete from files where key = ?').bind(key),
    c.env.DB
      .prepare('insert into files (key, path, kind, device_id, sha256, size, stored_size, mtime, encrypted, uploaded_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(key, path, kind, device.id, sha, size, storedSize, mtime, enc === '1' ? 1 : 0, now),
    c.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(now, device.id),
  ]);
  const seq = Number(r[1]!.meta.last_row_id);
  return c.json({ seq }, 201);
});

/** 本文を返す。どの端末の分でも降ろせる。中身は暗号化されたままで、鍵は端末しか持たない。 */
filesApp.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  if (!validKey(key, c.get('device').id, 'GET')) return c.json({ error: 'invalid key' }, 400);
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size), etag: obj.httpEtag },
  });
});

/** 本体と索引を消す。書ける端末だけが消せる。 */
filesApp.delete('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const device = c.get('device');
  if (!keyShapeOk(key)) return c.json({ error: 'invalid key' }, 400);
  if (!validKey(key, device.id, 'DELETE')) return c.json({ error: 'forbidden' }, 403);
  await c.env.BUCKET.delete(key);
  await c.env.DB.prepare('delete from files where key = ?').bind(key).run();
  return c.body(null, 204);
});
