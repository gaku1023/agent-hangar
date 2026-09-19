import { Hono } from 'hono';
import {
  MAX_PUSH_BATCH,
  PULL_LIMIT,
  SHARED_TABLES,
  type ChangeIn,
  type ChangeOut,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';

/** 前回の圧縮からこれだけ連番が進んだら、次の push の後で圧縮を試す。 */
export const COMPACT_EVERY = 200;
/** 受信からこれだけ経った変更だけを消す。 */
export const COMPACT_AGE_MS = 14 * 86_400_000;
/** これだけの間に来た端末を「生きている」とみなし、その全員が読み終えた分までしか消さない。 */
export const DEVICE_ACTIVE_MS = 30 * 86_400_000;

/** 圧縮で消し終えた連番の上端。`GET /changes?since=` がこれより古ければ、その端末は取りこぼしている。 */
export const META_CHANGES_FLOOR = 'changes_floor';
/** 最後に圧縮を試したときの最大連番。起動条件をここからの差で測る。 */
export const META_LAST_COMPACT_SEQ = 'last_compact_seq';
/** これまでに振った連番の高水位。圧縮で行が消えても、連番をここより戻さない。 */
export const META_SEQ_HIGH = 'seq_high';

/**
 * 1 行の payload（直列化した後のバイト数）の上限である。
 *
 * D1 は 1 つの TEXT の値を 2,000,000 バイトで打ち切るので、それを超える行は必ず 500 になる。
 * 500 は端末から見ると一時的な失敗なので、同じ batch を永久に送り直して、その端末の push が止まる。
 * 手前で 413 に落として、端末がその行を諦められるようにする。
 *
 * 128 KiB にした根拠は 3 つである。
 * D1 の限界の 2,000,000 バイトから十分に遠いこと。
 * 共有テーブルに載るいちばん長いものはメモの本文（決定 5 で D1 に平文で置く）で、
 * 日本語なら 1 文字 3 バイトなので 4 万字あまり、原稿用紙 100 枚を超えること。
 * 1 回の push は 40 行までなので、要求 1 本を 5 MiB に抑えられること。
 *
 * ここに置いてあるが、本来は `packages/shared/src/cloud.ts` の `MAX_PUSH_BATCH` の隣にある方がよい。
 * 端末が積む前に弾ければ、断られる往復そのものが要らなくなる。
 */
export const MAX_ROW_BYTES = 128 * 1024;

/**
 * 413 の本文に載せる `rowId` の文字数の上限である。
 *
 * `packages/server/src/sync/client.ts` の `CloudError` は応答本文の先頭 200 字しか持たない。
 * 超えると端末の手元で JSON として読めなくなるので、本文は何があっても 200 字に収める。
 * 実物の `rowId` は UUID（36 字）までなので、切り詰めが効くのは壊れた入力のときだけである。
 */
export const MAX_ROW_ID_CHARS = 64;

const ENC = new TextEncoder();
const TABLES = new Set<string>(SHARED_TABLES);
const keyOf = (c: { tableName: string; rowId: string }): string => `${c.tableName}:${c.rowId}`;

function isChange(v: unknown): v is ChangeIn {
  const c = v as Partial<ChangeIn> | null;
  return (
    !!c &&
    typeof c.tableName === 'string' &&
    TABLES.has(c.tableName) &&
    typeof c.rowId === 'string' &&
    c.rowId.length > 0 &&
    (c.op === 'upsert' || c.op === 'delete') &&
    typeof c.payload === 'object' &&
    c.payload !== null &&
    !Array.isArray(c.payload) &&
    typeof c.updatedAt === 'number' &&
    Number.isFinite(c.updatedAt)
  );
}

type ChangeRow = { seq: number; table_name: string; row_id: string; op: 'upsert' | 'delete'; payload: string; updated_at: number; device_id: string };

const toOut = (r: ChangeRow): ChangeOut => ({
  seq: r.seq,
  tableName: r.table_name as ChangeOut['tableName'],
  rowId: r.row_id,
  op: r.op,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  updatedAt: r.updated_at,
  deviceId: r.device_id,
});

/**
 * サーバの連番の高水位である。
 *
 * `max(seq) from changes` だけで測ってはいけない。
 * 圧縮が末尾まで消した後に 0 へ戻り、pull の `nextSeq` と snapshot の `seq` が巻き戻る。
 * 受け取った端末は `lastSeq` を下げ、取り込み済みの変更をもう一度読むか、
 * `GET /rows` から 0 を受けて取り直しの輪から出られなくなる。
 *
 * 行が消えるのは `compact()` のときだけで、そこで必ず高水位を `meta` に刻む。
 * だから残っている最大の連番と `meta` の高水位の大きい方を採れば、どちらの側が欠けても後戻りしない。
 */
const maxSeq = async (db: D1Database): Promise<number> =>
  (await db
    .prepare('select max((select ifnull(max(seq), 0) from changes), ifnull((select cast(value as integer) from meta where key = ?), 0)) s')
    .bind(META_SEQ_HIGH)
    .first<{ s: number }>())!.s;

const clampLimit = (v: string | undefined): number => Math.min(Math.max(Number(v ?? PULL_LIMIT) || PULL_LIMIT, 1), PULL_LIMIT);

async function readMetaInt(db: D1Database, key: string): Promise<number> {
  const r = await db.prepare('select value from meta where key = ?').bind(key).first<{ value: string }>();
  const n = r ? Number(r.value) : 0;
  return Number.isFinite(n) ? n : 0;
}

const putMetaInt = (db: D1Database, key: string, value: number): D1PreparedStatement =>
  db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').bind(key, String(value));

/** 後戻りだけはさせない。floor が下がると、取りこぼしている端末を通してしまう。 */
const raiseMetaInt = (db: D1Database, key: string, value: number): D1PreparedStatement =>
  db
    .prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = max(cast(meta.value as integer), cast(excluded.value as integer))')
    .bind(key, String(value));

/**
 * 受信から 14 日を過ぎ、30 日以内に接続した全端末が読み終えた連番までの changes を消す。
 * rows は残すので、落ちた区間は `GET /rows` から取り直せる。
 *
 * 消した区間の上端を `meta.changes_floor` に書く。
 * これが無いと、離れていた端末が「その後の分だけ」を受け取って、間の変更を黙って永久に落とす。
 * 上端は「実際に消した最大の連番」である。消したものはすべてこれ以下なので、
 * `since >= floor` の端末が落とした変更は 1 件も無い。
 *
 * `last_compact_seq` は、消せなかったときも書く。
 * 書かないと、条件を満たさない間ずっと push のたびに端末の走査が走る。
 */
async function compact(db: D1Database, now: number, seq: number): Promise<void> {
  const active = await db
    .prepare('select min(last_pulled_seq) m from devices where last_seen_at is not null and last_seen_at > ?')
    .bind(now - DEVICE_ACTIVE_MS)
    .first<{ m: number | null }>();
  const upto = active?.m ?? 0;
  const cutoff = now - COMPACT_AGE_MS;
  // 行を消す前に高水位を刻む。ここが `changes` の行を消す唯一の場所なので、ここで刻めば連番は後戻りしない。
  const stmts: D1PreparedStatement[] = [putMetaInt(db, META_LAST_COMPACT_SEQ, seq), raiseMetaInt(db, META_SEQ_HIGH, seq)];
  if (upto > 0) {
    const doomed = await db
      .prepare('select ifnull(max(seq), 0) f from changes where seq <= ? and received_at < ?')
      .bind(upto, cutoff)
      .first<{ f: number }>();
    const floor = doomed?.f ?? 0;
    if (floor > 0) {
      stmts.push(db.prepare('delete from changes where seq <= ? and received_at < ?').bind(upto, cutoff));
      stmts.push(raiseMetaInt(db, META_CHANGES_FLOOR, floor));
    }
  }
  await db.batch(stmts);
}

/**
 * 鏡（`rows`）の 1 行を書く文である。
 *
 * `where excluded.updated_at > rows.updated_at` が要である。
 * いまの値を読むのは `batch` の外なので、同じ行への push が 2 本重なると両方が `accepted` になる。
 * 守りが無いと、後に流れた方が無条件で鏡を上書きし、古い方が残りうる。
 * `changes` には両方が載るので追いかけている端末は困らないが、`GET /rows` で取り直した端末は古い値をつかむ。
 *
 * 同着（`updated_at` が等しい）は書き換えない。
 * 本体の `prev >= updatedAt` は先に着いた方を残すので、その決着と揃えてある。
 *
 * テストが文の順序を入れ替えて確かめられるように輸出している。
 * 本番の文をそのまま使わせるためで、テストの中に SQL を写すと、実装を変えたときに追従しない。
 */
export const mirrorUpsert = (db: D1Database, k: string, c: ChangeIn, deviceId: string, payload: string): D1PreparedStatement =>
  db
    .prepare(
      'insert into rows (k, table_name, row_id, op, payload, updated_at, device_id) values (?, ?, ?, ?, ?, ?, ?) on conflict(k) do update set op = excluded.op, payload = excluded.payload, updated_at = excluded.updated_at, device_id = excluded.device_id where excluded.updated_at > rows.updated_at',
    )
    .bind(k, c.tableName, c.rowId, c.op, payload, c.updatedAt, deviceId);

export const changesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 端末から届いた変更を受ける。行ごとに `updated_at` の新しい方を採り、採った分だけ連番を振る。 */
changesApp.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { changes?: unknown } | null;
  if (!body || !Array.isArray(body.changes) || body.changes.length > MAX_PUSH_BATCH || !body.changes.every(isChange)) return c.json({ error: 'invalid body' }, 400);
  const device = c.get('device');
  const db = c.env.DB;
  const now = Date.now();
  // payload はここで 1 回だけ直列化し、大きさの検査と書き込みで同じ文字列を使う。
  const incoming = (body.changes as ChangeIn[]).map((row) => {
    const payload = JSON.stringify(row.payload);
    return { row, payload, bytes: ENC.encode(payload).byteLength };
  });
  // 大きすぎる行は名指しで断る。端末はその行だけを諦めて、残りを送り直せばよい。
  const oversize = incoming.filter((x) => x.bytes > MAX_ROW_BYTES);
  if (oversize.length) {
    const first = oversize[0]!;
    return c.json(
      {
        error: 'payload too large',
        limit: MAX_ROW_BYTES,
        count: oversize.length,
        // 名指しは先頭の 1 件だけにする。全部並べると本文が 200 字を超え、端末の側で JSON として読めなくなる。
        // 端末は名指しされた 1 件を落として送り直せばよく、次の 1 件があれば次の 413 で名指しされる。
        row: { tableName: first.row.tableName, rowId: first.row.rowId.slice(0, MAX_ROW_ID_CHARS), bytes: first.bytes },
      },
      413,
    );
  }
  // 同じ鍵の重複は updatedAt の大きい方だけを見る。
  const latest = new Map<string, (typeof incoming)[number]>();
  let skipped = 0;
  for (const item of incoming) {
    const k = keyOf(item.row);
    const cur = latest.get(k);
    if (!cur) latest.set(k, item);
    else {
      skipped++;
      if (item.row.updatedAt > cur.row.updatedAt) latest.set(k, item);
    }
  }
  const keys = [...latest.keys()];
  const current = new Map<string, number>();
  if (keys.length) {
    const rows = await db
      .prepare(`select k, updated_at from rows where k in (${keys.map(() => '?').join(',')})`)
      .bind(...keys)
      .all<{ k: string; updated_at: number }>();
    for (const r of rows.results) current.set(r.k, r.updated_at);
  }
  const stmts: D1PreparedStatement[] = [];
  let accepted = 0;
  for (const [k, { row, payload }] of latest) {
    const prev = current.get(k);
    if (prev !== undefined && prev >= row.updatedAt) {
      skipped++;
      continue;
    }
    accepted++;
    stmts.push(
      db
        .prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id, received_at) values (?, ?, ?, ?, ?, ?, ?)')
        .bind(row.tableName, row.rowId, row.op, payload, row.updatedAt, device.id, now),
    );
    stmts.push(mirrorUpsert(db, k, row, device.id, payload));
  }
  stmts.push(db.prepare('update devices set last_seen_at = ? where id = ?').bind(now, device.id));
  await db.batch(stmts);
  const seq = await maxSeq(db);
  // 連番は 1 回の push で最大 40 飛ぶ。倍数に当たるかで測ると圧縮がほとんど走らないので、前回からの差で測る。
  if (accepted > 0 && seq - (await readMetaInt(db, META_LAST_COMPACT_SEQ)) >= COMPACT_EVERY) await compact(db, now, seq);
  const res: PushChangesResponse = { seq, accepted, skipped };
  return c.json(res);
});

