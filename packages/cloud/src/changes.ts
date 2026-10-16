import { Hono } from 'hono';
import {
  MAX_PUSH_BATCH,
  PULL_LIMIT,
  SHARED_TABLES,
  type ChangeIn,
  type ChangeOut,
  type CloudPeer,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';
import { seenOf, touchIfDue } from './seen.ts';

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
 * 表の連番の高水位である。
 *
 * rows の連番は autoincrement で、行を書き換えるときは消してから入れ直すので、最大の連番の行は消えずに残る（消すのは同じ batch で、より大きい連番で入れ直す直前だけである）。
 * だから `max(seq)` は後戻りしない。主キーの最大なので、読むのは 1 行である。
 */
const maxSeqStmt = (db: D1Database): D1PreparedStatement => db.prepare('select ifnull(max(seq), 0) s from rows');

const clampLimit = (v: string | undefined): number => Math.min(Math.max(Number(v ?? PULL_LIMIT) || PULL_LIMIT, 1), PULL_LIMIT);

const firstNum = (r: D1Result<{ s: number }> | undefined): number => Number(r?.results?.[0]?.s ?? 0);

/**
 * 行を書く 2 文である（同期の版 6）。
 *
 * 1 文目は、届いた版より古い行だけを消す。2 文目は、鍵が空いていれば入れる。
 * 古い行を消したときだけ鍵が空くので、入るのは届いた版の方が新しいか、まだ行が無いときに限られる。
 * 同着（`updated_at` が等しい）は消さないので書き換えない。端末の取り込みの `prev >= updatedAt` も先に着いた方を残すので、その決着とそろえてある。
 *
 * 書き換えた行は、表の末尾の新しい連番で入り直す。連番は SQLite が書き込みのロックの中で振るので、commit の順と連番の順がそろい、
 * `GET /changes?since=` で頁を送っている途中に書き換えられた行も、後ろの頁で必ず降りてくる。JS で連番を計算しない。
 * 2 文目が実際に入れたかどうか（`meta.changes`）で、採った数を数える。
 *
 * 2 文目の `where not exists` は連番の欠番を防ぐためにある。
 * `on conflict do nothing` だけだと、入れなかった行にも SQLite が連番を 1 つ使い、捨てた行の数だけ連番が飛ぶ（miniflare で確かめた）。
 * `on conflict` は守りとして残す。
 */
const writeRow = (db: D1Database, k: string, c: ChangeIn, deviceId: string, payload: string): [D1PreparedStatement, D1PreparedStatement] => [
  db.prepare('delete from rows where k = ? and updated_at < ?').bind(k, c.updatedAt),
  db
    .prepare(
      'insert into rows (k, table_name, row_id, op, payload, updated_at, device_id) select ?, ?, ?, ?, ?, ?, ? where not exists (select 1 from rows where k = ?) on conflict(k) do nothing',
    )
    .bind(k, c.tableName, c.rowId, c.op, payload, c.updatedAt, deviceId, k),
];

export const changesApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 端末から届いた変更を受ける。行ごとに `updated_at` の新しい方を採り、採った行には表の末尾の連番が付く。 */
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
  const stmts: D1PreparedStatement[] = [];
  // 行ごとの insert の位置。meta.changes を読んで採った数を数える。
  const inserts: number[] = [];
  for (const [k, { row, payload }] of latest) {
    const [del, ins] = writeRow(db, k, row, device.id, payload);
    stmts.push(del);
    inserts.push(stmts.push(ins) - 1);
  }
  const touch = touchIfDue(db, device, now, seenOf(c));
  if (touch) stmts.push(touch);
  // 高水位は同じ batch（1 つの取引）の中で読む。別の要求に割り込まれた値を返さない。
  const maxAt = stmts.push(maxSeqStmt(db)) - 1;
  const results = await db.batch(stmts);
  const accepted = inserts.filter((i) => Number(results[i]?.meta?.changes ?? 0) > 0).length;
  skipped += latest.size - accepted;
  const res: PushChangesResponse = { seq: firstNum(results[maxAt] as D1Result<{ s: number }> | undefined), accepted, skipped };
  return c.json(res);
});

type PeerRow = { id: string; last_seen_at: number | null };

/**
 * 自端末以外の行を連番の昇順で返す。
 * 解除していない PC の最終確認（peers）と、Worker の時刻（now）を添える。端末は「now − lastSeenAt」を PC の年齢として、他の PC の生存を見る。
 * 変更ログを持たないので、どれだけ古い since でも断らない（版 5 までの 410 は無くなった）。
 */
changesApp.get('/', async (c) => {
  const device = c.get('device');
  const db = c.env.DB;
  const since = Math.max(Number(c.req.query('since') ?? 0) || 0, 0);
  const limit = clampLimit(c.req.query('limit'));
  const now = Date.now();
  const touch = touchIfDue(db, device, now, seenOf(c));
  // 頁と高水位と生存を 1 つの batch（1 つの取引）で読む。
  // 別々に読むと、間に入った push の行を高水位だけが越えて、この端末がその行を読み飛ばす。
  const stmts: D1PreparedStatement[] = [
    ...(touch ? [touch] : []),
    db.prepare('select seq, table_name, row_id, op, payload, updated_at, device_id from rows where seq > ? and device_id != ? order by seq limit ?').bind(since, device.id, limit + 1),
    maxSeqStmt(db),
    // スマホ（kind = 'mobile'）は会話を動かさないので、PC の生存に混ぜない。
    db.prepare("select id, last_seen_at from devices where revoked_at is null and kind = 'pc' order by id"),
  ];
  const results = await db.batch(stmts);
  const off = touch ? 1 : 0;
  const rows = ((results[off]?.results ?? []) as ChangeRow[]);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  // 最後まで返せたときは表全体の末尾まで進める。自端末の行で止まったままにしないためである。
  const nextSeq = more ? page[page.length - 1]!.seq : firstNum(results[off + 1] as D1Result<{ s: number }> | undefined);
  const peers: CloudPeer[] = ((results[off + 2]?.results ?? []) as PeerRow[]).map((p) => ({ id: p.id, lastSeenAt: p.last_seen_at ?? null }));
  const res: PullChangesResponse = { changes: page.map(toOut), nextSeq, more, peers, now };
  return c.json(res);
});

export const rowsApp = new Hono<{ Bindings: Env; Variables: Vars }>();

/** rows の写しを k 順に返す。新しい端末の初回の取り込みが使う。自端末の行も含める。 */
rowsApp.get('/', async (c) => {
  const db = c.env.DB;
  const after = c.req.query('after') ?? '';
  const limit = clampLimit(c.req.query('limit'));
  const results = await db.batch([
    db.prepare('select 0 seq, table_name, row_id, op, payload, updated_at, device_id, k from rows where k > ? order by k limit ?').bind(after, limit + 1),
    maxSeqStmt(db),
  ]);
  const rows = (results[0]?.results ?? []) as (ChangeRow & { k: string })[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const res: SnapshotResponse = { changes: page.map(toOut), nextAfter: more ? page[page.length - 1]!.k : null, seq: firstNum(results[1] as D1Result<{ s: number }> | undefined) };
  return c.json(res);
});
