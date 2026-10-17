import { Hono } from 'hono';
import {
  BLOB_DELETE_DAILY,
  BLOB_DELETE_GRACE_MS,
  CLOUD_HEADERS,
  MAX_BLOB_DELETE_KEYS,
  MAX_SEALED_META_CHARS,
  PULL_LIMIT,
  isBlobKey,
  isSafeKeyId,
  type BlobsDeleteOut,
  type FileKind,
  type SealedFileEntry,
  type SealedListFilesResponse,
} from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';
import { touchIfDue } from './seen.ts';
import { sweepIfDue } from './sweep.ts';
import { blobToSealed, isSealedText, sealedToBlob } from './util.ts';

type FileRow = {
  seq: number;
  key: string;
  kind: FileKind;
  device_id: string;
  size: number;
  stored_size: number;
  uploaded_at: number;
  epoch: number;
  sealed_meta: unknown;
};

const FILE_COLS = 'seq, key, kind, device_id, size, stored_size, uploaded_at, epoch, sealed_meta';

const toEntry = (r: FileRow): SealedFileEntry => ({
  seq: r.seq,
  key: r.key,
  kind: r.kind,
  deviceId: r.device_id,
  size: r.size,
  storedSize: r.stored_size,
  uploadedAt: r.uploaded_at,
  epoch: r.epoch,
  sealedMeta: blobToSealed(r.sealed_meta),
});

/** 自端末の下の鍵の頭。端末 ID の形が違えば null で、どの鍵にも書かせない。 */
const ownPrefix = (deviceId: string): string | null => (isSafeKeyId(deviceId) ? `b/${deviceId}/` : null);

/**
 * 鍵の形と権限である（互換の版 9）。
 * 鍵は `b/<端末 ID>/<HMAC の base64url>`（shared の e2e/names.ts）だけを受け、パスを平文で持つ鍵名は受けない。
 * 書けるのは自端末の下（`b/<自分>/`）だけである。
 * `GET` は形さえ合っていれば誰でもよい。他端末の本文と設定を降ろすのが同期の目的だからである。
 * 前方一致は末尾の `/` まで見るので、`dev-a` が `dev-ab` の下に書くことはできない。
 */
export function validKey(key: string, deviceId: string, method: 'PUT' | 'GET'): boolean {
  if (!isBlobKey(key)) return false;
  if (method === 'GET') return true;
  // 端末 ID にスラッシュが混ざっていると、他端末の接頭辞の下に潜り込める。
  // 参加のときの検査に頼らず、ここでも形を見る。
  const own = ownPrefix(deviceId);
  return own !== null && key.startsWith(own);
}