/** 自端末以外の変更を連番の昇順で返す。圧縮で消えた区間を指されたら 410 で知らせる。 */
changesApp.get('/', async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const since = Math.max(Number(c.req.query('since') ?? 0) || 0, 0);
  const limit = clampLimit(c.req.query('limit'));
  const floor = await readMetaInt(db, META_CHANGES_FLOOR);
  // 読み位置は進めない。進めると、この端末が落とした区間が二度と分からなくなる。
  if (since < floor) return c.json({ error: 'gone', floor }, 410);
  const rows = await db.prepare('select * from changes where seq > ? and device_id != ? order by seq limit ?').bind(since, device.id, limit + 1).all<ChangeRow>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  // 最後まで返せたときは表全体の末尾まで進める。自端末の変更で止まったままにしないためである。
  // 末尾は高水位そのものにする。`since` との大きい方を採ると、端末が送ってきた値が
  // そのまま `last_pulled_seq` に入り、圧縮がまだ誰も読んでいない変更まで消しにいく。
  const nextSeq = more ? page[page.length - 1]!.seq : await maxSeq(db);
  await db.prepare('update devices set last_seen_at = ?, last_pulled_seq = max(last_pulled_seq, ?) where id = ?').bind(Date.now(), nextSeq, device.id).run();
  const res: PullChangesResponse = { changes: page.map(toOut), nextSeq, more };
  return c.json(res);
});

export const rowsApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** rows の写しを k 順に返す。新しい端末の初回 pull と、410 を受けた端末の取り直しが使う。自端末の行も含める。 */
rowsApp.get('/', async (c) => {
  const db = c.env.DB;
  const after = c.req.query('after') ?? '';
  const limit = clampLimit(c.req.query('limit'));
  const rows = await db
    .prepare('select 0 seq, table_name, row_id, op, payload, updated_at, device_id, k from rows where k > ? order by k limit ?')
    .bind(after, limit + 1)
    .all<ChangeRow & { k: string }>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const res: SnapshotResponse = { changes: page.map(toOut), nextAfter: more ? page[page.length - 1]!.k : null, seq: await maxSeq(db) };
  return c.json(res);
});