/** 見出しの数値である。空、符号、小数、桁あふれを断る。 */
function toInt(s: string | undefined): number | null {
  if (s === undefined || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** 1 本の本文の上限である。Workers 自体の上限より手前で断ち、記憶を食い潰されないようにする。 */
export const MAX_BODY_BYTES = 100 * 1024 * 1024;

export const filesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * 索引の読み位置である。
 *
 * 数えられない値（桁あふれ、`Infinity`、負、小数、でたらめな文字列）はすべて 0 として読む。
 * 0 は「全部やり直す」であって、取りこぼす側には倒れない。
 * そのまま束縛に渡すと、D1 が受けない値で 500 になる筋も残る。
 */
function toSince(v: string | undefined): number {
  if (v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** 索引の末尾の連番。1 件も無ければ 0 である。 */
const maxFileSeq = async (db: D1Database): Promise<number> =>
  (await db.prepare('select ifnull(max(seq), 0) s from files').first<{ s: number }>())!.s;

/** 索引を連番の昇順で返す。自端末の分も返す（この端末が作り直したときの取り直しに要る）。 */
filesApp.get('/', async (c) => {
  // 孤児の掃除はここから始める。応答は待たせない（waitUntil に逃がす）。
  // 端末が pull のたびに叩く経路なので、6 時間に 1 回という間隔を当てにできる相手がここしかいない。
  // executionCtx を持たない土台（テストの一部）では黙って見送る。掃除は次の回で拾える。
  try {
    c.executionCtx.waitUntil(sweepIfDue(c.env, Date.now()).catch((e: unknown) => { console.error('sweep failed', e instanceof Error ? e.name : typeof e); }));
  } catch {
    // executionCtx が無いだけなので、一覧そのものは続ける。
  }
  const since = toSince(c.req.query('since'));
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? PULL_LIMIT) || PULL_LIMIT, 1), PULL_LIMIT);
  // 末尾の連番は一覧より **先に** 読む。
  // 後で読むと、2 つの問い合わせの間に他端末が上げた 1 件が、返らないまま読み位置の後ろに入る。
  // 端末は読み位置を進める側にしか動かない（puller.ts の `Math.max`）ので、その 1 件は二度と読まれない。
  // 先に読めば、末尾は必ず実際以下になり、同じ索引をもう一度読む側にしか倒れない。
  const end = await maxFileSeq(c.env.DB);
  const rows = await c.env.DB.prepare(`select ${FILE_COLS} from files where seq > ? order by seq limit ?`)
    .bind(since, limit + 1)
    .all<FileRow>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  // 端末が送ってきた `since` を返さない。`/changes`（changes.ts の `GET /`）と同じ形である。
  // 返すと、一度でも壊れた `since` を控えた端末の一覧が、その値のまま固まって永久に空になる。
  const nextSeq = more ? page[page.length - 1]!.seq : Math.max(end, page.length ? page[page.length - 1]!.seq : 0);
  const res: SealedListFilesResponse = { files: page.map(toEntry), nextSeq, more };
  return c.json(res);
});

/**
 * 本文をそのまま R2 へ流し、索引を置き直す（互換の版 9）。
 * 中身は端末側で暗号化済みで、Worker は覗かない。
 * パス、平文の SHA-256、mtime、元の PC は、端末が封じたメタ（`x-hangar-meta`）の中にあり、Worker は開けない。
 * R2 の覚え書き（customMetadata）には何も付けない。
 */
filesApp.put('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const device = c.get('device');
  if (!isBlobKey(key)) return c.json({ error: 'invalid key' }, 400);
  if (!validKey(key, device.id, 'PUT')) return c.json({ error: 'forbidden' }, 403);
  const h = (name: string): string | undefined => c.req.header(name);
  const kind = h(CLOUD_HEADERS.kind);
  const size = toInt(h(CLOUD_HEADERS.size));
  const epoch = toInt(h(CLOUD_HEADERS.epoch));
  const sealedMeta = h(CLOUD_HEADERS.meta);
  if (kind !== 'transcript' && kind !== 'config') return c.json({ error: 'invalid headers' }, 400);
  if (size === null || epoch === null || epoch < 1 || !isSealedText(sealedMeta, MAX_SEALED_META_CHARS)) return c.json({ error: 'invalid headers' }, 400);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: 'empty body' }, 400);
  // 長さを名乗らない本文は受けない。
  // 長さの分かっている本文は、読まずにそのまま R2 へ渡せるので、workerd が JS を通さずに流し、CPU の時間が本文の大きさに比例しない。
  // 長さを名乗らずに本文を流していたのは互換の版 1 より前の端末で、それは版の関所（compat.ts）で断られている。
  const declared = toInt(h('content-length'));
  if (declared === null) return c.json({ error: 'length required' }, 411);
  if (declared > MAX_BODY_BYTES) return c.json({ error: 'too large' }, 413);
  const obj = await c.env.BUCKET.put(key, body);
  const storedSize = obj?.size ?? declared;
  const now = Date.now();
  const touch = touchIfDue(c.env.DB, device, now);
  const r = await c.env.DB.batch([
    c.env.DB.prepare('delete from files where key = ?').bind(key),
    c.env.DB
      .prepare('insert into files (key, kind, device_id, size, stored_size, uploaded_at, epoch, sealed_meta) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(key, kind, device.id, size, storedSize, now, epoch, sealedToBlob(sealedMeta)),
    ...(touch ? [touch] : []),
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

/** 1 日の削除の数えを置く meta の鍵の頭。後ろに端末 ID を付ける。値は `{"day":"YYYY-MM-DD","n":数}` の JSON である。 */
export const META_BLOB_DELETE = 'blob_delete:';

export const blobsApp = new Hono<{ Bindings: Env; Variables: Vars }>();

type CountRow = { value: string };

/** meta の数えの値から、今日の分の数を読む。日が違えば 0 である。 */
function countOf(row: CountRow | undefined, day: string): number {
  if (!row) return 0;
  try {
    const v = JSON.parse(row.value) as { day?: unknown; n?: unknown };
    return v.day === day && typeof v.n === 'number' ? v.n : 0;
  } catch {
    return 0;
  }
}

/**
 * PC が決めた本文の削除（互換の版 9）。
 *
 * ゴミ箱の 30 日の判定は PC が手元の DB で行い、消す鍵だけを渡す（設計書「掃除」）。
 * Worker は中身を読めないので、守るのは次の 3 つだけである。
 *
 * - 自端末の下（`b/<自分>/`）の鍵だけを消す。ほかの端末の下の鍵は `refused` に入れる。
 * - 置いてから 1 時間たっていないものは消さない（`refused`）。置き直したばかりの 1 本を消さないためである。
 * - 端末ごとに 1 日（UTC）500 件まで。数えは meta の 1 行に日付と数で持つ。残りが 0 なら 429、足りなければ残りの分だけ消して、あふれた分は `refused` に入れる。
 *
 * 索引に無い自分の鍵は、消えたものとして `deleted` に入れ、R2 には触らない。
 * 索引に無い本文は PUT の途中かもしれないので、R2 の孤児は掃除（sweep.ts の `sweepBodies`）に任せる。
 *
 * 数えの取り分は 1 つの batch（1 つの取引）で、前の値の読み、upsert、後の値の読みを流して決める。
 * 同時の 2 本でも、取り分の合計は残りを超えない。
 * R2 を先に消し、索引は後で消す。索引の文には猶予の条件を付け、その間に置き直された行は消さない。
 *
 * 読みは、索引の一意の索引で鍵を引く 1 文（50 行まで）と、meta の主キーの 2 行である。
 */
blobsApp.delete('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { keys?: unknown } | null;
  const keys = body?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_BLOB_DELETE_KEYS || !keys.every((k) => typeof k === 'string' && isBlobKey(k))) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  const cutoff = now - BLOB_DELETE_GRACE_MS;
  const own = ownPrefix(device.id);
  const unique = [...new Set(keys as string[])];
  const refused: string[] = [];
  const mine = unique.filter((k) => {
    const ok = own !== null && k.startsWith(own);
    if (!ok) refused.push(k);
    return ok;
  });
  // 索引に載っている自分の鍵と、置いた時刻を引く。
  const indexed = new Map<string, number>();
  if (mine.length) {
    const found = await db.prepare(`select key, uploaded_at from files where key in (${mine.map(() => '?').join(',')})`).bind(...mine).all<{ key: string; uploaded_at: number }>();
    for (const r of found.results) indexed.set(r.key, r.uploaded_at);
  }
  const eligible = mine.filter((k) => {
    const at = indexed.get(k);
    const young = at !== undefined && at >= cutoff;
    if (young) refused.push(k);
    return !young;
  });
  if (eligible.length === 0) {
    const res: BlobsDeleteOut = { deleted: [], refused };
    return c.json(res);
  }
  // 1 日の数えから取り分を取る。
  const day = new Date(now).toISOString().slice(0, 10);
  const metaKey = `${META_BLOB_DELETE}${device.id}`;
  const want = eligible.length;
  const counted = await db.batch([
    db.prepare('select value from meta where key = ?').bind(metaKey),
    db
      .prepare(
        "insert into meta (key, value) values (?, json_object('day', ?, 'n', min(?, ?))) on conflict(key) do update set value = json_object('day', ?, 'n', case when json_extract(meta.value, '$.day') = ? then min(ifnull(json_extract(meta.value, '$.n'), 0) + ?, ?) else min(?, ?) end)",
      )
      .bind(metaKey, day, want, BLOB_DELETE_DAILY, day, day, want, BLOB_DELETE_DAILY, want, BLOB_DELETE_DAILY),
    db.prepare('select value from meta where key = ?').bind(metaKey),
  ]);
  const before = countOf((counted[0]?.results as CountRow[] | undefined)?.[0], day);
  const after = countOf((counted[2]?.results as CountRow[] | undefined)?.[0], day);
  const granted = Math.max(0, Math.min(want, after - before));
  if (granted === 0) return c.json({ error: 'too many deletes', limit: BLOB_DELETE_DAILY }, 429);
  const taken = eligible.slice(0, granted);
  refused.push(...eligible.slice(granted));
  const inIndex = taken.filter((k) => indexed.has(k));
  if (inIndex.length) {
    await c.env.BUCKET.delete(inIndex);
    await db.prepare(`delete from files where key in (${inIndex.map(() => '?').join(',')}) and uploaded_at < ?`).bind(...inIndex, cutoff).run();
  }
  const res: BlobsDeleteOut = { deleted: taken, refused };
  return c.json(res);
});
